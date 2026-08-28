/**
 * =============================================================================
 *  锦鲤牌阵 Koi Fortune · 牌与牌型规则 (rules.ts)
 * -----------------------------------------------------------------------------
 *  原创国风扑克构筑肉鸽的评分核心。玩家从手牌中选 1-5 张组成「牌阵」，
 *  系统识别牌阵等级，给出「底分(chips) × 倍率(mult)」的爆分模型。
 *
 *  这是策略解谜/构筑评分系统，不涉及任何真钱、金币输赢或赌博。
 *  牌型集合、命名、评分公式均为本项目原创设定。
 * =============================================================================
 */

/** 花色（四象）：♠玄武 ♥朱雀 ♣青龙 ♦白虎 —— 仅作视觉主题，不影响基础比较 */
export enum Suit {
  Black = 0, // ♠ 玄武（黑）
  Red = 1,   // ♥ 朱雀（红）
  Green = 2, // ♣ 青龙（绿）
  White = 3, // ♦ 白虎（白/金）
}

/** 点数 2..10, J=11, Q=12, K=13, A=14 */
export type Rank = number;

export interface Card {
  /** 稳定唯一 id，用于选择/去重/动画 key */
  id: string;
  rank: Rank;      // 2..14
  suit: Suit;
  /** 该卡的加成筹码（可被符箓改造，如「点石成金」给某张牌 +30 底分） */
  bonusChips?: number;
  /** 该卡的加成倍率（可被符箓改造） */
  bonusMult?: number;
  /** 是否为「金箔牌」（被镀金，得分 ×1.5，视觉金色） */
  gilded?: boolean;
}

/** 牌阵等级（原创命名，从弱到强） */
export enum HandType {
  HighCard = "孤星",       // 高牌
  Pair = "成双",          // 对子
  TwoPair = "鸳鸯",       // 两对
  Trips = "三合",         // 三条
  Straight = "长龙",      // 顺子
  Flush = "同象",         // 同花
  FullHouse = "满堂",     // 葫芦
  Quads = "四方",         // 四条
  StraightFlush = "游龙", // 同花顺
  FiveKind = "五福",      // 五条（借助符箓复制/百搭可成）
}

/** 每种牌型的基础评分 {底分, 倍率}（数值化配置见 balance.ts，会覆盖此默认） */
export interface HandScore {
  chips: number;
  mult: number;
}

export interface HandResult {
  type: HandType;
  /** 参与计分的牌（牌型主体，用于逐张累加底分与动画） */
  scoring: Card[];
  /** 牌型的关键点（用于比较/展示） */
  keyRank: Rank;
  baseChips: number;
  baseMult: number;
}

export const RANK_LABEL: Record<number, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A",
};
export const SUIT_SYMBOL: Record<Suit, string> = {
  [Suit.Black]: "♠",
  [Suit.Red]: "♥",
  [Suit.Green]: "♣",
  [Suit.White]: "♦",
};
export const SUIT_NAME: Record<Suit, string> = {
  [Suit.Black]: "玄武",
  [Suit.Red]: "朱雀",
  [Suit.Green]: "青龙",
  [Suit.White]: "白虎",
};
export function isRedSuit(s: Suit): boolean {
  return s === Suit.Red || s === Suit.White;
}

/** 每张牌的基础底分：A=11，人头=10，其余=点数（原创设定，近似扑克直觉） */
export function cardBaseChips(c: Card): number {
  if (c.rank === 14) return 11;
  if (c.rank >= 11) return 10;
  return c.rank;
}

/** 构造整副牌（52 张，无大小王；肉鸽中可被符箓增删/改造） */
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ id: `${r}-${s}`, rank: r, suit: s as Suit });
    }
  }
  return deck;
}

/** 洗牌（可注入随机源以便测试可复现） */
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
//  牌型识别
// ---------------------------------------------------------------------------

function countBy<T, K extends string | number>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    const g = m.get(k);
    if (g) g.push(x); else m.set(k, [x]);
  }
  return m;
}

/** 是否 5 张连续（A 可作最高 10-J-Q-K-A，也可作最低 A-2-3-4-5） */
function detectStraight(ranks: number[]): { ok: boolean; top: number } {
  const uniq = Array.from(new Set(ranks)).sort((a, b) => a - b);
  if (uniq.length !== 5) return { ok: false, top: 0 };
  // 常规连续
  if (uniq[4] - uniq[0] === 4) return { ok: true, top: uniq[4] };
  // A-2-3-4-5（A=14 视作 1）
  if (uniq.join(",") === "2,3,4,5,14") return { ok: true, top: 5 };
  return { ok: false, top: 0 };
}

/**
 * 识别 1-5 张牌组成的牌阵。少于 5 张时只可能是 高牌/对/两对/三条/四条 等。
 * 评分表由外部传入（balance），若不传用内置默认。
 */
export function identifyHand(cards: Card[], table?: Record<HandType, HandScore>): HandResult {
  const scoreTable = table ?? DEFAULT_HAND_SCORES;
  const n = cards.length;
  const byRank = countBy(cards, (c) => c.rank);
  const bySuit = countBy(cards, (c) => c.suit);
  const groups = Array.from(byRank.values()).sort((a, b) => b.length - a.length || b[0].rank - a[0].rank);
  const counts = groups.map((g) => g.length);
  const isFlush = n === 5 && bySuit.size === 1;
  const straight = n === 5 ? detectStraight(cards.map((c) => c.rank)) : { ok: false, top: 0 };

  const make = (type: HandType, scoring: Card[], keyRank: number): HandResult => ({
    type,
    scoring,
    keyRank,
    baseChips: scoreTable[type].chips,
    baseMult: scoreTable[type].mult,
  });

  // 五条（需要符箓/百搭才可能出现同点 5 张）
  if (counts[0] === 5) return make(HandType.FiveKind, cards, groups[0][0].rank);
  if (isFlush && straight.ok) return make(HandType.StraightFlush, cards, straight.top);
  if (counts[0] === 4) return make(HandType.Quads, groups[0], groups[0][0].rank);
  if (counts[0] === 3 && counts[1] === 2) return make(HandType.FullHouse, cards, groups[0][0].rank);
  if (isFlush) return make(HandType.Flush, cards, Math.max(...cards.map((c) => c.rank)));
  if (straight.ok) return make(HandType.Straight, cards, straight.top);
  if (counts[0] === 3) return make(HandType.Trips, groups[0], groups[0][0].rank);
  if (counts[0] === 2 && counts[1] === 2) {
    const scoring = [...groups[0], ...groups[1]];
    return make(HandType.TwoPair, scoring, Math.max(groups[0][0].rank, groups[1][0].rank));
  }
  if (counts[0] === 2) return make(HandType.Pair, groups[0], groups[0][0].rank);
  // 高牌：取最大一张计分
  const high = cards.slice().sort((a, b) => b.rank - a.rank)[0];
  return make(HandType.HighCard, high ? [high] : [], high ? high.rank : 0);
}

/** 默认评分表（balance.ts 会导出正式版本；此处保证 rules 可独立测试） */
export const DEFAULT_HAND_SCORES: Record<HandType, HandScore> = {
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

/** 牌型强弱排序（用于展示与「升级牌型」类符箓） */
export const HAND_ORDER: HandType[] = [
  HandType.HighCard, HandType.Pair, HandType.TwoPair, HandType.Trips,
  HandType.Straight, HandType.Flush, HandType.FullHouse, HandType.Quads,
  HandType.StraightFlush, HandType.FiveKind,
];
