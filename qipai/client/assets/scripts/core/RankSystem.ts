/**
 * =============================================================================
 *  锦鲤棋牌 AAA · 爵位荣衔制 (RankSystem.ts)
 * -----------------------------------------------------------------------------
 *  面向 30–65 岁高净值用户的荣誉体系。摒弃"青铜/白银/黄金"这类幼态命名，
 *  采用中式古典爵位荣衔，提供强烈的"面子"与身份认同：
 *
 *      布衣 → 员外 → 乡绅 → 大富豪 → 一品大员 → 棋圣
 *
 *  设计目标：
 *   1. 纯逻辑、无引擎依赖，可在客户端/服务端/单测中直接运行。
 *   2. 段位不仅看积分，还引入"星级"与"段位保护"，避免连败暴跌带来的挫败感
 *      （老年高净值用户对挫败极度敏感 —— 情绪价值优先）。
 *   3. 提供确定性的结算函数 settle()：输入对局结果，输出积分增量、升降段、
 *      是否触发保护、以及给 UI 的荣衔展示数据。
 *   4. 完整错误处理与边界防御，无伪代码。
 * =============================================================================
 */

/** 爵位大段位（由低到高） */
export enum NobleTier {
    Commoner = 0,   // 布衣
    Squire = 1,     // 员外
    Gentry = 2,     // 乡绅
    Magnate = 3,    // 大富豪
    Minister = 4,   // 一品大员
    GrandMaster = 5,// 棋圣（封顶）
}

/** 每个大段位的元数据 */
export interface ITierMeta {
    tier: NobleTier;
    /** 中文荣衔名 */
    name: string;
    /** 进入该段位所需的最低总积分（阶梯下界，含） */
    floorScore: number;
    /** 该段位内的小星级数量（棋圣为无限进阶，用 Infinity 表示） */
    starCount: number;
    /** 每颗星所需积分跨度 */
    scorePerStar: number;
    /** 是否享有跌段保护（进入新段位后短期不跌回下一段） */
    demotionProtect: boolean;
    /** UI 主题色（十六进制），供前端荣衔牌渲染 */
    themeColor: string;
}

/** 段位阶梯表：floorScore 严格递增。棋圣封顶后星级无限。 */
export const TIER_TABLE: ReadonlyArray<ITierMeta> = Object.freeze([
    { tier: NobleTier.Commoner,    name: "布衣",     floorScore: 0,     starCount: 3, scorePerStar: 100, demotionProtect: false, themeColor: "#8d8d8d" },
    { tier: NobleTier.Squire,      name: "员外",     floorScore: 300,   starCount: 4, scorePerStar: 120, demotionProtect: false, themeColor: "#4caf50" },
    { tier: NobleTier.Gentry,      name: "乡绅",     floorScore: 780,   starCount: 4, scorePerStar: 150, demotionProtect: true,  themeColor: "#2196f3" },
    { tier: NobleTier.Magnate,     name: "大富豪",   floorScore: 1380,  starCount: 5, scorePerStar: 180, demotionProtect: true,  themeColor: "#9c27b0" },
    { tier: NobleTier.Minister,    name: "一品大员", floorScore: 2280,  starCount: 5, scorePerStar: 220, demotionProtect: true,  themeColor: "#ff9800" },
    { tier: NobleTier.GrandMaster, name: "棋圣",     floorScore: 3380,  starCount: Infinity, scorePerStar: 300, demotionProtect: true, themeColor: "#ffd700" },
]);

/** 玩家荣衔档案（可序列化） */
export interface IRankProfile {
    /** 累计荣衔积分（>=0） */
    score: number;
    /** 当前连胜数（用于连胜加成） */
    winStreak: number;
    /** 段位保护剩余局数（>0 时不跌段） */
    protectGames: number;
    /** 历史最高积分（用于成就展示） */
    peakScore: number;
    /** 累计对局数 */
    totalGames: number;
    /** 累计胜局 */
    totalWins: number;
}

/** 一局对局的输入结果 */
export interface IMatchOutcome {
    /** 是否获胜 */
    win: boolean;
    /**
     * 本局倍数（斗地主叫分/翻倍、掼蛋进贡等），用于放大积分波动。
     * 合法区间 [1, 64]，越界会被夹取。
     */
    multiplier?: number;
    /**
     * 对手平均实力相对本人的差值（对手更强为正），用于强弱调整积分。
     * 建议由 MMR 差 / 100 得到，区间 [-3, 3]，越界夹取。
     */
    opponentEdge?: number;
    /** 是否为逃跑/掉线判负（加重扣分，且不享受保护） */
    escaped?: boolean;
}

/** settle() 的结算结果 */
export interface IRankSettleResult {
    /** 结算前档案（深拷贝） */
    before: IRankProfile;
    /** 结算后档案 */
    after: IRankProfile;
    /** 本局积分增量（可正可负） */
    delta: number;
    /** 是否升段 */
    promoted: boolean;
    /** 是否降段 */
    demoted: boolean;
    /** 是否因保护而免于降段 */
    protectedFromDemotion: boolean;
    /** 结算后可直接展示的荣衔信息 */
    display: IRankDisplay;
}

/** 供 UI 展示的荣衔信息 */
export interface IRankDisplay {
    tier: NobleTier;
    tierName: string;
    /** 当前段位内的星级（1-based；棋圣为累进星级） */
    star: number;
    /** 该段位的星级上限（棋圣为 Infinity） */
    starMax: number;
    /** 距离下一颗星还需积分（棋圣同样适用） */
    scoreToNextStar: number;
    /** 完整荣衔文案，例如 "大富豪 · 三星" */
    fullTitle: string;
    themeColor: string;
}

/** 中文数字（用于星级文案，1-10 足够，超过用阿拉伯数字） */
const CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function cnStar(n: number): string {
    if (n >= 1 && n <= 10) return CN_NUM[n] + "星";
    return n + "星";
}

/**
 * 爵位荣衔核心引擎（纯静态）。
 * 所有方法均为确定性、无副作用（settle 返回新对象，不改入参）。
 */
export class RankSystem {

    /** 基础胜负积分（未乘倍数/强弱系数前） */
    private static readonly BASE_WIN = 60;
    private static readonly BASE_LOSE = 45;
    /** 连胜加成上限（每多一连胜 +8，最多 +40） */
    private static readonly STREAK_BONUS_PER = 8;
    private static readonly STREAK_BONUS_MAX = 40;
    /** 逃跑额外扣分 */
    private static readonly ESCAPE_PENALTY = 40;
    /** 升段后给予的保护局数 */
    private static readonly PROTECT_GAMES = 3;

    /** 创建一份初始档案（新玩家） */
    public static createProfile(): IRankProfile {
        return {
            score: 0,
            winStreak: 0,
            protectGames: 0,
            peakScore: 0,
            totalGames: 0,
            totalWins: 0,
        };
    }

    /** 根据总积分定位所属段位元数据（总是返回有效元数据） */
    public static tierOfScore(score: number): ITierMeta {
        const s = Math.max(0, Math.floor(score));
        // 从高到低找第一个 floorScore <= s 的段位
        for (let i = TIER_TABLE.length - 1; i >= 0; i--) {
            if (s >= TIER_TABLE[i].floorScore) return TIER_TABLE[i];
        }
        return TIER_TABLE[0];
    }

    /** 计算展示信息（星级、下一星差值、文案） */
    public static describe(score: number): IRankDisplay {
        const meta = this.tierOfScore(score);
        const s = Math.max(0, Math.floor(score));
        const within = s - meta.floorScore;                 // 段位内积分
        const rawStar = Math.floor(within / meta.scorePerStar); // 0-based 已满星数
        let star: number;
        let starMax: number;
        let scoreToNextStar: number;

        if (meta.starCount === Infinity) {
            // 棋圣：星级无限累进
            star = rawStar + 1;
            starMax = Infinity;
            scoreToNextStar = meta.scorePerStar - (within % meta.scorePerStar);
        } else {
            // 普通段位：星级封顶在 starCount，满星后积分继续累积直至跨入下一段
            const cappedRaw = Math.min(rawStar, meta.starCount - 1);
            star = cappedRaw + 1;
            starMax = meta.starCount;
            if (rawStar >= meta.starCount - 1) {
                // 已在本段最后一颗星，下一"星"其实是升段
                const nextTierFloor = this.nextTierFloor(meta.tier);
                scoreToNextStar = Math.max(0, nextTierFloor - s);
            } else {
                scoreToNextStar = meta.scorePerStar - (within % meta.scorePerStar);
            }
        }

        return {
            tier: meta.tier,
            tierName: meta.name,
            star,
            starMax,
            scoreToNextStar,
            fullTitle: `${meta.name} · ${starMax === Infinity ? cnStar(star) : cnStar(star)}`,
            themeColor: meta.themeColor,
        };
    }

    /** 下一段位的 floorScore；已封顶则返回当前段 floor + 一个极大跨度 */
    private static nextTierFloor(tier: NobleTier): number {
        const idx = TIER_TABLE.findIndex(t => t.tier === tier);
        if (idx >= 0 && idx < TIER_TABLE.length - 1) return TIER_TABLE[idx + 1].floorScore;
        // 已是最高段
        return TIER_TABLE[TIER_TABLE.length - 1].floorScore + 1e9;
    }

    /**
     * 结算一局，返回积分变化与升降段信息。纯函数：不修改传入的 profile。
     * @param profile 结算前档案
     * @param outcome 对局结果
     */
    public static settle(profile: IRankProfile, outcome: IMatchOutcome): IRankSettleResult {
        // ---- 入参防御 ----
        const before: IRankProfile = this._cloneProfile(this._sanitizeProfile(profile));
        const mult = this._clamp(outcome.multiplier ?? 1, 1, 64);
        const edge = this._clamp(outcome.opponentEdge ?? 0, -3, 3);
        const escaped = !!outcome.escaped;
        const win = !!outcome.win && !escaped; // 逃跑一律判负

        const beforeMeta = this.tierOfScore(before.score);
        const beforeTier = beforeMeta.tier;

        // ---- 计算积分增量 ----
        let delta: number;
        if (win) {
            // 连胜加成
            const streakBonus = Math.min(
                this.STREAK_BONUS_MAX,
                before.winStreak * this.STREAK_BONUS_PER
            );
            // 对手越强，赢了加分越多（edge>0）；对手弱赢了少加
            const edgeFactor = 1 + edge * 0.15;
            delta = Math.round((this.BASE_WIN + streakBonus) * mult * edgeFactor);
        } else {
            // 对手越强，输了扣分越少（edge>0 少扣）；逃跑额外惩罚
            const edgeFactor = 1 - edge * 0.15;
            delta = -Math.round(this.BASE_LOSE * mult * edgeFactor);
            if (escaped) delta -= this.ESCAPE_PENALTY;
        }

        // ---- 应用积分、段位保护 ----
        let newScore = before.score + delta;
        let protectedFromDemotion = false;

        // 跌段保护：仅对"会导致跌段"且保护局数>0 且非逃跑时生效
        if (delta < 0 && before.protectGames > 0 && !escaped) {
            const projectedTier = this.tierOfScore(newScore).tier;
            if (projectedTier < beforeTier && beforeMeta.demotionProtect) {
                // 保护：把积分锁在当前段 floor（不跌段），仅象征性扣分
                newScore = Math.max(newScore, beforeMeta.floorScore);
                protectedFromDemotion = true;
            }
        }
        newScore = Math.max(0, newScore);

        // ---- 更新连胜、局数、保护计数 ----
        const after: IRankProfile = {
            score: newScore,
            winStreak: win ? before.winStreak + 1 : 0,
            protectGames: Math.max(0, before.protectGames - 1),
            peakScore: Math.max(before.peakScore, newScore),
            totalGames: before.totalGames + 1,
            totalWins: before.totalWins + (win ? 1 : 0),
        };

        const afterTier = this.tierOfScore(after.score).tier;
        const promoted = afterTier > beforeTier;
        const demoted = afterTier < beforeTier;

        // 升段：授予保护局数
        if (promoted) {
            after.protectGames = this.PROTECT_GAMES;
        }

        return {
            before,
            after,
            delta: after.score - before.score, // 实际生效增量（含保护夹取）
            promoted,
            demoted,
            protectedFromDemotion,
            display: this.describe(after.score),
        };
    }

    // ---------- 内部工具 ----------

    private static _clamp(v: number, lo: number, hi: number): number {
        if (typeof v !== "number" || Number.isNaN(v)) return lo;
        return Math.max(lo, Math.min(hi, v));
    }

    private static _sanitizeProfile(p: IRankProfile): IRankProfile {
        const safe = (n: any, d = 0) =>
            typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
        return {
            score: safe(p?.score),
            winStreak: safe(p?.winStreak),
            protectGames: safe(p?.protectGames),
            peakScore: safe(p?.peakScore),
            totalGames: safe(p?.totalGames),
            totalWins: safe(p?.totalWins),
        };
    }

    private static _cloneProfile(p: IRankProfile): IRankProfile {
        return { ...p };
    }
}
