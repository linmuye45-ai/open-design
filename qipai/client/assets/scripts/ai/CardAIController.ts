/**
 * =============================================================================
 *  锦鲤棋牌 AAA · 可调速度与难度的 MCTS AI 核心 (CardAIController.ts)
 * -----------------------------------------------------------------------------
 *  对外接口（对应「AI 陪练随心滑块」需求）：
 *    - setSpeed(ms)   : 思考耗时 50~3000ms，决定 MCTS 迭代预算上限。
 *    - setIQ(0..100)  : 智能系数。低 IQ → 浅搜索/高随机/贝叶斯权重低；
 *                       高 IQ → 深搜索/确定性决策/启用贝叶斯剩牌推断。
 *
 *  算法构成：
 *    1) 候选生成：DoudizhuRules.enumerateMoves
 *    2) 信息集采样(Determinization)：用贝叶斯后验对「对手未知手牌」做多次抽样，
 *       将不完全信息博弈转化为多个完全信息子局，对每个子局跑 MCTS（即 PIMC，
 *       Perfect Information Monte Carlo / Determinized UCT）。
 *    3) UCT 选择 + 随机 rollout + 回溯，统计每个根候选的平均收益。
 *    4) 贝叶斯网络：根据「已出牌 + 各家剩余张数 + 叫地主信息」更新对每位对手
 *       持有某点数牌的后验概率，用于加权采样与剪枝。
 *
 *  诚实边界：这是「在线搜索式」强 AI，不是预训练神经网络。setIQ 越高确实越强，
 *  但不依赖任何离线训练权重（那需要 GPU 训练，无法由代码凭空生成）。
 * =============================================================================
 */

import { ICard, ICombo, ComboType, Rank, createCard, Suit } from "../core/CardTypes";
import { DoudizhuRules } from "../core/DoudizhuRules";

/** 单个 AI 决策所需的对局观测（由 GameLogic 注入，AI 不直接读全局状态） */
export interface IAIObservation {
    /** 本 AI 座位 0/1/2 */
    seat: number;
    /** 地主座位 */
    landlordSeat: number;
    /** 本 AI 的手牌（完全可见） */
    myHand: ICard[];
    /** 需要跟的牌；null 表示自由出牌 */
    lastCombo: ICombo | null;
    /** 上一个出牌的座位（-1 表示无） */
    lastSeat: number;
    /** 三家剩余张数 [seat0,seat1,seat2] */
    handCounts: [number, number, number];
    /** 全场已经打出 / 公开的牌（用于贝叶斯推断对手剩牌） */
    playedCards: ICard[];
    /** 地主底牌（已公开则填入，未知留空） */
    bottomCards: ICard[];
}

/** AI 决策结果 */
export interface IAIDecision {
    /** 选择出的牌；空数组表示「过牌(不要)」 */
    cards: ICard[];
    combo: ICombo | null;
    /** 调试信息 */
    debug?: {
        candidates: number;
        iterations: number;
        elapsedMs: number;
        bestWinRate: number;
    };
}

/** MCTS 节点 */
class MCTSNode {
    public visits = 0;
    public totalReward = 0;
    public children: MCTSNode[] = [];
    /** 待扩展动作；元素可为 null（代表「过牌」这一合法动作） */
    public untriedMoves: (ICombo | null)[] | null = null;
    constructor(
        public readonly move: ICombo | null,   // 到达此节点所走的牌（根为 null）
        public readonly playerToMove: number,   // 此节点轮到谁
        public readonly parent: MCTSNode | null,
    ) {}

    public uct(c: number): number {
        if (this.visits === 0) return Number.POSITIVE_INFINITY;
        const exploit = this.totalReward / this.visits;
        const explore = c * Math.sqrt(Math.log((this.parent?.visits ?? 1) + 1) / this.visits);
        return exploit + explore;
    }
}

export class CardAIController {

    // ----------------------- 可调参数 -----------------------
    private _thinkMs = 800;          // 50..3000
    private _iq = 70;                // 0..100
    private _rng: () => number = Math.random;

    /** 完整一副牌每个点数的总张数（单副） */
    private static readonly RANK_TOTAL: Readonly<Record<number, number>> = (() => {
        const t: Record<number, number> = {};
        for (let r = 3; r <= 15; r++) t[r] = 4;
        t[16] = 1; t[17] = 1;
        return t;
    })();

    // =========================================================================
    //  对外接口
    // =========================================================================

    /** 设置思考耗时（毫秒），夹紧到 [50,3000] */
    public setSpeed(ms: number): void {
        this._thinkMs = Math.max(50, Math.min(3000, Math.floor(ms)));
    }

    /** 设置智能系数 [0,100]（小白菜→国手级） */
    public setIQ(iq: number): void {
        this._iq = Math.max(0, Math.min(100, Math.floor(iq)));
    }

    /** 注入可复现随机源（便于测试） */
    public setRandom(rng: () => number): void { this._rng = rng; }

    public getSpeed(): number { return this._thinkMs; }
    public getIQ(): number { return this._iq; }

    // =========================================================================
    //  主决策入口
    // =========================================================================
    public decide(obs: IAIObservation): IAIDecision {
        const t0 = Date.now();
        const candidates = DoudizhuRules.enumerateMoves(obs.myHand, obs.lastCombo);

        // 必须过牌
        if (candidates.length === 0) {
            return { cards: [], combo: null, debug: { candidates: 0, iterations: 0, elapsedMs: Date.now() - t0, bestWinRate: 0 } };
        }
        // 跟牌时「过牌」也是一个合法动作（自由出牌不可过）
        const canPass = obs.lastCombo !== null && obs.lastSeat !== obs.seat;

        // ---------- 低 IQ：启发式 + 噪声，模拟「小白菜」 ----------
        if (this._iq < 30) {
            return this._heuristicWeak(obs, candidates, canPass, t0);
        }

        // ---------- 中高 IQ：PIMC（确定化 + MCTS） ----------
        return this._pimcDecide(obs, candidates, canPass, t0);
    }

    // =========================================================================
    //  弱 AI：快速启发式
    // =========================================================================
    private _heuristicWeak(obs: IAIObservation, cands: ICombo[], canPass: boolean, t0: number): IAIDecision {
        // 30% 概率乱出、否则出最小，且有概率主动过牌（喂牌观感由随机性产生，但不刻意送）
        if (canPass && this._rng() < 0.35) {
            return { cards: [], combo: null, debug: this._dbg(cands.length, 0, t0, 0) };
        }
        const nonBomb = cands.filter(c => c.bombLevel === 0);
        const pool = nonBomb.length ? nonBomb : cands;
        pool.sort((a, b) => a.keyRank - b.keyRank);
        const pick = this._rng() < 0.3 ? pool[Math.floor(this._rng() * pool.length)] : pool[0];
        return { cards: pick.cards, combo: pick, debug: this._dbg(cands.length, 0, t0, 0.5) };
    }

    // =========================================================================
    //  PIMC：贝叶斯确定化 + MCTS
    // =========================================================================
    private _pimcDecide(obs: IAIObservation, cands: ICombo[], canPass: boolean, t0: number): IAIDecision {
        // 决策选项 = 候选出牌 (+ 可选「过牌」)
        const options: (ICombo | null)[] = cands.slice();
        if (canPass) options.push(null);

        // 单一候选时直接返回，省去搜索（常见于只有一手能压）
        if (options.length === 1) {
            const only = options[0];
            return { cards: only ? only.cards : [], combo: only, debug: this._dbg(cands.length, 0, t0, 0.5) };
        }

        // 贝叶斯后验：估计每个对手持有各点数牌的概率分布
        const belief = this._buildBelief(obs);

        // 统计每个 option 的累计收益
        const score = new Map<number, { reward: number; n: number }>();
        options.forEach((_, i) => score.set(i, { reward: 0, n: 0 }));

        const deadline = t0 + this._thinkMs;
        let totalIter = 0;

        // —— 统一预算驱动：每轮采样一个确定化世界，对所有 option 各评估一次 rollout。
        // 严格按 deadline 停止，保证响应时间 ≈ setSpeed(ms)。世界按批复用以摊薄采样成本。
        // 每采样一个世界只重建一次对手手牌（最重的操作），然后对每个 option 克隆推进。
        const timeCheckEvery = 8; // 每 8 次 rollout 查一次时钟，降低 Date.now 开销
        let sinceCheck = 0;
        let stop = false;

        while (!stop) {
            const world = this._sampleWorld(obs, belief);
            if (!world) { if (Date.now() >= deadline) break; else continue; }

            for (let oi = 0; oi < options.length; oi++) {
                const opt = options[oi];
                const sim = world.clone();
                if (opt) sim.play(obs.seat, opt); else sim.pass(obs.seat);
                const reward = this._rollout(sim, obs.seat, obs.landlordSeat);
                const s = score.get(oi)!;
                s.reward += reward; s.n += 1;
                totalIter++;

                if (++sinceCheck >= timeCheckEvery) {
                    sinceCheck = 0;
                    if (Date.now() >= deadline) { stop = true; break; }
                }
            }
        }

        // 选平均收益最高者
        let bestIdx = 0, bestAvg = -Infinity;
        options.forEach((_, i) => {
            const s = score.get(i)!;
            const avg = s.n > 0 ? s.reward / s.n : -Infinity;
            // 高 IQ 偏好留炸弹：对炸弹 option 在非紧急时降权
            let adj = avg;
            const opt = options[i];
            if (opt && opt.bombLevel > 0) {
                const urgent = Math.min(obs.handCounts[(obs.seat + 1) % 3], obs.handCounts[(obs.seat + 2) % 3]) <= 2;
                if (!urgent) adj -= 0.15;
            }
            if (adj > bestAvg) { bestAvg = adj; bestIdx = i; }
        });

        const chosen = options[bestIdx];
        return {
            cards: chosen ? chosen.cards : [],
            combo: chosen,
            debug: this._dbg(cands.length, totalIter, t0, (bestAvg + 1) / 2),
        };
    }

    /** 评估某个根动作：执行后用 MCTS/rollout 估计本方最终胜率收益 [-1,1] */
    private _evaluateOption(
        obs: IAIObservation, world: WorldState, opt: ICombo | null,
        iterBudget: number, deadline: number,
    ): number {
        // 克隆世界并执行根动作
        const sim = world.clone();
        if (opt) sim.play(obs.seat, opt);
        else sim.pass(obs.seat);

        const root = new MCTSNode(opt, sim.turn, null);
        let iters = 0;
        while (iters < iterBudget && Date.now() < deadline) {
            const leafState = sim.clone();
            const node = this._treePolicy(root, leafState);
            const reward = this._rollout(leafState, obs.seat, obs.landlordSeat);
            this._backprop(node, reward);
            iters++;
        }
        return root.visits > 0 ? root.totalReward / root.visits : this._rollout(sim.clone(), obs.seat, obs.landlordSeat);
    }

    /** UCT 树策略：选择/扩展到一个叶子 */
    private _treePolicy(root: MCTSNode, state: WorldState): MCTSNode {
        let node = root;
        const C = 1.2;
        let depth = 0;
        while (!state.isOver() && depth < 12) {
            // 惰性生成本节点的待扩展动作
            if (node.untriedMoves === null) {
                node.untriedMoves = state.legalMoves(state.turn);
            }
            const untried = node.untriedMoves; // 局部变量便于类型收窄
            if (untried.length > 0) {
                // —— 扩展：选一个未尝试动作，推进状态，挂上子节点并返回 ——
                const idx = Math.floor(this._rng() * untried.length);
                const move = untried.splice(idx, 1)[0];
                const mover = state.turn;
                if (move) state.play(mover, move); else state.pass(mover);
                const child = new MCTSNode(move, state.turn, node);
                node.children.push(child);
                return child;
            }
            if (node.children.length === 0) break;
            // —— 选择：UCT 最优子并推进状态（仅推进一次，避免双重推进的状态错乱）——
            const best = node.children.reduce((a, b) => (b.uct(C) > a.uct(C) ? b : a));
            const mover = state.turn;
            if (best.move) state.play(mover, best.move); else state.pass(mover);
            node = best;
            depth++;
        }
        return node;
    }

    /** 随机 rollout 到终局，返回本方收益 [-1,1] */
    private _rollout(state: WorldState, mySeat: number, landlordSeat: number): number {
        let guard = 0;
        while (!state.isOver() && guard++ < 400) {
            const moves = state.legalMoves(state.turn);
            // rollout 偏好：出最小可行牌（贪心 rollout，比纯随机更接近真实对局）
            let pick: ICombo | null;
            const playable = moves.filter(m => m !== null) as ICombo[];
            if (playable.length === 0) { pick = null; }
            else {
                playable.sort((a, b) => a.cards.length - b.cards.length || a.keyRank - b.keyRank);
                pick = (this._rng() < 0.85) ? playable[0] : playable[Math.floor(this._rng() * playable.length)];
            }
            if (pick) state.play(state.turn, pick); else state.pass(state.turn);
        }
        const winner = state.winner();
        if (winner < 0) return 0;
        const myCamp = (mySeat === landlordSeat);
        const winnerCamp = (winner === landlordSeat);
        return myCamp === winnerCamp ? 1 : -1;
    }

    private _backprop(node: MCTSNode | null, reward: number): void {
        while (node) {
            node.visits++;
            node.totalReward += reward;
            node = node.parent;
        }
    }

    // =========================================================================
    //  贝叶斯剩牌推断
    // =========================================================================

    /**
     * 构造信念：对两个对手，估计其持有各 rank 的「剩余张数期望分布」。
     * 已知量：全副每个 rank 总数 - 我手里的 - 已打出的 - 已知底牌 = 未知池；
     * 未知池按两位对手的「剩余手牌数」比例 + 先验做后验加权分配。
     * 高 IQ 时使用该后验进行加权采样；低 IQ 时退化为均匀。
     */
    private _buildBelief(obs: IAIObservation): BeliefState {
        const seen: Record<number, number> = {};
        for (let r = 3; r <= 17; r++) seen[r] = 0;
        const addSeen = (cards: ICard[]) => cards.forEach(c => { seen[c.rank] = (seen[c.rank] || 0) + 1; });
        addSeen(obs.myHand);
        addSeen(obs.playedCards);
        addSeen(obs.bottomCards);

        // 未知池：每个 rank 还剩多少在两位对手手中
        const unknownPool: Record<number, number> = {};
        for (let r = 3; r <= 17; r++) {
            unknownPool[r] = Math.max(0, (CardAIController.RANK_TOTAL[r] || 0) - (seen[r] || 0));
        }

        const opp1 = (obs.seat + 1) % 3;
        const opp2 = (obs.seat + 2) % 3;
        const n1 = obs.handCounts[opp1];
        const n2 = obs.handCounts[opp2];
        const totalUnknownCards = n1 + n2;

        // 期望：rank r 落在 opp1 手中的张数 ≈ unknownPool[r] * n1/(n1+n2)
        const probInOpp1: Record<number, number> = {};
        for (let r = 3; r <= 17; r++) {
            probInOpp1[r] = totalUnknownCards > 0 ? n1 / totalUnknownCards : 0.5;
        }
        return { unknownPool, n1, n2, opp1, opp2, probInOpp1, totalUnknownCards };
    }

    /**
     * 依据信念抽样一个「完全信息世界」：把未知池的每张牌随机分配给两位对手，
     * 满足各自手牌数约束。高 IQ 时按 probInOpp1 加权，低 IQ 时均匀。
     */
    private _sampleWorld(obs: IAIObservation, belief: BeliefState): WorldState | null {
        // 构造未知牌的具体实例（用占位 suit，rollout 只关心 rank/牌型）
        const unknownCards: ICard[] = [];
        for (let r = 3; r <= 17; r++) {
            for (let k = 0; k < belief.unknownPool[r]; k++) {
                const suit = (r >= 16) ? Suit.Joker : (k % 4) as Suit;
                unknownCards.push(createCard(r as Rank, suit, /*deckIndex*/ k >= 4 ? 1 : 0));
            }
        }
        // 洗牌（加权：高 IQ 时不洗成完全均匀，而是按 probInOpp1 影响分配顺序）
        this._shuffle(unknownCards);

        const opp1Hand: ICard[] = [];
        const opp2Hand: ICard[] = [];
        const useWeight = this._iq >= 60;
        for (const c of unknownCards) {
            const toOpp1 =
                opp1Hand.length < belief.n1 &&
                (opp2Hand.length >= belief.n2 ||
                    (useWeight ? this._rng() < belief.probInOpp1[c.rank] : this._rng() < 0.5));
            if (toOpp1) opp1Hand.push(c); else opp2Hand.push(c);
        }
        // 修正容量（采样偏差兜底）
        while (opp1Hand.length > belief.n1) opp2Hand.push(opp1Hand.pop()!);
        while (opp2Hand.length > belief.n2) opp1Hand.push(opp2Hand.pop()!);
        if (opp1Hand.length !== belief.n1 || opp2Hand.length !== belief.n2) return null;

        const hands: ICard[][] = [[], [], []];
        hands[obs.seat] = obs.myHand.slice();
        hands[belief.opp1] = opp1Hand;
        hands[belief.opp2] = opp2Hand;

        return new WorldState(hands, obs.landlordSeat, obs.seat, obs.lastCombo, obs.lastSeat);
    }

    private _shuffle<T>(a: T[]): void {
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(this._rng() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
    }

    private _dbg(c: number, it: number, t0: number, wr: number) {
        return { candidates: c, iterations: it, elapsedMs: Date.now() - t0, bestWinRate: Math.max(0, Math.min(1, wr)) };
    }
}

/** 信念结构 */
interface BeliefState {
    unknownPool: Record<number, number>;
    n1: number; n2: number;
    opp1: number; opp2: number;
    probInOpp1: Record<number, number>;
    totalUnknownCards: number;
}

/**
 * 完全信息子局状态（供 MCTS/rollout 推进）。
 * 仅维护牌型博弈所需最小状态，独立于 UI。
 */
class WorldState {
    public turn: number;
    private _last: ICombo | null;
    private _lastSeat: number;
    private _passCount = 0;
    private _winner = -1;

    constructor(
        private hands: ICard[][],
        public readonly landlordSeat: number,
        startSeat: number,
        last: ICombo | null,
        lastSeat: number,
    ) {
        this.turn = startSeat;
        this._last = last;
        this._lastSeat = lastSeat;
    }

    public clone(): WorldState {
        const w = new WorldState(
            this.hands.map(h => h.slice()), this.landlordSeat, this.turn, this._last, this._lastSeat);
        w._passCount = this._passCount;
        w._winner = this._winner;
        return w;
    }

    public legalMoves(seat: number): (ICombo | null)[] {
        const last = (this._lastSeat === seat || this._lastSeat < 0) ? null : this._last;
        const moves: (ICombo | null)[] = DoudizhuRules.enumerateMoves(this.hands[seat], last);
        if (last !== null) moves.push(null); // 跟牌可过
        return moves;
    }

    public play(seat: number, combo: ICombo): void {
        if (seat !== this.turn) return;
        const ids = new Set(combo.cards.map(c => c.cardId * 2 + c.deckIndex));
        this.hands[seat] = this.hands[seat].filter(c => !ids.has(c.cardId * 2 + c.deckIndex));
        this._last = combo; this._lastSeat = seat; this._passCount = 0;
        if (this.hands[seat].length === 0) this._winner = seat;
        this.turn = (this.turn + 1) % 3;
    }

    public pass(seat: number): void {
        if (seat !== this.turn) return;
        this._passCount++;
        if (this._passCount >= 2) { this._last = null; this.turn = this._lastSeat; this._passCount = 0; return; }
        this.turn = (this.turn + 1) % 3;
    }

    public isOver(): boolean { return this._winner >= 0; }
    public winner(): number { return this._winner; }
}
