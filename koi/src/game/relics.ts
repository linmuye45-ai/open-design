/**
 * =============================================================================
 *  锦鲤牌阵 · 符箓 / 宝物系统 (relics.ts)
 * -----------------------------------------------------------------------------
 *  符箓是本作构筑核心：通过「效果钩子」在计分各阶段介入，改写规则、堆叠爆分。
 *  全部为原创设定（命名、效果、数值），围绕国风财神/文运/江湖三主题。
 *
 *  钩子模型：一次出牌的计分流水线依次触发
 *    onScoreStart → (每张计分牌) onCardScored → onHandScored → onScoreEnd
 *  符箓通过修改 ScoreContext 中的 chips / mult 实现叠加。
 * =============================================================================
 */
import { Card, HandType, HandResult, Suit, isRedSuit } from "./rules";

/** 计分上下文：符箓读取/修改这里的字段 */
export interface ScoreContext {
  hand: HandResult;
  /** 打出的全部牌（含未计分的） */
  played: Card[];
  /** 当前累计底分 */
  chips: number;
  /** 当前累计倍率 */
  mult: number;
  /** 本局元信息（用于条件判断） */
  meta: {
    level: number;         // 0-based 关卡
    playsLeft: number;     // 剩余出牌数
    discardsLeft: number;  // 剩余弃牌数
    gold: number;          // 铜钱
    handsPlayedThisLevel: number;
    deckSize: number;
  };
  /** 触发日志（用于 UI 逐条飘字反馈） */
  log: string[];
}

export interface Relic {
  id: string;
  name: string;         // 国风名
  desc: string;         // 玩家可读描述
  rarity: "common" | "rare" | "epic";
  emoji: string;        // 占位图标（美术替换前）
  /** 各钩子（可选实现） */
  onScoreStart?: (ctx: ScoreContext) => void;
  onCardScored?: (ctx: ScoreContext, card: Card) => void;
  onHandScored?: (ctx: ScoreContext) => void;
  onScoreEnd?: (ctx: ScoreContext) => void;
}

const add = (ctx: ScoreContext, chips: number, mult: number, why: string) => {
  if (chips) ctx.chips += chips;
  if (mult) ctx.mult += mult;
  ctx.log.push(why);
};
const times = (ctx: ScoreContext, factor: number, why: string) => {
  ctx.mult *= factor;
  ctx.log.push(why);
};

/**
 * 全部符箓库（>= 30）。onCardScored 中的 card 为「参与计分的牌」。
 */
export const RELICS: Relic[] = [
  // ---------- 财神系（红牌 / 铜钱 / 爆倍） ----------
  { id: "zhaocai", name: "招财进宝", rarity: "common", emoji: "🧧",
    desc: "每张【朱雀♥】计分牌 +4 底分。",
    onCardScored: (c, card) => { if (card.suit === Suit.Red) add(c, 4, 0, "招财进宝 +4"); } },
  { id: "jinlong", name: "金鳞化龙", rarity: "rare", emoji: "🐉",
    desc: "打出【长龙(顺子)】时，倍率 ×3。",
    onHandScored: (c) => { if (c.hand.type === HandType.Straight) times(c, 3, "金鳞化龙 ×3"); } },
  { id: "yuanbao", name: "元宝滚滚", rarity: "common", emoji: "💰",
    desc: "身上每有 2 铜钱，+1 倍率。",
    onScoreEnd: (c) => { const m = Math.floor(c.meta.gold / 2); if (m) add(c, 0, m, `元宝滚滚 +${m}倍`); } },
  { id: "caishen", name: "财神踏印", rarity: "epic", emoji: "🎴",
    desc: "打出【满堂/四方/五福】时，倍率翻倍。",
    onHandScored: (c) => { if ([HandType.FullHouse, HandType.Quads, HandType.FiveKind].includes(c.hand.type)) times(c, 2, "财神踏印 倍率翻倍"); } },
  { id: "hongyun", name: "鸿运当头", rarity: "common", emoji: "🔴",
    desc: "若牌阵全为红牌(♥♦)，+30 底分。",
    onHandScored: (c) => { if (c.hand.scoring.every((k) => isRedSuit(k.suit))) add(c, 30, 0, "鸿运当头 +30"); } },
  { id: "zhaofu", name: "五福临门", rarity: "epic", emoji: "🌟",
    desc: "打出【五福(五条)】时，倍率 ×5。",
    onHandScored: (c) => { if (c.hand.type === HandType.FiveKind) times(c, 5, "五福临门 ×5"); } },

  // ---------- 文运系（顺子 / 同花 / 结构） ----------
  { id: "wenchang", name: "文昌点斗", rarity: "common", emoji: "📜",
    desc: "每张【玄武♠】计分牌 +3 底分。",
    onCardScored: (c, card) => { if (card.suit === Suit.Black) add(c, 3, 0, "文昌点斗 +3"); } },
  { id: "yifiliu", name: "一气贯通", rarity: "rare", emoji: "🎋",
    desc: "打出【同象(同花)】时，+50 底分。",
    onHandScored: (c) => { if (c.hand.type === HandType.Flush) add(c, 50, 0, "一气贯通 +50"); } },
  { id: "bagua", name: "八卦推演", rarity: "rare", emoji: "☯️",
    desc: "剩余弃牌次数每有 1 次，+2 倍率。",
    onScoreEnd: (c) => { if (c.meta.discardsLeft) add(c, 0, c.meta.discardsLeft * 2, `八卦推演 +${c.meta.discardsLeft * 2}倍`); } },
  { id: "kuixing", name: "魁星独占", rarity: "rare", emoji: "🖌️",
    desc: "牌阵仅 1 张牌时（孤星），底分 ×4 且 +8 倍率。",
    onHandScored: (c) => { if (c.hand.scoring.length === 1) { c.chips *= 4; add(c, 0, 8, "魁星独占 底分×4 +8倍"); } } },
  { id: "hanmo", name: "翰墨飘香", rarity: "common", emoji: "🍵",
    desc: "每张人头牌(J/Q/K) 计分时 +2 倍率。",
    onCardScored: (c, card) => { if (card.rank >= 11 && card.rank <= 13) add(c, 0, 2, "翰墨飘香 +2倍"); } },
  { id: "wenqu", name: "文曲连珠", rarity: "epic", emoji: "🀄",
    desc: "打出【长龙】或【游龙】时，倍率 ×4。",
    onHandScored: (c) => { if ([HandType.Straight, HandType.StraightFlush].includes(c.hand.type)) times(c, 4, "文曲连珠 ×4"); } },

  // ---------- 江湖系（对子/炸弹/高风险） ----------
  { id: "shuangdao", name: "双刀合璧", rarity: "common", emoji: "⚔️",
    desc: "打出【成双/鸳鸯】时，+18 底分。",
    onHandScored: (c) => { if ([HandType.Pair, HandType.TwoPair].includes(c.hand.type)) add(c, 18, 0, "双刀合璧 +18"); } },
  { id: "leiting", name: "雷霆万钧", rarity: "epic", emoji: "💥",
    desc: "打出【四方(四条)】时，倍率 ×4 并 +40 底分。",
    onHandScored: (c) => { if (c.hand.type === HandType.Quads) { add(c, 40, 0, "雷霆 +40"); times(c, 4, "雷霆 ×4"); } } },
  { id: "poufu", name: "破釜沉舟", rarity: "rare", emoji: "🔥",
    desc: "若这是本关最后一次出牌，倍率 ×3。",
    onScoreEnd: (c) => { if (c.meta.playsLeft <= 0) times(c, 3, "破釜沉舟 ×3"); } },
  { id: "qixing", name: "七星连珠", rarity: "rare", emoji: "✨",
    desc: "每张点数为 7 的计分牌 +3 倍率。",
    onCardScored: (c, card) => { if (card.rank === 7) add(c, 0, 3, "七星连珠 +3倍"); } },
  { id: "gujin", name: "孤注一掷", rarity: "epic", emoji: "🎲",
    desc: "手中无剩余弃牌时，倍率 ×3。",
    onScoreEnd: (c) => { if (c.meta.discardsLeft <= 0) times(c, 3, "孤注一掷 ×3"); } },
  { id: "menke", name: "门客盈门", rarity: "common", emoji: "🏮",
    desc: "牌阵满 5 张时，+25 底分。",
    onHandScored: (c) => { if (c.hand.scoring.length >= 5) add(c, 25, 0, "门客盈门 +25"); } },

  // ---------- 通用/结构增强 ----------
  { id: "dianshi", name: "点石成金", rarity: "common", emoji: "🪙",
    desc: "每张【白虎♦】计分牌 +5 底分。",
    onCardScored: (c, card) => { if (card.suit === Suit.White) add(c, 5, 0, "点石成金 +5"); } },
  { id: "qinglong", name: "青龙偃月", rarity: "common", emoji: "🐲",
    desc: "每张【青龙♣】计分牌 +1 倍率。",
    onCardScored: (c, card) => { if (card.suit === Suit.Green) add(c, 0, 1, "青龙偃月 +1倍"); } },
  { id: "jinbo", name: "金箔加身", rarity: "rare", emoji: "🥇",
    desc: "每张【金箔牌】额外 +6 底分、+2 倍率。",
    onCardScored: (c, card) => { if (card.gilded) add(c, 6, 2, "金箔加身 +6/+2倍"); } },
  { id: "aces", name: "一诺千金", rarity: "rare", emoji: "🅰️",
    desc: "每张 A 计分牌 +12 底分。",
    onCardScored: (c, card) => { if (card.rank === 14) add(c, 12, 0, "一诺千金 +12"); } },
  { id: "shifu", name: "十方来聚", rarity: "common", emoji: "🔟",
    desc: "每张点数为 10 的计分牌 +2 倍率。",
    onCardScored: (c, card) => { if (card.rank === 10) add(c, 0, 2, "十方来聚 +2倍"); } },
  { id: "manhundun", name: "混沌初开", rarity: "epic", emoji: "🌀",
    desc: "打出【孤星(高牌)】时，倍率 ×6（弱牌逆袭）。",
    onHandScored: (c) => { if (c.hand.type === HandType.HighCard) times(c, 6, "混沌初开 ×6"); } },
  { id: "shuangxi", name: "双喜临门", rarity: "rare", emoji: "🎊",
    desc: "打出【鸳鸯(两对)】时，倍率 ×3。",
    onHandScored: (c) => { if (c.hand.type === HandType.TwoPair) times(c, 3, "双喜临门 ×3"); } },
  { id: "sanyang", name: "三阳开泰", rarity: "rare", emoji: "🌅",
    desc: "打出【三合(三条)】时，+35 底分。",
    onHandScored: (c) => { if (c.hand.type === HandType.Trips) add(c, 35, 0, "三阳开泰 +35"); } },
  { id: "fugui", name: "富贵满堂", rarity: "epic", emoji: "🏯",
    desc: "打出【满堂(葫芦)】时，底分 ×2、倍率 ×2。",
    onHandScored: (c) => { if (c.hand.type === HandType.FullHouse) { c.chips *= 2; times(c, 2, "富贵满堂 ×2/×2"); } } },
  { id: "jinsuo", name: "金锁连环", rarity: "common", emoji: "🔗",
    desc: "牌阵中每有一对相同点数，+8 底分。",
    onHandScored: (c) => {
      const cnt = new Map<number, number>();
      c.hand.scoring.forEach((k) => cnt.set(k.rank, (cnt.get(k.rank) ?? 0) + 1));
      let pairs = 0; cnt.forEach((v) => { pairs += Math.floor(v / 2); });
      if (pairs) add(c, pairs * 8, 0, `金锁连环 +${pairs * 8}`);
    } },
  { id: "hupo", name: "琥珀凝光", rarity: "common", emoji: "🟠",
    desc: "基础倍率 +3（简单粗暴）。",
    onScoreStart: (c) => add(c, 0, 3, "琥珀凝光 +3倍") },
  { id: "yuru", name: "玉如意", rarity: "common", emoji: "🔮",
    desc: "基础底分 +40。",
    onScoreStart: (c) => add(c, 40, 0, "玉如意 +40") },
  { id: "fenghuang", name: "凤凰涅槃", rarity: "epic", emoji: "🦚",
    desc: "打出【游龙(同花顺)】时，倍率 ×3、底分 +80。",
    onHandScored: (c) => { if (c.hand.type === HandType.StraightFlush) { add(c, 80, 0, "凤凰 +80"); times(c, 3, "凤凰 ×3"); } } },
  { id: "beidou", name: "北斗七元", rarity: "rare", emoji: "🌌",
    desc: "关卡序号越高，倍率越高（每关 +1 倍，从第1关起）。",
    onScoreEnd: (c) => { const m = c.meta.level + 1; add(c, 0, m, `北斗七元 +${m}倍`); } },
  { id: "yinliang", name: "白银万两", rarity: "common", emoji: "🥈",
    desc: "本关已出牌越多，本次 +10 底分/次（越战越勇）。",
    onScoreStart: (c) => { const b = c.meta.handsPlayedThisLevel * 10; if (b) add(c, b, 0, `白银万两 +${b}`); } },
];

/** 按 id 取符箓 */
export function getRelic(id: string): Relic | undefined {
  return RELICS.find((r) => r.id === id);
}

/**
 * 计分流水线：应用一组符箓，返回最终得分与日志。
 * 顺序：onScoreStart → 逐张 onCardScored（含每张牌底分）→ onHandScored → onScoreEnd。
 * 最终得分 = round(chips × mult)。
 */
export function computeScore(
  hand: HandResult,
  played: Card[],
  relics: Relic[],
  meta: ScoreContext["meta"]
): { chips: number; mult: number; total: number; log: string[] } {
  const ctx: ScoreContext = {
    hand,
    played,
    chips: hand.baseChips,
    mult: hand.baseMult,
    meta,
    log: [`牌阵【${hand.type}】 基础 ${hand.baseChips}底分 ×${hand.baseMult}倍`],
  };

  for (const r of relics) r.onScoreStart?.(ctx);

  // 逐张计分牌：先加该牌底分（含卡牌自身 bonus / 金箔），再触发符箓 onCardScored
  for (const card of hand.scoring) {
    let base = baseChipsOf(card);
    if (card.bonusChips) base += card.bonusChips;
    ctx.chips += base;
    if (card.gilded) { ctx.chips += Math.round(base * 0.5); }
    if (card.bonusMult) ctx.mult += card.bonusMult;
    ctx.log.push(`${labelOf(card)} +${base}底分`);
    for (const r of relics) r.onCardScored?.(ctx, card);
  }

  for (const r of relics) r.onHandScored?.(ctx);
  for (const r of relics) r.onScoreEnd?.(ctx);

  const total = Math.max(0, Math.round(ctx.chips * ctx.mult));
  return { chips: ctx.chips, mult: ctx.mult, total, log: ctx.log };
}

// 计分用的每张牌底分（与 rules.cardBaseChips 一致，避免循环依赖）
function baseChipsOf(c: Card): number {
  if (c.rank === 14) return 11;
  if (c.rank >= 11) return 10;
  return c.rank;
}
function labelOf(c: Card): string {
  const L: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };
  const sym = ["♠", "♥", "♣", "♦"][c.suit];
  return `${L[c.rank] ?? c.rank}${sym}`;
}
