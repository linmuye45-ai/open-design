/**
 * =============================================================================
 *  锦鲤牌阵 · 肉鸽流程 (run.ts)
 * -----------------------------------------------------------------------------
 *  管理一整局肉鸽：门派选择、发牌、出牌/弃牌、关卡目标、Boss 局势、
 *  过关奖励、商店、失败/通关、本地存档。全部为原创玩法逻辑。
 * =============================================================================
 */
import {
  Card, HandResult, identifyHand, buildDeck, shuffle,
} from "./rules";
import {
  HAND_SCORES, LEVEL_TARGETS, BOSS_LEVELS, RUN_RULES, REWARD, SHOP_PRICES, SchoolId,
} from "./balance";
import { Relic, RELICS, getRelic, computeScore } from "./relics";

export type Phase = "school" | "playing" | "reward" | "shop" | "won" | "lost";

/** Boss 局势（对本关施加限制，制造逆转张力）。原创设定。 */
export interface Boss {
  id: string;
  name: string;
  desc: string;
  emoji: string;
}
export const BOSSES: Boss[] = [
  { id: "suomen", name: "锁门判官", emoji: "🔒", desc: "本关手牌减少 2 张（发牌更少）。" },
  { id: "koufen", name: "克扣御史", emoji: "🚫", desc: "本关每次出牌得分打八折（×0.8）。" },
  { id: "duoqian", name: "夺钱阎罗", emoji: "👹", desc: "本关每次出牌先扣 30 分。" },
  { id: "nixi", name: "逆袭真君", emoji: "🌊", desc: "本关目标分提高 20%，但通关多得 3 铜钱。" },
];

/** 门派：不同开局符箓 + 风格。原创设定。 */
export interface School {
  id: SchoolId;
  name: string;
  desc: string;
  emoji: string;
  startRelicIds: string[];
}
export const SCHOOLS: School[] = [
  { id: "caishen", name: "财神堂", emoji: "🧧", desc: "偏红牌与铜钱爆倍，开局带【招财进宝】【玉如意】。", startRelicIds: ["zhaocai", "yuru"] },
  { id: "wenqu", name: "文曲阁", emoji: "📜", desc: "偏顺子/同花结构，开局带【文曲连珠】。", startRelicIds: ["wenqu"] },
  { id: "jianghu", name: "江湖派", emoji: "⚔️", desc: "偏对子/炸弹高风险高回报，开局带【双刀合璧】【琥珀凝光】。", startRelicIds: ["shuangdao", "hupo"] },
];

export interface ShopItem {
  kind: "relic" | "gild" | "remove" | "reroll";
  price: number;
  relicId?: string;
  label: string;
  desc: string;
  emoji: string;
}

export interface RunState {
  phase: Phase;
  school: SchoolId | null;
  level: number;              // 0-based
  target: number;             // 本关目标分
  score: number;              // 本关累计
  playsLeft: number;
  discardsLeft: number;
  gold: number;
  deck: Card[];               // 抽牌堆
  discardPile: Card[];        // 弃牌/已用堆
  hand: Card[];               // 当前手牌
  selected: string[];         // 选中卡 id
  relics: string[];           // 携带符箓 id
  fullDeck: Card[];           // 本局牌库全集（用于移除/镀金持久化）
  boss: Boss | null;
  handsPlayedThisLevel: number;
  shop: ShopItem[];
  lastScore: { total: number; chips: number; mult: number; log: string[] } | null;
  seed: number;
  stats: { bestHand: number; totalScore: number; relicsOwned: number };
}

// -------- 可复现随机源（线性同余，便于测试与分享种子） --------
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function targetForLevel(level: number, boss: Boss | null): number {
  const base = LEVEL_TARGETS[level] ?? LEVEL_TARGETS[LEVEL_TARGETS.length - 1];
  if (boss?.id === "nixi") return Math.round(base * 1.2);
  return base;
}

function pickBoss(level: number, rng: () => number): Boss | null {
  if (!BOSS_LEVELS.has(level)) return null;
  return BOSSES[Math.floor(rng() * BOSSES.length)];
}

/** 开新局（尚未选门派） */
export function newRun(seed: number = Date.now()): RunState {
  return {
    phase: "school",
    school: null,
    level: 0,
    target: LEVEL_TARGETS[0],
    score: 0,
    playsLeft: RUN_RULES.playsPerLevel,
    discardsLeft: RUN_RULES.discardsPerLevel,
    gold: RUN_RULES.startGold,
    deck: [], discardPile: [], hand: [], selected: [],
    relics: [], fullDeck: [], boss: null,
    handsPlayedThisLevel: 0,
    shop: [],
    lastScore: null,
    seed,
    stats: { bestHand: 0, totalScore: 0, relicsOwned: 0 },
  };
}

/** 选门派，正式开局第一关 */
export function chooseSchool(state: RunState, id: SchoolId): RunState {
  const school = SCHOOLS.find((s) => s.id === id)!;
  const s = { ...state };
  s.school = id;
  s.relics = [...school.startRelicIds];
  s.fullDeck = buildDeck();
  s.stats.relicsOwned = s.relics.length;
  startLevel(s, 0);
  return s;
}

function currentHandSize(s: RunState): number {
  let size = RUN_RULES.handSize;
  if (s.boss?.id === "suomen") size -= 2;
  return size;
}

/** 进入某关：洗牌、发牌、设目标 */
function startLevel(s: RunState, level: number): void {
  const rng = makeRng(s.seed + level * 7919);
  s.level = level;
  s.boss = pickBoss(level, rng);
  s.target = targetForLevel(level, s.boss);
  s.score = 0;
  s.playsLeft = RUN_RULES.playsPerLevel;
  s.discardsLeft = RUN_RULES.discardsPerLevel;
  s.handsPlayedThisLevel = 0;
  s.deck = shuffle(s.fullDeck, rng);
  s.discardPile = [];
  s.hand = [];
  s.selected = [];
  drawTo(s, currentHandSize(s));
  s.phase = "playing";
}

/** 补牌至手牌上限 */
function drawTo(s: RunState, size: number): void {
  while (s.hand.length < size) {
    if (s.deck.length === 0) {
      if (s.discardPile.length === 0) break;
      // 重洗弃牌堆（本关内牌用尽时）
      const rng = makeRng(s.seed + s.level * 131 + s.handsPlayedThisLevel);
      s.deck = shuffle(s.discardPile, rng);
      s.discardPile = [];
    }
    s.hand.push(s.deck.pop()!);
  }
}

export function toggleSelect(s: RunState, cardId: string): RunState {
  const ns = { ...s, selected: [...s.selected] };
  const i = ns.selected.indexOf(cardId);
  if (i >= 0) ns.selected.splice(i, 1);
  else if (ns.selected.length < RUN_RULES.maxSelect) ns.selected.push(cardId);
  return ns;
}

function selectedCards(s: RunState): Card[] {
  return s.selected.map((id) => s.hand.find((c) => c.id === id)!).filter(Boolean);
}

/** 预览当前选牌的牌型（不消耗次数） */
export function previewHand(s: RunState): HandResult | null {
  const cs = selectedCards(s);
  if (cs.length === 0) return null;
  return identifyHand(cs, HAND_SCORES);
}

function relicObjs(s: RunState): Relic[] {
  return s.relics.map((id) => getRelic(id)).filter((r): r is Relic => !!r);
}

/** 出牌计分 */
export function playHand(s: RunState): RunState {
  const cs = selectedCards(s);
  if (cs.length === 0 || s.playsLeft <= 0) return s;
  const ns: RunState = { ...s, hand: [...s.hand], deck: [...s.deck], discardPile: [...s.discardPile], selected: [] };

  const hand = identifyHand(cs, HAND_SCORES);
  ns.playsLeft -= 1;

  // Boss：夺钱阎罗先扣底分（通过 meta 传递给符箓管线后我们手动扣）
  const res = computeScore(hand, cs, relicObjs(ns), {
    level: ns.level,
    playsLeft: ns.playsLeft,
    discardsLeft: ns.discardsLeft,
    gold: ns.gold,
    handsPlayedThisLevel: ns.handsPlayedThisLevel,
    deckSize: ns.fullDeck.length,
  });

  let total = res.total;
  // Boss 局势对最终得分的影响（确定性、UI 明示）
  if (ns.boss?.id === "koufen") {
    total = Math.round(total * 0.8);
    res.log.push("克扣御史 ×0.8");
  }
  if (ns.boss?.id === "duoqian") {
    total = Math.max(0, total - 30);
    res.log.push("夺钱阎罗 -30");
  }

  ns.lastScore = { total, chips: res.chips, mult: res.mult, log: res.log };
  ns.score += total;
  ns.handsPlayedThisLevel += 1;
  ns.stats.bestHand = Math.max(ns.stats.bestHand, total);
  ns.stats.totalScore += total;

  // 打出的牌进弃牌堆并补牌
  const playedIds = new Set(cs.map((c) => c.id));
  ns.hand = ns.hand.filter((c) => !playedIds.has(c.id));
  ns.discardPile.push(...cs);
  drawTo(ns, currentHandSize(ns));

  // 结算关卡：达标 → 奖励；出牌用尽仍不达标 → 失败
  if (ns.score >= ns.target) {
    enterReward(ns);
  } else if (ns.playsLeft <= 0) {
    ns.phase = "lost";
  }
  return ns;
}

/** 弃牌重抽 */
export function discardSelected(s: RunState): RunState {
  const cs = selectedCards(s);
  if (cs.length === 0 || s.discardsLeft <= 0) return s;
  const ns: RunState = { ...s, hand: [...s.hand], discardPile: [...s.discardPile], selected: [] };
  ns.discardsLeft -= 1;
  const ids = new Set(cs.map((c) => c.id));
  ns.hand = ns.hand.filter((c) => !ids.has(c.id));
  ns.discardPile.push(...cs);
  drawTo(ns, currentHandSize(ns));
  return ns;
}

/** 进入过关奖励结算 */
function enterReward(s: RunState): void {
  let gold = REWARD.baseGoldPerClear + s.playsLeft * REWARD.goldPerLeftoverPlay;
  if (s.boss) gold += REWARD.bossBonusGold;
  if (s.boss?.id === "nixi") gold += 3;
  s.gold += gold;
  s.lastRewardGold = gold as any;
  s.phase = "reward";
}

/** 领奖后进入商店 */
export function enterShop(s: RunState, rng: () => number = Math.random): RunState {
  const ns = { ...s };
  ns.shop = rollShop(ns, rng);
  ns.phase = "shop";
  return ns;
}

function rollShop(s: RunState, rng: () => number): ShopItem[] {
  const owned = new Set(s.relics);
  const pool = RELICS.filter((r) => !owned.has(r.id));
  const items: ShopItem[] = [];
  // 2 个符箓
  const shuffled = shuffle(pool, rng);
  for (const r of shuffled.slice(0, 2)) {
    items.push({ kind: "relic", price: SHOP_PRICES.relic + (r.rarity === "epic" ? 3 : r.rarity === "rare" ? 1 : 0), relicId: r.id, label: r.name, desc: r.desc, emoji: r.emoji });
  }
  items.push({ kind: "gild", price: SHOP_PRICES.gildCard, label: "镀金符", desc: "为牌库随机一张牌镀金（得分×1.5）。", emoji: "🥇" });
  items.push({ kind: "remove", price: SHOP_PRICES.removeCard, label: "精简符", desc: "从牌库随机移除一张最小牌（提升构筑纯度）。", emoji: "✂️" });
  items.push({ kind: "reroll", price: SHOP_PRICES.reroll, label: "刷新", desc: "刷新商店符箓。", emoji: "🔄" });
  return items;
}

export function buyItem(s: RunState, index: number, rng: () => number = Math.random): RunState {
  const item = s.shop[index];
  if (!item || s.gold < item.price) return s;
  const ns: RunState = { ...s, relics: [...s.relics], fullDeck: [...s.fullDeck], shop: [...s.shop] };
  ns.gold -= item.price;
  if (item.kind === "relic" && item.relicId) {
    if (ns.relics.length < RUN_RULES.relicSlots) {
      ns.relics.push(item.relicId);
      ns.stats.relicsOwned = ns.relics.length;
    } else {
      ns.gold += item.price; // 槽位满，退款
      return ns;
    }
    ns.shop.splice(index, 1);
  } else if (item.kind === "gild") {
    const candidates = ns.fullDeck.filter((c) => !c.gilded);
    if (candidates.length) {
      const t = candidates[Math.floor(rng() * candidates.length)];
      ns.fullDeck = ns.fullDeck.map((c) => (c.id === t.id ? { ...c, gilded: true } : c));
    }
    ns.shop.splice(index, 1);
  } else if (item.kind === "remove") {
    // 移除一张点数最小的牌
    const sorted = ns.fullDeck.slice().sort((a, b) => a.rank - b.rank);
    if (sorted.length > 20) {
      const rm = sorted[0];
      ns.fullDeck = ns.fullDeck.filter((c) => c.id !== rm.id);
    }
    ns.shop.splice(index, 1);
  } else if (item.kind === "reroll") {
    ns.shop = rollShop(ns, rng);
  }
  return ns;
}

/** 离开商店，进入下一关（或通关） */
export function nextLevel(s: RunState): RunState {
  const ns = { ...s };
  const next = ns.level + 1;
  if (next >= LEVEL_TARGETS.length) {
    ns.phase = "won";
    return ns;
  }
  startLevel(ns, next);
  return ns;
}

// 附加字段（奖励金额展示）
declare module "./run" {}
export interface RunState { lastRewardGold?: number; }
