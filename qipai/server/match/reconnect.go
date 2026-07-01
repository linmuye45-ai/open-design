// =============================================================================
//  锦鲤棋牌 AAA · 断线重连与会话管理 (reconnect.go)
// -----------------------------------------------------------------------------
//  实现「心跳保活 + 内存状态保存 + 断线重连」：
//   - 玩家进入房间后注册 Session，保存其在房间内的座位、玩法、最后活跃时间、
//     以及一份可序列化的「对局快照」(GameSnapshot)。
//   - 心跳：客户端定期发送 Heartbeat()，刷新 LastSeen；后台清扫协程标记超时
//     掉线（Disconnected），但【不立即销毁会话】，保留 ReconnectGrace 时长。
//   - 重连：客户端带 UID + RoomToken 调用 Reconnect()，命中未过期会话则恢复，
//     返回最新对局快照让客户端续上牌局。
//
//  线程安全：使用分片读写锁（sharded RWMutex）降低高并发锁竞争。
// =============================================================================

package match

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"hash/fnv"
	"sync"
	"time"
)

// ConnState 连接状态
type ConnState int32

const (
	ConnOnline ConnState = iota
	ConnDisconnected
	ConnExpired
)

func (s ConnState) String() string {
	switch s {
	case ConnOnline:
		return "online"
	case ConnDisconnected:
		return "disconnected"
	default:
		return "expired"
	}
}

// GameSnapshot 对局快照（断线时保存，重连时下发）。
// 这里用通用字节承载序列化后的对局状态（Protobuf/JSON 由 game 层填充）。
type GameSnapshot struct {
	Version  uint64 // 状态版本号，单调递增；客户端用它判断是否需要全量同步
	Data     []byte // 序列化的对局状态
	UpdateAt time.Time
}

// Session 玩家会话
type Session struct {
	UID        string
	RoomID     string
	Mode       GameMode
	Seat       int
	Token      string // 重连令牌，防止他人冒用
	State      ConnState
	LastSeen   time.Time
	DisconnAt  time.Time
	Snapshot   *GameSnapshot

	mu sync.RWMutex
}

// touch 刷新活跃时间（内部，持锁）
func (s *Session) touch() {
	s.mu.Lock()
	s.LastSeen = time.Now()
	if s.State == ConnDisconnected {
		s.State = ConnOnline
	}
	s.mu.Unlock()
}

// SetSnapshot 更新对局快照（由 game 层在每次状态变更后调用）
func (s *Session) SetSnapshot(version uint64, data []byte) {
	s.mu.Lock()
	s.Snapshot = &GameSnapshot{Version: version, Data: data, UpdateAt: time.Now()}
	s.mu.Unlock()
}

// GetSnapshot 读取快照（重连时用）
func (s *Session) GetSnapshot() *GameSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Snapshot
}

func (s *Session) getState() ConnState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.State
}

// ----------------------------- 会话注册中心 -----------------------------

const shardCount = 64

type shard struct {
	mu       sync.RWMutex
	sessions map[string]*Session // key: UID
}

// SessionRegistry 分片会话注册中心
type SessionRegistry struct {
	shards         [shardCount]*shard
	heartbeatTTL   time.Duration // 超过此时长未心跳 → 标记掉线
	reconnectGrace time.Duration // 掉线后保留会话的宽限时长
	stopCh         chan struct{}
	wg             sync.WaitGroup
}

// NewSessionRegistry 创建并启动清扫协程
func NewSessionRegistry(heartbeatTTL, reconnectGrace time.Duration) *SessionRegistry {
	r := &SessionRegistry{
		heartbeatTTL:   heartbeatTTL,
		reconnectGrace: reconnectGrace,
		stopCh:         make(chan struct{}),
	}
	for i := 0; i < shardCount; i++ {
		r.shards[i] = &shard{sessions: make(map[string]*Session)}
	}
	r.wg.Add(1)
	go r.sweepLoop()
	return r
}

func (r *SessionRegistry) shardFor(uid string) *shard {
	h := fnv.New32a()
	_, _ = h.Write([]byte(uid))
	return r.shards[h.Sum32()%shardCount]
}

// Register 玩家入房时注册会话，返回重连令牌
func (r *SessionRegistry) Register(uid, roomID string, mode GameMode, seat int) (*Session, error) {
	token, err := genToken()
	if err != nil {
		return nil, err
	}
	sess := &Session{
		UID: uid, RoomID: roomID, Mode: mode, Seat: seat,
		Token: token, State: ConnOnline, LastSeen: time.Now(),
	}
	sh := r.shardFor(uid)
	sh.mu.Lock()
	sh.sessions[uid] = sess
	sh.mu.Unlock()
	return sess, nil
}

// Heartbeat 客户端心跳；未知 UID 返回错误（需重新登录匹配）
func (r *SessionRegistry) Heartbeat(uid string) error {
	sh := r.shardFor(uid)
	sh.mu.RLock()
	sess := sh.sessions[uid]
	sh.mu.RUnlock()
	if sess == nil {
		return fmt.Errorf("session not found: %s", uid)
	}
	if sess.getState() == ConnExpired {
		return fmt.Errorf("session expired: %s", uid)
	}
	sess.touch()
	return nil
}

// Reconnect 断线重连：校验令牌，命中且未过期则恢复在线并返回快照。
func (r *SessionRegistry) Reconnect(uid, token string) (*Session, *GameSnapshot, error) {
	sh := r.shardFor(uid)
	sh.mu.RLock()
	sess := sh.sessions[uid]
	sh.mu.RUnlock()
	if sess == nil {
		return nil, nil, fmt.Errorf("no session for %s (expired or never joined)", uid)
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.Token != token {
		return nil, nil, fmt.Errorf("invalid reconnect token for %s", uid)
	}
	if sess.State == ConnExpired {
		return nil, nil, fmt.Errorf("session already expired for %s", uid)
	}
	sess.State = ConnOnline
	sess.LastSeen = time.Now()
	return sess, sess.Snapshot, nil
}

// Get 读取会话
func (r *SessionRegistry) Get(uid string) (*Session, bool) {
	sh := r.shardFor(uid)
	sh.mu.RLock()
	defer sh.mu.RUnlock()
	s, ok := sh.sessions[uid]
	return s, ok
}

// Remove 主动移除（正常离开房间）
func (r *SessionRegistry) Remove(uid string) {
	sh := r.shardFor(uid)
	sh.mu.Lock()
	delete(sh.sessions, uid)
	sh.mu.Unlock()
}

// Count 当前会话总数（监控用）
func (r *SessionRegistry) Count() int {
	total := 0
	for _, sh := range r.shards {
		sh.mu.RLock()
		total += len(sh.sessions)
		sh.mu.RUnlock()
	}
	return total
}

// Stop 关闭清扫协程
func (r *SessionRegistry) Stop() {
	close(r.stopCh)
	r.wg.Wait()
}

// sweepLoop 周期清扫：标记掉线 / 回收过期会话
func (r *SessionRegistry) sweepLoop() {
	defer r.wg.Done()
	// 清扫间隔自适应：取 heartbeatTTL/4 与 1s 的较小者，保证及时标记掉线，
	// 同时设下限 50ms 避免空转。
	interval := r.heartbeatTTL / 4
	if interval > time.Second {
		interval = time.Second
	}
	if interval < 50*time.Millisecond {
		interval = 50 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-r.stopCh:
			return
		case <-ticker.C:
			r.sweep()
		}
	}
}

func (r *SessionRegistry) sweep() {
	now := time.Now()
	for _, sh := range r.shards {
		sh.mu.Lock()
		for uid, sess := range sh.sessions {
			sess.mu.Lock()
			switch sess.State {
			case ConnOnline:
				if now.Sub(sess.LastSeen) > r.heartbeatTTL {
					sess.State = ConnDisconnected
					sess.DisconnAt = now
				}
			case ConnDisconnected:
				if now.Sub(sess.DisconnAt) > r.reconnectGrace {
					sess.State = ConnExpired
				}
			}
			expired := sess.State == ConnExpired
			sess.mu.Unlock()
			if expired {
				delete(sh.sessions, uid)
			}
		}
		sh.mu.Unlock()
	}
}

// genToken 生成 16 字节随机重连令牌
func genToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
