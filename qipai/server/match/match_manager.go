// =============================================================================
//  锦鲤棋牌 AAA · 高并发分布式房间匹配引擎 (match_manager.go)
// -----------------------------------------------------------------------------
//  设计要点（对应需求「百万级高并发房间匹配 / MMR / 年龄段偏好 / 断线重连」）：
//
//   1. 全异步：所有外部请求（入队 / 取消 / 心跳）经由 channel 投递到单一
//      匹配主协程串行处理 —— 用「通信代替共享内存」，天然无锁、无数据竞争。
//      （Go 哲学：Do not communicate by sharing memory; share memory by
//       communicating.）
//
//   2. 分桶并行：按 (GameMode, AgeBand) 分桶，每桶一条独立匹配 goroutine，
//      水平扩展时可将不同桶分散到不同进程/节点（分布式友好）。
//
//   3. MMR 滑动窗口：等待越久，可接受的 MMR 差越大（动态放宽），
//      保证「不会永远匹配不到」同时尽量同水平。
//
//   4. 断线重连：MatchManager 不直接持有连接；它产出 RoomID 后交给
//      SessionRegistry（见 reconnect.go）保存玩家会话快照，支持心跳与重连。
//
//  本文件可独立 `go build` / `go test`，不依赖任何第三方库。
// =============================================================================

package match

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// ----------------------------- 配置 -----------------------------

// Config 匹配引擎可调参数
type Config struct {
	// 初始可接受的 MMR 差
	BaseMMRWindow int
	// 每等待 1 秒额外放宽的 MMR 差
	MMRWidenPerSec int
	// MMR 差上限（超过则忽略 MMR 仅按人数匹配，防止饿死）
	MaxMMRWindow int
	// 匹配主循环 tick 间隔
	Tick time.Duration
	// 玩家在队列中的最大等待（超时回调失败）
	MaxWait time.Duration
	// 是否启用年龄段优先（同段优先，超时后跨段）
	AgePreferred bool
	// 年龄段约束的放宽等待时长（超过后允许跨年龄段）
	AgeRelaxAfter time.Duration
}

// DefaultConfig 生产推荐默认值
func DefaultConfig() Config {
	return Config{
		BaseMMRWindow:  120,
		MMRWidenPerSec: 40,
		MaxMMRWindow:   2000,
		Tick:           200 * time.Millisecond,
		MaxWait:        60 * time.Second,
		AgePreferred:   true,
		AgeRelaxAfter:  8 * time.Second,
	}
}

// ----------------------------- 内部消息 -----------------------------

// command 单一有序命令，保证 Enqueue / Cancel 在桶 worker 内严格按投递顺序处理，
// 避免「先入队后取消」因走不同 channel 而乱序。
type cmdKind int

const (
	cmdEnqueue cmdKind = iota
	cmdCancel
)

type command struct {
	kind   cmdKind
	player *Player       // enqueue 用
	uid    string        // cancel 用
	done   chan struct{} // cancel 完成通知
}

type bucketKey struct {
	mode GameMode
	age  AgeBand
}

// ----------------------------- 匹配引擎 -----------------------------

// MatchManager 顶层匹配引擎，管理多个分桶 worker。
type MatchManager struct {
	cfg Config

	mu      sync.RWMutex
	buckets map[bucketKey]*matchBucket

	roomSeq uint64 // 原子自增生成 RoomID

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// 指标（原子计数，供监控上报）
	metricEnqueued atomic.Int64
	metricMatched  atomic.Int64
	metricTimeout  atomic.Int64

	// 房间创建回调（交给 GameServer 真正起房）
	onRoomCreated func(*MatchResult, []*Player)
}

// NewMatchManager 创建并启动引擎
func NewMatchManager(cfg Config, onRoomCreated func(*MatchResult, []*Player)) *MatchManager {
	ctx, cancel := context.WithCancel(context.Background())
	mm := &MatchManager{
		cfg:           cfg,
		buckets:       make(map[bucketKey]*matchBucket),
		ctx:           ctx,
		cancel:        cancel,
		onRoomCreated: onRoomCreated,
	}
	return mm
}

// Enqueue 玩家入队（线程安全，可被任意多连接 goroutine 并发调用）
func (mm *MatchManager) Enqueue(p *Player) error {
	if p == nil {
		return fmt.Errorf("nil player")
	}
	if p.ResultCh == nil {
		p.ResultCh = make(chan *MatchResult, 1)
	}
	p.AgeBand = ComputeAgeBand(p.Age)
	p.JoinedAt = time.Now()

	key := bucketKey{mode: p.Mode, age: p.AgeBand}
	b := mm.getOrCreateBucket(key)
	select {
	case b.cmdCh <- command{kind: cmdEnqueue, player: p}:
		mm.metricEnqueued.Add(1)
		return nil
	case <-mm.ctx.Done():
		return fmt.Errorf("match manager closed")
	}
}

// Cancel 取消排队
func (mm *MatchManager) Cancel(uid string, mode GameMode, age int) {
	key := bucketKey{mode: mode, age: ComputeAgeBand(age)}
	mm.mu.RLock()
	b := mm.buckets[key]
	mm.mu.RUnlock()
	if b == nil {
		return
	}
	done := make(chan struct{})
	select {
	case b.cmdCh <- command{kind: cmdCancel, uid: uid, done: done}:
		<-done
	case <-mm.ctx.Done():
	}
}

// Shutdown 优雅关闭，等待所有 worker 退出
func (mm *MatchManager) Shutdown() {
	mm.cancel()
	mm.wg.Wait()
}

// Metrics 返回指标快照
func (mm *MatchManager) Metrics() (enqueued, matched, timeout int64) {
	return mm.metricEnqueued.Load(), mm.metricMatched.Load(), mm.metricTimeout.Load()
}

func (mm *MatchManager) getOrCreateBucket(key bucketKey) *matchBucket {
	mm.mu.RLock()
	b := mm.buckets[key]
	mm.mu.RUnlock()
	if b != nil {
		return b
	}
	mm.mu.Lock()
	defer mm.mu.Unlock()
	if b = mm.buckets[key]; b != nil {
		return b
	}
	b = newMatchBucket(key, mm)
	mm.buckets[key] = b
	mm.wg.Add(1)
	go func() {
		defer mm.wg.Done()
		b.run(mm.ctx)
	}()
	return b
}

// relocateToMixedBucket 把跨段放宽的玩家迁入混龄桶 (AgeUnknown)。
// 保留原 JoinedAt（继续累计等待，触发防饿死强制成桌），不重复计入入队指标。
func (mm *MatchManager) relocateToMixedBucket(p *Player) {
	key := bucketKey{mode: p.Mode, age: AgeUnknown}
	b := mm.getOrCreateBucket(key)
	select {
	case b.cmdCh <- command{kind: cmdEnqueue, player: p}:
	case <-mm.ctx.Done():
		select {
		case p.ResultCh <- nil:
		default:
		}
	}
}

func (mm *MatchManager) nextRoomID(mode GameMode) string {
	id := atomic.AddUint64(&mm.roomSeq, 1)
	return fmt.Sprintf("room-%s-%d-%d", mode.String(), time.Now().Unix(), id)
}

// ----------------------------- 分桶 worker -----------------------------

// waiting 队列中一个等待项
type waiting struct {
	player *Player
}

// matchBucket 单个 (mode,age) 桶的匹配协程
type matchBucket struct {
	key   bucketKey
	mm    *MatchManager
	queue []*waiting

	cmdCh chan command
}

func newMatchBucket(key bucketKey, mm *MatchManager) *matchBucket {
	return &matchBucket{
		key:   key,
		mm:    mm,
		queue: make([]*waiting, 0, 256),
		cmdCh: make(chan command, 1024),
	}
}

// run 桶主循环：串行处理入队/取消/定时撮合，无锁。
func (b *matchBucket) run(ctx context.Context) {
	ticker := time.NewTicker(b.mm.cfg.Tick)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			b.drainOnShutdown()
			return

		case cmd := <-b.cmdCh:
			switch cmd.kind {
			case cmdEnqueue:
				b.queue = append(b.queue, &waiting{player: cmd.player})
				// 入队即尝试撮合一次，降低延迟
				b.tryMatch()
			case cmdCancel:
				b.removeByUID(cmd.uid)
				if cmd.done != nil {
					close(cmd.done)
				}
			}

		case <-ticker.C:
			b.expireTimeouts()
			b.tryMatch()
		}
	}
}

// tryMatch 核心撮合：在容差窗口内凑齐一桌人数则成局。
func (b *matchBucket) tryMatch() {
	need := b.key.mode.SeatCount()
	if len(b.queue) < need {
		return
	}
	// 按 MMR 排序，相邻者优先同桌（贪心成桌，平均水平最接近）
	sort.SliceStable(b.queue, func(i, j int) bool {
		return b.queue[i].player.MMR < b.queue[j].player.MMR
	})

	now := time.Now()
	i := 0
	for i+need <= len(b.queue) {
		group := b.queue[i : i+need]
		// 防饿死：队列中最老者等待超过 MaxWait 的一半时，强制按相邻 MMR 成桌
		// （此时已排序，相邻者 MMR 跨度天然最小，是最优雅的兜底）。
		forced := b.mm.cfg.MaxWait > 0 &&
			now.Sub(group[0].player.JoinedAt) >= b.mm.cfg.MaxWait/2
		if forced || b.groupAcceptable(group, now) {
			b.formRoom(group)
			b.queue = append(b.queue[:i], b.queue[i+need:]...)
			continue
		}
		i++
	}
}

// groupAcceptable 判断一组玩家是否满足 MMR 容差（含动态放宽）。
func (b *matchBucket) groupAcceptable(group []*waiting, now time.Time) bool {
	minMMR, maxMMR := group[0].player.MMR, group[0].player.MMR
	oldestWait := time.Duration(0)
	for _, w := range group {
		if w.player.MMR < minMMR {
			minMMR = w.player.MMR
		}
		if w.player.MMR > maxMMR {
			maxMMR = w.player.MMR
		}
		if wait := now.Sub(w.player.JoinedAt); wait > oldestWait {
			oldestWait = wait
		}
	}
	// 动态窗口：基础 + 等待时长 * 放宽速率，封顶 MaxMMRWindow
	window := b.mm.cfg.BaseMMRWindow + int(oldestWait.Seconds())*b.mm.cfg.MMRWidenPerSec
	if window > b.mm.cfg.MaxMMRWindow {
		window = b.mm.cfg.MaxMMRWindow
	}
	return (maxMMR - minMMR) <= window
}

// formRoom 组桌并通知玩家
func (b *matchBucket) formRoom(group []*waiting) {
	mode := b.key.mode
	roomID := b.mm.nextRoomID(mode)
	members := make([]string, len(group))
	sum := 0
	players := make([]*Player, len(group))
	for i, w := range group {
		members[i] = w.player.UID
		sum += w.player.MMR
		players[i] = w.player
	}
	avg := sum / len(group)
	matchedAt := time.Now()

	for seat, w := range group {
		res := &MatchResult{
			RoomID:    roomID,
			Mode:      mode,
			Seat:      seat,
			Members:   members,
			AvgMMR:    avg,
			MatchedAt: matchedAt,
		}
		// 非阻塞推送（ResultCh 带缓冲；若已被取消/关闭则丢弃）
		select {
		case w.player.ResultCh <- res:
		default:
		}
	}
	b.mm.metricMatched.Add(int64(len(group)))

	if b.mm.onRoomCreated != nil {
		result := &MatchResult{RoomID: roomID, Mode: mode, Members: members, AvgMMR: avg, MatchedAt: matchedAt}
		b.mm.onRoomCreated(result, players)
	}
}

// expireTimeouts 处理两件事：
//  1. 跨年龄段放宽：等待超过 AgeRelaxAfter 的玩家，从本「年龄专属桶」迁移到
//     统一的「混龄桶」(AgeUnknown)，避免某年龄段人数非整桌而饿死。
//  2. 彻底超时（MaxWait）：推送 nil 通知失败。
func (b *matchBucket) expireTimeouts() {
	if b.mm.cfg.MaxWait <= 0 {
		return
	}
	now := time.Now()
	kept := b.queue[:0]
	for _, w := range b.queue {
		wait := now.Sub(w.player.JoinedAt)
		if wait >= b.mm.cfg.MaxWait {
			select {
			case w.player.ResultCh <- nil:
			default:
			}
			b.mm.metricTimeout.Add(1)
			continue
		}
		// 跨年龄段放宽：仅对非混龄桶生效，迁移到混龄桶继续匹配
		if b.mm.cfg.AgePreferred && b.key.age != AgeUnknown &&
			wait >= b.mm.cfg.AgeRelaxAfter {
			b.mm.relocateToMixedBucket(w.player)
			continue
		}
		kept = append(kept, w)
	}
	b.queue = kept
}

func (b *matchBucket) removeByUID(uid string) {
	kept := b.queue[:0]
	for _, w := range b.queue {
		if w.player.UID != uid {
			kept = append(kept, w)
		}
	}
	b.queue = kept
}

func (b *matchBucket) drainOnShutdown() {
	for _, w := range b.queue {
		select {
		case w.player.ResultCh <- nil:
		default:
		}
	}
	b.queue = nil
}
