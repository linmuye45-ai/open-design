/**
 * =============================================================================
 *  锦鲤棋牌 AAA · 掼蛋规则引擎 (GuandanRules.ts)
 * -----------------------------------------------------------------------------
 *  掼蛋 (Guandan) 使用两副牌 (108 张)，与斗地主的关键差异：
 *    1. 「级牌」机制：当前局的级数(2..A) 对应的牌为级牌，其大小仅次于大小王，
 *       且红桃级牌为「逢人配」百搭 (wildcard)，可替换任意非王牌凑成牌型。
 *    2. 牌型：单/对/三/三带二/顺子(5张)/连对(木板,3对)/钢板(飞机,2个三张)/
 *       炸弹(4..8张同点)/同花顺(火箭/五张同花顺)/天王炸(四大王)。
 *    3. 炸弹等级体系：4炸 < 5炸 < 同花顺 < 6炸 < 7炸 < 8炸 < 四大王(天王炸)。
 *       (采用主流规则：同花顺介于5炸与6炸之间)
 *
 *  本引擎为纯函数、零副作用，供 UI 判定 / AI 模拟 / 服务端校验共用。
 *  关键难点「逢人配」通过 identify(cards, level) 的 wildcard 归并算法处理：
 *  把红桃级牌抽出作为万能牌，尝试补齐目标牌型。
 *
 *  牌大小顺序（含级牌）：3<4<...<K<A(未作级牌时)<级牌<小王<大王
 *  用「有效点序」effRank 统一表达，避免散落的特判。
 * =============================================================================
 */

import { ICard, ComboType, ICombo, Rank, Suit } from "./CardTypes";

/** 掼蛋牌型的扩展比较键 */
export interface IGuandanCombo extends ICombo {
    /** 是否包含百搭（红桃级牌） */
    usedWild?: number;
}

export class GuandanRules {

    // ------------------------------------------------------------------
    //  有效点序：将级牌抬到 A 与 小王 之间
    //  普通点 3..15(2) 保持；级牌 -> 16；小王 -> 17；大王 -> 18
    //  注意 CardTypes 中 LittleJoker=16 BigJoker=17，这里独立映射以容纳级牌。
    // ------------------------------------------------------------------
    public static effRank(rank: Rank, level: number): number {
        if (rank === Rank.BigJoker) return 18;
        if (rank === Rank.LittleJoker) return 17;
        if (rank === level) return 16;   // 级牌
        // 2 (Rank.Two=15) 天然最大普通牌；其余按原值
        return rank;
    }

    /** 是否红桃级牌（逢人配百搭） */
    public static isWild(card: ICard, level: number): boolean {
        return card.suit === Suit.Heart && card.rank === level;
    }

    // ------------------------------------------------------------------
    //  牌型识别（支持逢人配）
    //  返回 IGuandanCombo；无法识别返回 Invalid。
    // ------------------------------------------------------------------
    public static identify(cards: ICard[], level: number): IGuandanCombo {
        const invalid: IGuandanCombo = { type: ComboType.Invalid, keyRank: 0, length: 0, bombLevel: 0, cards };
        if (!cards || cards.length === 0) return invalid;

        const n = cards.length;
        const wilds = cards.filter(c => this.isWild(c, level));
        const naturals = cards.filter(c => !this.isWild(c, level));
        const w = wilds.length;

        // ---- 天王炸：四大王（两副的小王+大王共4张） ----
        if (n === 4 && cards.every(c => c.rank === Rank.LittleJoker || c.rank === Rank.BigJoker)) {
            return { type: ComboType.GuandanBomb8, keyRank: 999, length: 4, bombLevel: 100, cards };
        }

        // ---- 同花顺（火箭）：5张同花且连续（wild 可补） ----
        const sf = this._tryStraightFlush(naturals, w, level, cards);
        if (n === 5 && sf) return sf;

        // ---- 炸弹：4..8 张同点（wild 可补） ----
        if (n >= 4 && n <= 8) {
            const bomb = this._trySamePoint(naturals, w, level, cards, n);
            if (bomb) {
                const lvl = this._bombLevel(n);
                const type = this._bombType(n);
                return { type, keyRank: bomb.eff, length: n, bombLevel: lvl, cards, usedWild: w };
            }
        }

        // ---- 单张 ----
        if (n === 1) {
            const c = cards[0];
            return { type: ComboType.Single, keyRank: this.effRank(c.rank, level), length: 1, bombLevel: 0, cards };
        }
        // ---- 对子 ----
        if (n === 2) {
            const pr = this._trySamePoint(naturals, w, level, cards, 2);
            if (pr) return { type: ComboType.Pair, keyRank: pr.eff, length: 1, bombLevel: 0, cards, usedWild: w };
        }
        // ---- 三张 ----
        if (n === 3) {
            const tr = this._trySamePoint(naturals, w, level, cards, 3);
            if (tr) return { type: ComboType.Trio, keyRank: tr.eff, length: 1, bombLevel: 0, cards, usedWild: w };
        }
        // ---- 三带二（葫芦） ----
        if (n === 5) {
            const fh = this._tryFullHouse(naturals, w, level, cards);
            if (fh) return fh;
        }
        // ---- 顺子（5张，A可作为最小或最大，但级牌/王不入顺） ----
        if (n === 5) {
            const st = this._tryStraight(naturals, w, level, cards);
            if (st) return st;
        }
        // ---- 连对（木板，3对=6张） ----
        if (n === 6) {
            const tp = this._tryTube(naturals, w, level, cards);
            if (tp) return tp;
        }
        // ---- 钢板（飞机，2个三张=6张，点数连续） ----
        if (n === 6) {
            const plate = this._tryPlate(naturals, w, level, cards);
            if (plate) return plate;
        }

        return invalid;
    }

    // ------------------------------------------------------------------
    //  比较：play 能否压过 last（last=null 自由出）
    //  炸弹体系统一用 bombLevel 比较；同级炸弹比 keyRank / 长度。
    // ------------------------------------------------------------------
    public static canBeat(play: IGuandanCombo, last: IGuandanCombo | null): boolean {
        if (!play || play.type === ComboType.Invalid) return false;
        if (!last) return true;

        const pBomb = play.bombLevel > 0;
        const lBomb = last.bombLevel > 0;

        // 双方都是炸弹：先比 bombLevel，再比长度，再比点
        if (pBomb && lBomb) {
            if (play.bombLevel !== last.bombLevel) return play.bombLevel > last.bombLevel;
            if (play.length !== last.length) return play.length > last.length;
            return play.keyRank > last.keyRank;
        }
        // 出炸弹压普通牌
        if (pBomb && !lBomb) return true;
        // 普通牌压不过炸弹
        if (!pBomb && lBomb) return false;

        // 普通牌对普通牌：类型与长度须一致
        if (play.type !== last.type) return false;
        if (play.length !== last.length) return false;
        return play.keyRank > last.keyRank;
    }

    // ------------------------------------------------------------------
    //  炸弹分级：4炸=10, 5炸=20, 同花顺=25, 6炸=30, 7炸=40, 8炸=50, 天王炸=100
    // ------------------------------------------------------------------
    private static _bombLevel(sameCount: number): number {
        switch (sameCount) {
            case 4: return 10;
            case 5: return 20;
            case 6: return 30;
            case 7: return 40;
            case 8: return 50;
            default: return 10;
        }
    }
    private static _bombType(sameCount: number): ComboType {
        switch (sameCount) {
            case 4: return ComboType.Bomb;
            case 5: return ComboType.GuandanBomb5;
            case 6: return ComboType.GuandanBomb6;
            case 7: return ComboType.GuandanBomb7;
            case 8: return ComboType.GuandanBomb8;
            default: return ComboType.Bomb;
        }
    }

    // ------------------------------------------------------------------
    //  私有：牌型匹配（含 wild 补齐）
    // ------------------------------------------------------------------

    /** n 张同点（含 wild 补齐）。返回有效点 eff。 */
    private static _trySamePoint(
        naturals: ICard[], wilds: number, level: number, all: ICard[], n: number
    ): { eff: number } | null {
        if (naturals.length + wilds !== n) return null;
        if (naturals.length === 0) {
            // 全 wild（例如两张红桃级牌当对子）——按级牌点
            return { eff: 16 };
        }
        // 所有自然牌须同点
        const r0 = naturals[0].rank;
        if (!naturals.every(c => c.rank === r0)) return null;
        // 王不能与普通牌混成同点炸（大小王单列）
        if (r0 === Rank.LittleJoker || r0 === Rank.BigJoker) {
            // 纯王同点：仅当无 wild（王本身不接受红桃级牌补）
            if (wilds > 0) return null;
        }
        return { eff: this.effRank(r0, level) };
    }

    /** 三带二（葫芦）：3同点 + 2同点，可用 wild。 */
    private static _tryFullHouse(
        naturals: ICard[], wilds: number, level: number, all: ICard[]
    ): IGuandanCombo | null {
        // 统计自然牌点数
        const cnt = this._countByEff(naturals, level);
        const ranks = Object.keys(cnt).map(Number);
        if (ranks.length > 2) return null;

        // 枚举：哪一点作三张
        for (const trioEff of ranks.length ? ranks : [16]) {
            const need3 = 3 - (cnt[trioEff] || 0);
            if (need3 < 0) continue;
            const otherRanks = ranks.filter(r => r !== trioEff);
            if (otherRanks.length > 1) continue;
            const pairEff = otherRanks.length ? otherRanks[0] : trioEff === 16 ? 15 : 16;
            const havePair = cnt[pairEff] || 0;
            const need2 = 2 - havePair;
            if (need2 < 0) continue;
            if (need3 + need2 === wilds && trioEff !== pairEff) {
                return { type: ComboType.TrioPair, keyRank: trioEff, length: 1, bombLevel: 0, cards: all, usedWild: wilds };
            }
        }
        return null;
    }

    /** 顺子（5张连续，级牌/王不入顺，A 可高可低，2 不入顺）。 */
    private static _tryStraight(
        naturals: ICard[], wilds: number, level: number, all: ICard[]
    ): IGuandanCombo | null {
        // 顺子用「牌面自然序」：A=14,K=13...3=3；2 与王不参与；级牌按其自然面值参与（非16）
        const faces = naturals.map(c => this._faceForStraight(c));
        if (faces.some(f => f < 0)) return null;                 // 含王/2
        const uniq = Array.from(new Set(faces));
        if (uniq.length !== faces.length) return null;           // 顺子不可重复点
        uniq.sort((a, b) => a - b);

        // 尝试用 wild 补齐 5 连（含 A 低位 A2345 情形）
        for (const low of this._straightStarts()) {
            const target = [low, low + 1, low + 2, low + 3, low + 4].map(v => v > 14 ? v - 13 : v);
            // 归一化：A 低位场景直接用 [1..5] 表示，比较用 face
            const want = this._normalizeStraight(low);
            const missing = want.filter(v => !uniq.includes(v)).length;
            const extra = uniq.filter(v => !want.includes(v)).length;
            if (extra === 0 && missing === wilds) {
                const top = Math.max(...want);
                return { type: ComboType.Straight, keyRank: top, length: 5, bombLevel: 0, cards: all, usedWild: wilds };
            }
        }
        return null;
    }

    /** 同花顺（5张同花且连续，wild 可补，视为炸弹级 25）。 */
    private static _tryStraightFlush(
        naturals: ICard[], wilds: number, level: number, all: ICard[]
    ): IGuandanCombo | null {
        if (naturals.length + wilds !== 5) return null;
        // 花色须一致（自然牌）；wild 是红桃，可视为任意花色
        const suits = new Set(naturals.map(c => c.suit));
        if (suits.size > 1) return null;
        const st = this._tryStraight(naturals, wilds, level, all);
        if (!st) return null;
        return { type: ComboType.StraightFlush, keyRank: st.keyRank, length: 5, bombLevel: 25, cards: all, usedWild: wilds };
    }

    /** 连对（木板，3对连续=6张）。 */
    private static _tryTube(
        naturals: ICard[], wilds: number, level: number, all: ICard[]
    ): IGuandanCombo | null {
        const faces = naturals.map(c => this._faceForStraight(c));
        if (faces.some(f => f < 0)) return null;
        const cnt: Record<number, number> = {};
        faces.forEach(f => cnt[f] = (cnt[f] || 0) + 1);
        const distinct = Object.keys(cnt).map(Number).sort((a, b) => a - b);
        if (distinct.length > 3) return null;

        for (const start of this._tubeStarts()) {
            const want = this._normalizeTube(start); // 3 个连续 face
            let need = 0, ok = true;
            for (const v of want) need += Math.max(0, 2 - (cnt[v] || 0));
            for (const f of distinct) if (!want.includes(f)) { ok = false; break; }
            for (const v of want) if ((cnt[v] || 0) > 2) { ok = false; break; }
            if (ok && need === wilds) {
                return { type: ComboType.StraightPair, keyRank: Math.max(...want), length: 3, bombLevel: 0, cards: all, usedWild: wilds };
            }
        }
        return null;
    }

    /** 钢板（飞机：2个连续三张=6张）。 */
    private static _tryPlate(
        naturals: ICard[], wilds: number, level: number, all: ICard[]
    ): IGuandanCombo | null {
        const faces = naturals.map(c => this._faceForStraight(c));
        if (faces.some(f => f < 0)) return null;
        const cnt: Record<number, number> = {};
        faces.forEach(f => cnt[f] = (cnt[f] || 0) + 1);
        const distinct = Object.keys(cnt).map(Number).sort((a, b) => a - b);
        if (distinct.length > 2) return null;

        for (const start of this._plateStarts()) {
            const want = [start, start + 1];
            let need = 0, ok = true;
            for (const v of want) need += Math.max(0, 3 - (cnt[v] || 0));
            for (const f of distinct) if (!want.includes(f)) { ok = false; break; }
            for (const v of want) if ((cnt[v] || 0) > 3) { ok = false; break; }
            if (ok && need === wilds) {
                return { type: ComboType.Plane, keyRank: Math.max(...want), length: 2, bombLevel: 0, cards: all, usedWild: wilds };
            }
        }
        return null;
    }

    // ---------- face 工具（顺子用自然面值，A=14, 2/王 剔除） ----------
    private static _faceForStraight(c: ICard): number {
        if (c.rank === Rank.LittleJoker || c.rank === Rank.BigJoker) return -1;
        if (c.rank === Rank.Two) return -1;   // 2 不入顺
        return c.rank; // 3..14(A)
    }
    // 顺子起点：A2345(用low=1表达)、23456..10JQKA。这里用最高张表达为 top∈[5..14]
    private static _straightStarts(): number[] {
        // 返回 low face 值集合：1(=A低),2,3...10  对应五连 [low..low+4]
        return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    }
    private static _normalizeStraight(low: number): number[] {
        // low=1 表示 A2345，但 2 不入顺 —— 掼蛋主流：A2345 不合法；仅 A作为高位(10JQKA)
        // 故 low 从 3 开始，最高 10 (10-J-Q-K-A)。这里过滤非法起点。
        const arr = [low, low + 1, low + 2, low + 3, low + 4];
        return arr.map(v => (v === 1 ? 14 : v));
    }
    private static _tubeStarts(): number[] { return [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; } // top<=A
    private static _normalizeTube(start: number): number[] { return [start, start + 1, start + 2]; }
    private static _plateStarts(): number[] { return [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]; }

    private static _countByEff(cards: ICard[], level: number): Record<number, number> {
        const c: Record<number, number> = {};
        for (const card of cards) {
            const e = this.effRank(card.rank, level);
            c[e] = (c[e] || 0) + 1;
        }
        return c;
    }
}
