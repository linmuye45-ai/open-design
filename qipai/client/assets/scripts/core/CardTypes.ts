/**
 * =============================================================================
 *  锦鲤棋牌 AAA · 核心牌型定义 (CardTypes.ts)
 * -----------------------------------------------------------------------------
 *  被 CardLayoutManager / CardAIController / GameLogic 共用。
 *  牌值编码采用「单字节稠密编码」，便于位运算与序列化：
 *    rank: 3..15 (3..A2)  16=小王 17=大王
 *    suit: 0♠ 1♥ 2♣ 3♦   4=王(无花色)
 *  cardId = rank * 8 + suit  （0..143），保证唯一且可逆。
 *  适配多游戏：斗地主(单副54) / 掼蛋(双副108) 用 deckIndex 区分同一张牌的两份。
 * =============================================================================
 */

/** 花色枚举 */
export enum Suit {
    Spade = 0,   // ♠ 黑桃
    Heart = 1,   // ♥ 红桃
    Club = 2,    // ♣ 梅花
    Diamond = 3, // ♦ 方块
    Joker = 4,   // 王（无花色）
}

/** 牌点数枚举（A=14, 2=15, 与斗地主大小一致） */
export enum Rank {
    Three = 3, Four = 4, Five = 5, Six = 6, Seven = 7, Eight = 8,
    Nine = 9, Ten = 10, Jack = 11, Queen = 12, King = 13,
    Ace = 14, Two = 15, LittleJoker = 16, BigJoker = 17,
}

/** 牌型枚举（斗地主 + 掼蛋通用，掼蛋特有牌型见 GuandanCombo） */
export enum ComboType {
    Invalid = 0,
    Single,          // 单张
    Pair,            // 对子
    Trio,            // 三张
    TrioSingle,      // 三带一
    TrioPair,        // 三带二
    Straight,        // 顺子 (>=5)
    StraightPair,    // 连对 (>=3 对)
    Plane,           // 飞机（纯）
    PlaneSingle,     // 飞机带单
    PlanePair,       // 飞机带对
    FourTwoSingle,   // 四带二单
    FourTwoPair,     // 四带二对
    Bomb,            // 炸弹
    Rocket,          // 王炸
    // ---- 掼蛋特有 ----
    StraightFlush,   // 同花顺（掼蛋中视为大炸弹）
    GuandanBomb5,    // 五张炸
    GuandanBomb6,    // 六张炸
    GuandanBomb7,    // 七张炸
    GuandanBomb8,    // 八张炸（四王）
}

/** 单张牌的不可变描述对象 */
export interface ICard {
    /** 0..143 的稠密唯一编码 */
    readonly cardId: number;
    readonly rank: Rank;
    readonly suit: Suit;
    /** 第几副牌（0/1），用于掼蛋双副去重 */
    readonly deckIndex: number;
}

/** 一手牌（出牌组合）的识别结果 */
export interface ICombo {
    type: ComboType;
    /** 主牌点（用于同型比较，越大越强） */
    keyRank: number;
    /** 序列长度（顺子/连对/飞机用） */
    length: number;
    /** 炸弹等级：0 普通 / 1 普通炸 / 2 王炸 / 3+ 掼蛋大炸 */
    bombLevel: number;
    /** 构成该组合的牌 */
    cards: ICard[];
}

/** 工具：合成 cardId */
export function makeCardId(rank: Rank, suit: Suit): number {
    return rank * 8 + suit;
}

/** 工具：从 cardId 还原 rank */
export function rankOf(cardId: number): Rank {
    return (Math.floor(cardId / 8)) as Rank;
}

/** 工具：从 cardId 还原 suit */
export function suitOf(cardId: number): Suit {
    return (cardId % 8) as Suit;
}

/** 工具：构造单张牌 */
export function createCard(rank: Rank, suit: Suit, deckIndex = 0): ICard {
    return Object.freeze({ cardId: makeCardId(rank, suit), rank, suit, deckIndex });
}

/** 牌点中文名（用于 UI 与日志） */
export const RANK_LABEL: Readonly<Record<number, string>> = Object.freeze({
    3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
    11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "小王", 17: "大王",
});

/** 花色符号 */
export const SUIT_SYMBOL: Readonly<Record<number, string>> = Object.freeze({
    0: "♠", 1: "♥", 2: "♣", 3: "♦", 4: "",
});

/** 是否红色花色 */
export function isRedSuit(suit: Suit): boolean {
    return suit === Suit.Heart || suit === Suit.Diamond;
}
