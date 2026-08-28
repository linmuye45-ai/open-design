/**
 * =============================================================================
 *  锦鲤牌阵 · 本地存档与成就 (save.ts)
 * -----------------------------------------------------------------------------
 *  纯本地存储（localStorage），无账号、无云端、无付费。
 *  记录：最高分、通关次数、累计爆分、解锁成就、静音偏好。
 *  在非浏览器环境（如测试 node）下自动降级为内存存储，保证可测试。
 * =============================================================================
 */

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  emoji: string;
  /** 判定函数：给定档案数据返回是否达成 */
  check: (p: Profile) => boolean;
}

export interface Profile {
  bestScoreSingleHand: number;  // 单次出牌最高分
  bestRunLevel: number;         // 最远到达关卡（0-based，越大越远）
  wins: number;                 // 通关次数
  runs: number;                 // 开局次数
  totalScore: number;           // 历史累计得分
  relicsSeen: string[];         // 见过的符箓
  unlocked: string[];           // 已解锁成就 id
  muted: boolean;               // 静音偏好
}

const KEY = "koi_fortune_profile_v1";

function emptyProfile(): Profile {
  return {
    bestScoreSingleHand: 0,
    bestRunLevel: 0,
    wins: 0,
    runs: 0,
    totalScore: 0,
    relicsSeen: [],
    unlocked: [],
    muted: false,
  };
}

// 内存兜底（测试 / SSR 环境）
let memory: string | null = null;
function hasLS(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}
function rawGet(): string | null {
  if (hasLS()) return localStorage.getItem(KEY);
  return memory;
}
function rawSet(v: string): void {
  if (hasLS()) localStorage.setItem(KEY, v);
  else memory = v;
}

export function loadProfile(): Profile {
  const raw = rawGet();
  if (!raw) return emptyProfile();
  try {
    return { ...emptyProfile(), ...(JSON.parse(raw) as Profile) };
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(p: Profile): void {
  rawSet(JSON.stringify(p));
}

/** 成就清单（原创，全部为策略成绩，无付费无赌博） */
export const ACHIEVEMENTS: Achievement[] = [
  { id: "first_run", name: "初入牌局", desc: "开始第一局。", emoji: "🎴", check: (p) => p.runs >= 1 },
  { id: "big_hand_500", name: "小试爆分", desc: "单次出牌得分达到 500。", emoji: "💥", check: (p) => p.bestScoreSingleHand >= 500 },
  { id: "big_hand_2000", name: "爆分连城", desc: "单次出牌得分达到 2000。", emoji: "🌋", check: (p) => p.bestScoreSingleHand >= 2000 },
  { id: "big_hand_8000", name: "金鲤跃龙门", desc: "单次出牌得分达到 8000。", emoji: "🐟", check: (p) => p.bestScoreSingleHand >= 8000 },
  { id: "reach_boss1", name: "初逢局势", desc: "到达第一个 Boss 局势（第 3 关）。", emoji: "👹", check: (p) => p.bestRunLevel >= 2 },
  { id: "win", name: "牌阵大成", desc: "完成一次完整通关。", emoji: "🏆", check: (p) => p.wins >= 1 },
  { id: "win_3", name: "牌局宗师", desc: "累计通关 3 次。", emoji: "👑", check: (p) => p.wins >= 3 },
  { id: "collector", name: "符箓收藏家", desc: "累计见过 20 种符箓。", emoji: "📿", check: (p) => p.relicsSeen.length >= 20 },
];

/** 重新计算并写回已解锁成就，返回本次新解锁的成就 */
export function refreshAchievements(p: Profile): Achievement[] {
  const newly: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (!p.unlocked.includes(a.id) && a.check(p)) {
      p.unlocked.push(a.id);
      newly.push(a);
    }
  }
  return newly;
}

/** 记录一次出牌得分（更新最高分） */
export function recordHandScore(p: Profile, total: number): void {
  if (total > p.bestScoreSingleHand) p.bestScoreSingleHand = total;
  p.totalScore += total;
}

/** 记录见过的符箓 */
export function recordRelicsSeen(p: Profile, ids: string[]): void {
  for (const id of ids) if (!p.relicsSeen.includes(id)) p.relicsSeen.push(id);
}
