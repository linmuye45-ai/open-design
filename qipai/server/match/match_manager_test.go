package match

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 测试：并发入队 999 名斗地主玩家，应全部 3 人一桌成功匹配，无丢失、无重复座位。
func TestConcurrentMatchDoudizhu(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Tick = 30 * time.Millisecond
	cfg.AgeRelaxAfter = 300 * time.Millisecond // 同龄段凑不齐时快速跨段
	cfg.MaxWait = 8 * time.Second
	mm := NewMatchManager(cfg, nil)
	defer mm.Shutdown()

	const total = 999 // 3 的倍数
	var matched int64
	var wg sync.WaitGroup

	roomMembers := sync.Map{} // roomID -> *[]int seats

	for i := 0; i < total; i++ {
		wg.Add(1)
		p := &Player{
			UID:      fmt.Sprintf("u%d", i),
			MMR:      1000 + i%500,
			Age:      30 + i%35,
			Mode:     ModeDoudizhu,
			ResultCh: make(chan *MatchResult, 1),
		}
		if err := mm.Enqueue(p); err != nil {
			t.Fatalf("enqueue failed: %v", err)
		}
		go func(pl *Player) {
			defer wg.Done()
			select {
			case res := <-pl.ResultCh:
				if res == nil {
					t.Errorf("player %s match timeout", pl.UID)
					return
				}
				if len(res.Members) != 3 {
					t.Errorf("expected 3 members, got %d", len(res.Members))
				}
				atomic.AddInt64(&matched, 1)
				v, _ := roomMembers.LoadOrStore(res.RoomID, &sync.Map{})
				seats := v.(*sync.Map)
				if _, dup := seats.LoadOrStore(res.Seat, pl.UID); dup {
					t.Errorf("duplicate seat %d in room %s", res.Seat, res.RoomID)
				}
			case <-time.After(10 * time.Second):
				t.Errorf("player %s no result", pl.UID)
			}
		}(p)
	}

	wg.Wait()
	if matched != total {
		t.Fatalf("expected %d matched, got %d", total, matched)
	}
	enq, mt, _ := mm.Metrics()
	t.Logf("enqueued=%d matched=%d rooms formed=%d", enq, mt, total/3)
}

// 测试：MMR 差过大时动态窗口逐步放宽，最终也能匹配。
func TestMMRWidening(t *testing.T) {
	cfg := DefaultConfig()
	cfg.BaseMMRWindow = 50
	cfg.MMRWidenPerSec = 1000
	cfg.Tick = 50 * time.Millisecond
	mm := NewMatchManager(cfg, nil)
	defer mm.Shutdown()

	mmrs := []int{1000, 1800, 2600} // 初始差超过 BaseMMRWindow
	players := make([]*Player, 3)
	for i, m := range mmrs {
		players[i] = &Player{UID: fmt.Sprintf("w%d", i), MMR: m, Age: 40, Mode: ModeDoudizhu, ResultCh: make(chan *MatchResult, 1)}
		_ = mm.Enqueue(players[i])
	}
	for _, p := range players {
		select {
		case res := <-p.ResultCh:
			if res == nil {
				t.Fatalf("player %s timed out despite widening", p.UID)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("player %s no result", p.UID)
		}
	}
}

// 测试：断线重连—心跳超时标记掉线，宽限期内可重连并取回快照。
func TestReconnect(t *testing.T) {
	reg := NewSessionRegistry(200*time.Millisecond, 2*time.Second)
	defer reg.Stop()

	sess, err := reg.Register("uA", "room-1", ModeDoudizhu, 0)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	sess.SetSnapshot(7, []byte("game-state-v7"))

	// 不发心跳，等待超过 heartbeatTTL → 应被标记掉线
	time.Sleep(500 * time.Millisecond)
	got, _ := reg.Get("uA")
	if got.getState() != ConnDisconnected {
		t.Fatalf("expected disconnected, got %s", got.getState())
	}

	// 宽限期内重连
	s2, snap, err := reg.Reconnect("uA", sess.Token)
	if err != nil {
		t.Fatalf("reconnect failed: %v", err)
	}
	if s2.getState() != ConnOnline {
		t.Fatalf("expected online after reconnect")
	}
	if snap == nil || snap.Version != 7 || string(snap.Data) != "game-state-v7" {
		t.Fatalf("snapshot not restored correctly: %+v", snap)
	}

	// 错误令牌应失败
	if _, _, err := reg.Reconnect("uA", "wrong-token"); err == nil {
		t.Fatalf("expected token mismatch error")
	}
}

// 测试：取消排队后不再被匹配。
func TestCancel(t *testing.T) {
	mm := NewMatchManager(DefaultConfig(), nil)
	defer mm.Shutdown()

	p := &Player{UID: "cancelme", MMR: 1000, Age: 50, Mode: ModeDoudizhu, ResultCh: make(chan *MatchResult, 1)}
	_ = mm.Enqueue(p)
	mm.Cancel("cancelme", ModeDoudizhu, 50)

	// 再加两个人，不应凑成（因为第一个已取消）
	for i := 0; i < 2; i++ {
		q := &Player{UID: fmt.Sprintf("x%d", i), MMR: 1000, Age: 50, Mode: ModeDoudizhu, ResultCh: make(chan *MatchResult, 1)}
		_ = mm.Enqueue(q)
	}
	select {
	case <-p.ResultCh:
		t.Fatalf("cancelled player should not be matched")
	case <-time.After(800 * time.Millisecond):
		// 正确：未匹配
	}
}
