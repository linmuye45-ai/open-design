// =============================================================================
//  锦鲤棋牌 AAA · 匹配引擎共享类型 (types.go)
// =============================================================================

package match

import "time"

// GameMode 棋牌玩法类型
type GameMode int

const (
	ModeDoudizhu GameMode = iota // 斗地主（3 人）
	ModeGuandan                  // 掼蛋（4 人 2 队）
	ModeMahjong                  // 麻将（4 人）
)

// SeatCount 返回该玩法所需座位数
func (m GameMode) SeatCount() int {
	switch m {
	case ModeDoudizhu:
		return 3
	case ModeGuandan, ModeMahjong:
		return 4
	default:
		return 3
	}
}

// String 便于日志
func (m GameMode) String() string {
	switch m {
	case ModeDoudizhu:
		return "doudizhu"
	case ModeGuandan:
		return "guandan"
	case ModeMahjong:
		return "mahjong"
	default:
		return "unknown"
	}
}

// AgeBand 年龄段偏好（针对 30-65 中老年人群分层匹配，让相近年龄同桌更和谐）
type AgeBand int

const (
	AgeUnknown AgeBand = iota
	Age30to45
	Age45to55
	Age55to65
)

// Player 匹配队列中的玩家请求
type Player struct {
	UID      string
	MMR      int      // 隐藏匹配分
	Age      int      // 真实年龄
	AgeBand  AgeBand  // 由 Age 计算
	Mode     GameMode // 期望玩法
	JoinedAt time.Time

	// 通信：匹配成功后通过该 channel 推送结果（带缓冲，避免阻塞匹配协程）
	ResultCh chan *MatchResult
}

// MatchResult 匹配结果（推送给每位玩家）
type MatchResult struct {
	RoomID   string
	Mode     GameMode
	Seat     int       // 分配到的座位
	Members  []string  // 同桌全部玩家 UID（按座位序）
	AvgMMR   int       // 本桌平均 MMR
	MatchedAt time.Time
}

// ComputeAgeBand 由年龄推导年龄段
func ComputeAgeBand(age int) AgeBand {
	switch {
	case age >= 30 && age < 45:
		return Age30to45
	case age >= 45 && age < 55:
		return Age45to55
	case age >= 55 && age <= 65:
		return Age55to65
	default:
		return AgeUnknown
	}
}
