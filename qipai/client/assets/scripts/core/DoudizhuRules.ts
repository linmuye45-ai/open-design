/**
 * =============================================================================
 *  锦鲤棋牌 AAA · 斗地主规则引擎 (DoudizhuRules.ts)
 * -----------------------------------------------------------------------------
 *  纯函数、零副作用，供 UI 判定、AI 的 MCTS 模拟、服务端校验共用。
 *  提供：牌型识别 identify、比较 canBeat、合法出牌枚举 enumerateMoves。
 * =============================================================================
 */

import { ICard, ComboType, ICombo } from "./CardTypes";

export class DoudizhuRules {

    // ------------------------------------------------------------------
    //  牌型识别
    // ------------------------------------------------------------------
    public static identify(cards: ICard[]): ICombo {
        const invalid: ICombo = { type: ComboType.Invalid, keyRank: 0, length: 0, bombLevel: 0, cards };
        if (!cards || cards.length === 0) return invalid;

        const cnt = this._countByRank(cards);
        const ranks = Object.keys(cnt).map(Number).sort((a, b) => a - b);
        const n = cards.length;

        // 王炸
        if (n === 2 && cnt[16] === 1 && cnt[17] === 1)
            return { type: ComboType.Rocket, keyRank: 100, length: 1, bombLevel: 2, cards };
        // 单张
        if (n === 1) return { type: ComboType.Single, keyRank: ranks[0], length: 1, bombLevel: 0, cards };
        // 对子
        if (n === 2 && ranks.length === 1 && cnt[ranks[0]] === 2)
            return { type: ComboType.Pair, keyRank: ranks[0], length: 1, bombLevel: 0, cards };
        // 三张
        if (n === 3 && ranks.length === 1 && cnt[ranks[0]] === 3)
            return { type: ComboType.Trio, keyRank: ranks[0], length: 1, bombLevel: 0, cards };
        // 炸弹
        if (n === 4 && ranks.length === 1 && cnt[ranks[0]] === 4)
            return { type: ComboType.Bomb, keyRank: ranks[0], length: 1, bombLevel: 1, cards };
        // 三带一
        if (n === 4) {
            const trio = ranks.find(r => cnt[r] === 3);
            if (trio !== undefined && ranks.length === 2)
                return { type: ComboType.TrioSingle, keyRank: trio, length: 1, bombLevel: 0, cards };
        }
        // 三带二
        if (n === 5) {
            const trio = ranks.find(r => cnt[r] === 3);
            const pair = ranks.find(r => cnt[r] === 2);
            if (trio !== undefined && pair !== undefined && ranks.length === 2)
                return { type: ComboType.TrioPair, keyRank: trio, length: 1, bombLevel: 0, cards };
        }
        // 顺子
        if (n >= 5 && ranks.length === n && this._isConsecutive(ranks) && ranks[ranks.length - 1] <= 14)
            return { type: ComboType.Straight, keyRank: ranks[ranks.length - 1], length: n, bombLevel: 0, cards };
        // 连对
        if (n >= 6 && n % 2 === 0 && ranks.every(r => cnt[r] === 2) &&
            this._isConsecutive(ranks) && ranks[ranks.length - 1] <= 14)
            return { type: ComboType.StraightPair, keyRank: ranks[ranks.length - 1], length: ranks.length, bombLevel: 0, cards };

        // 飞机
        const trios = ranks.filter(r => cnt[r] >= 3).sort((a, b) => a - b);
        const plane = this._longestConsecutive(trios.filter(r => r <= 14));
        if (plane.length >= 2) {
            const m = plane.length;
            if (n === m * 3 && ranks.every(r => cnt[r] === 3))
                return { type: ComboType.Plane, keyRank: plane[m - 1], length: m, bombLevel: 0, cards };
            if (n === m * 4 && this._wingsValid(cnt, plane, 1))
                return { type: ComboType.PlaneSingle, keyRank: plane[m - 1], length: m, bombLevel: 0, cards };
            if (n === m * 5 && this._wingsValid(cnt, plane, 2))
                return { type: ComboType.PlanePair, keyRank: plane[m - 1], length: m, bombLevel: 0, cards };
        }
        // 四带二单
        if (n === 6) {
            const four = ranks.find(r => cnt[r] === 4);
            if (four !== undefined) return { type: ComboType.FourTwoSingle, keyRank: four, length: 1, bombLevel: 0, cards };
        }
        // 四带二对
        if (n === 8) {
            const four = ranks.find(r => cnt[r] === 4);
            const pairs = ranks.filter(r => cnt[r] === 2);
            if (four !== undefined && pairs.length === 2)
                return { type: ComboType.FourTwoPair, keyRank: four, length: 1, bombLevel: 0, cards };
        }
        return invalid;
    }

    // ------------------------------------------------------------------
    //  比较：play 能否压过 last（last 为 null = 自由出牌）
    // ------------------------------------------------------------------
    public static canBeat(play: ICombo, last: ICombo | null): boolean {
        if (play.type === ComboType.Invalid) return false;
        if (!last) return true;
        if (play.type === ComboType.Rocket) return true;
        if (last.type === ComboType.Rocket) return false;
        if (play.type === ComboType.Bomb && last.type !== ComboType.Bomb) return true;
        if (play.type === ComboType.Bomb && last.type === ComboType.Bomb) return play.keyRank > last.keyRank;
        if (last.type === ComboType.Bomb) return false;
        if (play.type !== last.type) return false;
        if (play.length !== last.length) return false;
        return play.keyRank > last.keyRank;
    }

    // ------------------------------------------------------------------
    //  合法出牌枚举（供 AI / 提示用）
    // ------------------------------------------------------------------
    public static enumerateMoves(hand: ICard[], last: ICombo | null): ICombo[] {
        const moves: ICombo[] = [];
        const byRank = this._groupByRank(hand);
        const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);

        const tryAdd = (cs: ICard[]) => {
            if (!cs.length) return;
            const combo = this.identify(cs);
            if (combo.type !== ComboType.Invalid && this.canBeat(combo, last)) moves.push(combo);
        };

        // 单/对/三/炸
        for (const r of ranks) {
            const g = byRank[r];
            tryAdd([g[0]]);
            if (g.length >= 2) tryAdd(g.slice(0, 2));
            if (g.length >= 3) {
                tryAdd(g.slice(0, 3));
                const s1 = this._pickKickers(byRank, [r], 1, 1); if (s1) tryAdd(g.slice(0, 3).concat(s1));
                const p1 = this._pickKickers(byRank, [r], 2, 1); if (p1) tryAdd(g.slice(0, 3).concat(p1));
            }
            if (g.length === 4) {
                tryAdd(g.slice(0, 4));
                const k = this._pickKickers(byRank, [r], 1, 2); if (k) tryAdd(g.slice(0, 4).concat(k));
            }
        }
        // 王炸
        if (byRank[16] && byRank[17]) tryAdd([byRank[16][0], byRank[17][0]]);
        // 顺子 / 连对 / 飞机
        this._straights(byRank, ranks).forEach(tryAdd);
        this._pairRuns(byRank, ranks).forEach(tryAdd);
        this._planes(byRank, ranks).forEach(tryAdd);

        // 去重
        const seen = new Set<string>();
        return moves.filter(m => {
            const key = m.cards.map(c => c.cardId * 2 + c.deckIndex).sort((a, b) => a - b).join(",");
            if (seen.has(key)) return false; seen.add(key); return true;
        });
    }

    // ------------------------------------------------------------------
    //  私有工具
    // ------------------------------------------------------------------
    private static _countByRank(cards: ICard[]): Record<number, number> {
        const c: Record<number, number> = {};
        for (const card of cards) c[card.rank] = (c[card.rank] || 0) + 1;
        return c;
    }
    private static _groupByRank(cards: ICard[]): Record<number, ICard[]> {
        const g: Record<number, ICard[]> = {};
        for (const c of cards) (g[c.rank] = g[c.rank] || []).push(c);
        return g;
    }
    private static _isConsecutive(ranks: number[]): boolean {
        for (let i = 1; i < ranks.length; i++) if (ranks[i] !== ranks[i - 1] + 1) return false;
        return true;
    }
    private static _longestConsecutive(arr: number[]): number[] {
        if (!arr.length) return [];
        let best = [arr[0]], cur = [arr[0]];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] === arr[i - 1] + 1) cur.push(arr[i]); else cur = [arr[i]];
            if (cur.length > best.length) best = cur.slice();
        }
        return best;
    }
    private static _wingsValid(cnt: Record<number, number>, plane: number[], wing: number): boolean {
        const used: Record<number, number> = {};
        plane.forEach(r => used[r] = 3);
        let wings = 0;
        for (const k in cnt) {
            const remain = cnt[k] - (used[k] || 0);
            if (remain === 0) continue;
            if (wing === 1) wings += remain;
            else { if (remain !== 2) return false; wings += 1; }
        }
        return wings === plane.length;
    }
    private static _pickKickers(byRank: Record<number, ICard[]>, exclude: number[], size: number, count: number): ICard[] | null {
        const out: ICard[] = [];
        const ranks = Object.keys(byRank).map(Number).filter(r => !exclude.includes(r)).sort((a, b) => a - b);
        for (const r of ranks) {
            if (out.length >= size * count) break;
            if (byRank[r].length >= size && r < 16) out.push(...byRank[r].slice(0, size));
        }
        return out.length === size * count ? out : null;
    }
    private static _straights(byRank: Record<number, ICard[]>, ranks: number[]): ICard[][] {
        const res: ICard[][] = [];
        const usable = ranks.filter(r => r <= 14 && byRank[r].length >= 1);
        for (let len = 5; len <= usable.length; len++)
            for (let i = 0; i + len <= usable.length; i++) {
                const seg = usable.slice(i, i + len);
                if (seg[seg.length - 1] - seg[0] === len - 1) res.push(seg.map(r => byRank[r][0]));
            }
        return res;
    }
    private static _pairRuns(byRank: Record<number, ICard[]>, ranks: number[]): ICard[][] {
        const res: ICard[][] = [];
        const usable = ranks.filter(r => r <= 14 && byRank[r].length >= 2);
        for (let len = 3; len <= usable.length; len++)
            for (let i = 0; i + len <= usable.length; i++) {
                const seg = usable.slice(i, i + len);
                if (seg[seg.length - 1] - seg[0] === len - 1) res.push(seg.flatMap(r => byRank[r].slice(0, 2)));
            }
        return res;
    }
    private static _planes(byRank: Record<number, ICard[]>, ranks: number[]): ICard[][] {
        const res: ICard[][] = [];
        const trioRanks = ranks.filter(r => r <= 14 && byRank[r].length >= 3);
        for (let len = 2; len <= trioRanks.length; len++)
            for (let i = 0; i + len <= trioRanks.length; i++) {
                const seg = trioRanks.slice(i, i + len);
                if (seg[seg.length - 1] - seg[0] !== len - 1) continue;
                const body = seg.flatMap(r => byRank[r].slice(0, 3));
                res.push(body);
                const s = this._pickKickers(byRank, seg, 1, len); if (s) res.push(body.concat(s));
                const p = this._pickKickers(byRank, seg, 2, len); if (p) res.push(body.concat(p));
            }
        return res;
    }
}
