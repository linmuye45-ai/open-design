/**
 * =============================================================================
 *  锦鲤牌阵 · 数值配置 (balance.ts)
 * -----------------------------------------------------------------------------
 *  集中所有可调数值：牌型评分、关卡目标分、出牌/弃牌次数、商店价格、Boss 规则。
 *  数值为策划设定的初版，便于后续平衡调整。
 * =============================================================================
 */
import { HandType, HandScore } from "./rules";

/** 牌型评分表（底分 chips × 倍率 mult） */
export const HAND_SCORES: Record<HandType, HandScore> = {
  [HandType.HighCard]: { chips: 5, mult: 1 },
  [HandType.Pair]: { chips: 12, mult: 2 },
  [HandType.TwoPair]: { chips: 22, mult: 2 },
  [HandType.Trips]: { chips: 32, mult: 3 },
  [HandType.Straight]: { chips: 36, mult: 4 },
  [HandType.Flush]: { chips: 40, mult: 4 },
  [HandType.FullHouse]: { chips: 44, mult: 4 },
  [HandType.Quads]: { chips: 62, mult: 7 },
  [HandType.StraightFlush]: { chips: 108, mult: 8 },
  [HandType.FiveKind]: { chips: 130, mult: 12 },
};

/** 每局基础规则 */
export const RUN_RULES = {
  handSize: 8,          // 手牌上限
  playsPerLevel: 4,     // 每关可出牌次数
  discardsPerLevel: 3,  // 每关可弃牌次数
  maxSelect: 5,         // 单次牌阵最多 5 张
  relicSlots: 5,        // 符箓携带上限
  startGold: 4,         // 初始铜钱
};

/**
 * 关卡目标分曲线：共 12 节点，分 4 层（每层 3 关：小关-小关-Boss）。
 * 目标分随进度指数增长，制造后期爆分需求。
 */
export const LEVEL_TARGETS: number[] = [
  60,    // 1  小
  110,   // 2  小
  220,   // 3  ★Boss
  380,   // 4
  620,   // 5
  980,   // 6  ★Boss
  1500,  // 7
  2300,  // 8
  3600,  // 9  ★Boss
  5600,  // 10
  8800,  // 11
  14000, // 12 ★终局Boss
];

/** Boss 关索引（0-based） */
export const BOSS_LEVELS = new Set([2, 5, 8, 11]);

/** 通关奖励：过关得铜钱（基础 + 剩余出牌次数结余） */
export const REWARD = {
  baseGoldPerClear: 3,
  goldPerLeftoverPlay: 1,
  bossBonusGold: 2,
};

/** 商店价格（铜钱） */
export const SHOP_PRICES = {
  relic: 5,       // 符箓
  gildCard: 3,    // 镀金一张牌（×1.5）
  removeCard: 2,  // 从牌库移除一张牌（精简牌库）
  reroll: 1,      // 刷新商店
};

/** 门派开局配置在 balance 里给引用，具体效果在 run.ts / relics.ts */
export const SCHOOL_IDS = ["caishen", "wenqu", "jianghu"] as const;
export type SchoolId = (typeof SCHOOL_IDS)[number];
