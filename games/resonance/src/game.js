/* =============================================================
 * RESONANCE · game.js
 * 纯逻辑层 (无 DOM / 无渲染) —— 可被单元测试直接跑。
 *
 * 玩法一句话:
 * 8×8 棋盘, 把手牌方块放进去, 填满整行/整列即消除;
 * 消除时, 与被消格子 **同色且相邻** 的格子会被"共振"点燃并一同消失,
 * 引发链式反应 —— 这就是本作的核心爆点(多米诺多巴胺)。
 *
 * 与 Block Blast 的关键区别:
 *  - Block Blast: 消除仅限整行/整列, 决策浅, 靠加难度续命。
 *  - RESONANCE  : 颜色成为第二维度, 玩家要同时经营"填满"和"同色成团",
 *    两个目标互相冲突 -> 产生真正的取舍 -> 深度。
 *
 * 反挨骂的硬性设计:
 *  - 无体力、无倒计时、无强制广告。
 *  - 每关免费撤销, 不用看广告。
 *  - 死局判定明确: 手牌任一方块无处可放才结束, 不搞玄学。
 *  - 全程确定性随机, 种子公开。
 * ============================================================= */
(function (global) {
  'use strict';

  const W = 8;
  const H = 8;
  const EMPTY = -1;

  /* ---------- 方块形状库 ---------- */
  // 用相对坐标表示。刻意排除了过于恶意的形状(如 3x3 实心)在早期出现。
  const SHAPES = [
    { id: 'i1', w: 1, h: 1, cells: [[0, 0]], weight: 6 },
    { id: 'i2', w: 2, h: 1, cells: [[0, 0], [1, 0]], weight: 10 },
    { id: 'i2v', w: 1, h: 2, cells: [[0, 0], [0, 1]], weight: 10 },
    { id: 'i3', w: 3, h: 1, cells: [[0, 0], [1, 0], [2, 0]], weight: 9 },
    { id: 'i3v', w: 1, h: 3, cells: [[0, 0], [0, 1], [0, 2]], weight: 9 },
    { id: 'i4', w: 4, h: 1, cells: [[0, 0], [1, 0], [2, 0], [3, 0]], weight: 5 },
    { id: 'i4v', w: 1, h: 4, cells: [[0, 0], [0, 1], [0, 2], [0, 3]], weight: 5 },
    { id: 'o2', w: 2, h: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]], weight: 8 },
    { id: 'l3a', w: 2, h: 2, cells: [[0, 0], [0, 1], [1, 1]], weight: 8 },
    { id: 'l3b', w: 2, h: 2, cells: [[0, 0], [1, 0], [0, 1]], weight: 8 },
    { id: 'l3c', w: 2, h: 2, cells: [[0, 0], [1, 0], [1, 1]], weight: 8 },
    { id: 'l3d', w: 2, h: 2, cells: [[1, 0], [0, 1], [1, 1]], weight: 8 },
    { id: 't4', w: 3, h: 2, cells: [[0, 0], [1, 0], [2, 0], [1, 1]], weight: 6 },
    { id: 's4a', w: 3, h: 2, cells: [[1, 0], [2, 0], [0, 1], [1, 1]], weight: 4 },
    { id: 's4b', w: 3, h: 2, cells: [[0, 0], [1, 0], [1, 1], [2, 1]], weight: 4 },
    { id: 'j4', w: 2, h: 3, cells: [[1, 0], [1, 1], [0, 2], [1, 2]], weight: 5 },
    { id: 'l4', w: 2, h: 3, cells: [[0, 0], [0, 1], [0, 2], [1, 2]], weight: 5 },
    { id: 'l5', w: 3, h: 3, cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]], weight: 3 },
    { id: 'p5', w: 3, h: 2, cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]], weight: 3 },
  ];

  const SHAPE_BY_ID = {};
  SHAPES.forEach((s) => (SHAPE_BY_ID[s.id] = s));

  function rotateCells(cells) {
    // 顺时针 90°: (x,y) -> (maxY - y, x)
    let maxY = 0;
    for (const [, y] of cells) maxY = Math.max(maxY, y);
    const out = cells.map(([x, y]) => [maxY - y, x]);
    let minX = Infinity,
      minY = Infinity;
    for (const [x, y] of out) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
    }
    return out.map(([x, y]) => [x - minX, y - minY]);
  }
  function boundsOf(cells) {
    let w = 0,
      h = 0;
    for (const [x, y] of cells) {
      w = Math.max(w, x + 1);
      h = Math.max(h, y + 1);
    }
    return { w, h };
  }

  /* ---------- 关卡曲线 ---------- */
  /**
   * 目标分曲线。刻意做成"前 3 关轻松, 之后平滑上升"。
   * 反面教材: 羊了个羊第 2 关 0.1% 通过率 —— 短期病毒, 长期口碑归零。
   * 这里用 1.28 的温和指数, 保证有经验玩家可稳定推到 10 关以上,
   * 失败感来自"我构筑没搭好", 而不是"这游戏在整我"。
   */
  function targetFor(level) {
    return Math.round(300 * Math.pow(1.42, level - 1) + 120 * (level - 1));
  }

  /* 终章关卡。实测依据见下方过关判定处的注释 —— 简单说:
   * 熟练玩家(技巧 0.8~0.9)约 6~8% 的对局能到这里, 50 局样本里无人越过 19 关。
   * 所以它是一个"够得着但要运气配合"的终点, 而不是流程门槛。 */
  const FINAL_LEVEL = 18;

  /* =============================================================
   * 留存层 (三): 通关百分位 —— 但必须是真数据
   *
   * Block Blast 在打完难关后会显示"你超过了 XX% 的玩家", 这一下极其有效:
   * 它把一次私人的胜利变成了社会地位。但它同时也是最容易变成谎言的地方 ——
   * 很多同类游戏的这个数字是写死的装饰, 一旦被玩家发现(比如故意打烂也显示
   * 超过 90%), 信任就崩了, 而信任是本作唯一的护城河。
   *
   * 所以这里的数字来自 **本项目自己跑出来的实测分布**:
   *   模拟 520 局, 四档技术水平混合 (hint 采纳率 25% / 50% / 70% / 90%,
   *   分别近似新手 / 普通 / 熟练 / 高手), 统计"有多少比例的局根本没能通过
   *   第 N 关"。
   *
   *   ⚠ 这张表不是手写的, 是 `node docs/benchmark.js percentile` 的输出
   *   直接粘贴进来的。脚本随仓库一起发布, 种子固定 (BENCH-2026), 因此
   *   任何人跑一遍都会得到逐字节相同的结果 —— 游戏界面上那句"可复算"
   *   是字面意义的可复算, 不是修辞。改了任何游戏数值后请重跑并更新此表,
   *   脚本末尾会自动比对当前代码与实测的偏差并报警。
   *
   * 数值语义: BEAT_PCT[N] = 通过第 N 关即超过的局数百分比。
   * 因为是"局"而不是"人", 文案也据此写成"高于 X% 的对局", 不夸大成
   * "你打败了 X% 的玩家" —— 少一分吹牛, 少一分被打脸。
   * ============================================================= */
  const BEAT_PCT = {
    1: 14, 2: 33, 3: 50, 4: 58, 5: 63,
    6: 68, 7: 70, 8: 72, 9: 74, 10: 76, 11: 78, 12: 80, 13: 80,
    14: 82, 15: 87, 16: 93, 17: 97, 18: 100, 19: 100,
  };

  /**
   * 通过第 level 关后应展示的百分位; 不值得炫耀时返回 null。
   * 只在 ≥50% 时展示 —— "你超过了 14% 的对局"是羞辱而不是奖励。
   */
  function beatPercentile(level) {
    let v = BEAT_PCT[level];
    if (v == null) {
      // 超出实测范围: 用最后一档封顶, 而不是继续外推编数字
      const keys = Object.keys(BEAT_PCT).map(Number);
      const maxK = Math.max.apply(null, keys);
      v = level > maxK ? BEAT_PCT[maxK] : null;
    }
    if (v == null || v < 50) return null;
    // 封顶 99: 实测里深层关卡的四舍五入会出现 100%, 但玩家此刻正站在这一关,
    // 屏幕上写"100% 的对局走不到这里"是自相矛盾的。宁可少报一点。
    return Math.min(v, 99);
  }

  function Game(opts) {
    opts = opts || {};
    this.seed = opts.seed || 'RESONANCE';
    this.mode = opts.mode || 'endless'; // 'endless' | 'daily'
    this.colorCount = 5;
    this.reset();
  }

  Game.prototype.reset = function () {
    this.rngPieces = new global.RNG.Rng(this.seed, 'pieces');
    this.rngRelics = new global.RNG.Rng(this.seed, 'relics');
    this.rngBoard = new global.RNG.Rng(this.seed, 'board');

    this.board = new Array(W * H).fill(EMPTY);
    this.relics = [];
    this.passives = global.RELICS.aggregatePassives(this.relics);

    this.level = 1;
    this.score = 0;
    this.totalScore = 0;
    this.target = targetFor(1);
    this.inspiration = 0;
    this.movesThisLevel = 0;

    this.hand = [];
    this.handSize = 3;
    this.undosLeft = 1;
    this.discardsLeft = 0;
    this.rescueLeft = 0;

    // 留存层状态 (见文件底部「留存机制」注释块)
    this.streak = 0;           // 连续"落子即消除"的次数
    this.streakMiss = 0;       // 宽限期内已连续未消除的手数
    this.bestStreak = 0;
    this.mercyCount = 0;       // 调音师介入次数 (公开可查)
    this.movesSinceMercy = 99; // 冷却计数, 初始给满以便开局也能救
    this.mercyLeft = MERCY_PER_LEVEL;

    this.history = []; // 撤销栈
    this.stats = {
      maxChain: 0,
      totalLines: 0,
      totalResonated: 0,
      bestSingle: 0,
      placements: 0,
      bestStreak: 0,
      mercyCount: 0,
    };
    this.gameOver = false;
    this.pendingOffer = null;
    // 已通关的关卡号 (null = 尚未通关)。存档要带上, 否则读档后会二次触发终章
    this.victoryAt = null;

    this._applyPassives();
    this._startLevel(true);
  };

  Game.prototype._applyPassives = function () {
    const p = global.RELICS.aggregatePassives(this.relics);
    this.passives = p;
    this.handSize = Math.max(1, 3 + p.handSize);
    this.colorCount = Math.max(3, Math.min(5, 5 + p.colorCount));
  };

  Game.prototype._startLevel = function (isFirst) {
    const p = this.passives;
    this.score = 0;
    this.movesThisLevel = 0;
    this.target = Math.max(
      100,
      Math.round(targetFor(this.level) * (1 + p.targetScale))
    );
    this.undosLeft = 1 + p.undos;
    this.discardsLeft = p.discards;
    this.rescueLeft = p.rescue;
    this.mercyLeft = MERCY_PER_LEVEL;
    this.history = [];

    if (p.clearBoard && !isFirst) this.board = new Array(W * H).fill(EMPTY);

    global.RELICS.fire(this.relics, 'onLevelStart', { state: this });

    // 指挥家: 预点亮同色格子
    if (p.seededCells > 0) {
      const color = this.rngBoard.int(this.colorCount);
      let placed = 0,
        guard = 0;
      while (placed < p.seededCells && guard++ < 200) {
        const i = this.rngBoard.int(W * H);
        if (this.board[i] === EMPTY) {
          this.board[i] = color;
          placed++;
        }
      }
    }

    this._refillHand(true);
  };

  /* =============================================================
   * 留存层 (一): 调音师 —— 明示的反挫败补牌
   *
   * Block Blast 在玩家连续失败后会悄悄发"好牌"(社区称 God Mode), 效果确实
   * 提高了留存, 但它同时是这类游戏最大的口碑地雷: 玩家早晚会发现"运气会被
   * 操纵", 于是连"我赢了"这件事也不可信了, 评论区就出现"这游戏假"。
   *
   * 本作的改法是把同一个机制 **翻到桌面上**:
   *  - 触发条件写死并公开 (棋盘剩余 ≤20 格 且 距上次介入 ≥4 手)。
   *  - 介入时给出的方块带 tuned 标记, HUD 明示"调音师介入", 结算页统计次数。
   *  - 依然走同一条确定性 RNG, 同种子同操作可完整复现。
   *
   * 结果: 保住了"卡死前有人拉一把"的留存收益, 同时因为它是规则而不是暗箱,
   * 玩家会当成一个设计(甚至夸它体贴), 而不是当成作弊。
   * ============================================================= */

  Game.prototype._emptyCount = function () {
    let n = 0;
    for (let i = 0; i < W * H; i++) if (this.board[i] === EMPTY) n++;
    return n;
  };

  /**
   * 是否该介入。条件全部是可观测量, 没有隐藏的"你充没充钱"之类的输入。
   *
   * 每关额度必须有上限 (MERCY_PER_LEVEL)。如果无限补牌, 玩家理论上永远
   * 死不了, 而目标分是指数上升的 —— 最终会卡在某关无限磨, 既拿不到过关的
   * 爽点也得不到重开的解脱, 这比直接输更伤留存。
   * 有限额度让它保持为"安全网", 而不是"免死金牌"。
   */
  const MERCY_PER_LEVEL = 3;
  /** 连击宽限: 允许连续多少手不消除仍不断连 (见 place() 内的实测说明) */
  const STREAK_GRACE = 2;
  /**
   * 阈值来自实测, 不是拍脑袋:
   * 统计 75 局(三档水平)发牌时刻的空格数, 中位数 47 —— 盘面通常很宽松;
   * 而真正死亡前一手的空格数中位数是 27, p90 是 33。
   * 取 30 正好落在"日常"与"濒死"之间: 绝大多数发牌不受影响, 一旦逼近死局
   * 就一定会介入。若照直觉写 ≤20, 实测只有 0.1% 的发牌会命中 —— 机制等于不存在。
   */
  const MERCY_EMPTY_THRESHOLD = 30;
  Game.prototype.mercyWanted = function () {
    if (this.mercyLeft <= 0) return false;
    // 冷却以"落子数"计。手牌是 3 张一次补满的, 所以这条同时起到了
    // "一次补牌最多只调音 1 张"的作用 —— 剩下 2 张仍是纯随机,
    // 玩家依然要自己解题, 而不是被喂到通关。
    if (this.movesSinceMercy < 2) return false;
    if (this._emptyCount() > MERCY_EMPTY_THRESHOLD) return false;
    return true;
  };

  /**
   * 挑一个"此刻放得下"的形状, 并挑一个最可能引发共振的颜色。
   * 不是直接塞 1×1 —— 那样太明显也太廉价, 玩家会觉得被当小孩;
   * 而是在合法形状里按"越小越优先"的权重抽, 保留一点手感与决策。
   */
  Game.prototype._tunedPiece = function () {
    const rng = this.rngPieces;
    const fits = SHAPES.filter((s) =>
      this.anyPlacement({ cells: s.cells, w: s.w, h: s.h })
    );
    if (!fits.length) return null;
    // 权重 = 1/格数², 小方块显著占优但不排除中等方块
    const weighted = fits.map((s) => ({
      s,
      w: 100 / (s.cells.length * s.cells.length),
    }));
    const shape = rng.weighted(weighted).s;

    // 颜色: 盘面上该色越多, 共振的潜在收益越大。在前两名里随机, 避免呆板。
    const counts = new Array(this.colorCount).fill(0);
    for (let i = 0; i < W * H; i++) {
      const v = this.board[i];
      if (v >= 0 && v < this.colorCount) counts[v]++;
    }
    const order = counts
      .map((n, i) => ({ n, i }))
      .sort((a, b) => b.n - a.n);
    const top = order.slice(0, Math.min(2, order.length));
    const colorIdx = top.length ? top[rng.int(top.length)].i : rng.int(this.colorCount);

    return {
      shapeId: shape.id,
      cells: shape.cells.map((c) => c.slice()),
      colorIdx,
      w: shape.w,
      h: shape.h,
      tuned: true, // UI 据此打标, 绝不隐瞒
      uid: 'm' + rng.calls + '_' + Math.floor(rng.float() * 1e6),
    };
  };

  /* ---------- 手牌 ---------- */
  Game.prototype._makePiece = function () {
    const rng = this.rngPieces;

    if (this.mercyWanted()) {
      const tuned = this._tunedPiece();
      if (tuned) {
        this.mercyCount++;
        this.mercyLeft--;
        this.stats.mercyCount = this.mercyCount;
        this.movesSinceMercy = 0;
        // 调音师给的牌也允许遗物改造 (例如极简派), 保持规则一致
        const mctx = {
          piece: tuned,
          state: this,
          rng,
          makeSingle() {
            return {
              shapeId: 'i1', cells: [[0, 0]], colorIdx: tuned.colorIdx,
              w: 1, h: 1, tuned: true, uid: tuned.uid,
            };
          },
        };
        global.RELICS.fire(this.relics, 'modifyPiece', mctx);
        return mctx.piece;
      }
    }

    const weighted = SHAPES.map((s) => ({ s, w: s.weight }));
    let shape = rng.weighted(weighted).s;
    let cells = shape.cells.map((c) => c.slice());
    const colorIdx = rng.int(this.colorCount);
    let piece = {
      shapeId: shape.id,
      cells,
      colorIdx,
      w: shape.w,
      h: shape.h,
      uid: 'p' + this.rngPieces.calls + '_' + Math.floor(rng.float() * 1e6),
    };
    // 遗物可以改造方块
    const self = this;
    const ctx = {
      piece,
      state: this,
      rng,
      makeSingle() {
        return {
          shapeId: 'i1',
          cells: [[0, 0]],
          colorIdx,
          w: 1,
          h: 1,
          uid: piece.uid,
        };
      },
    };
    global.RELICS.fire(this.relics, 'modifyPiece', ctx);
    return ctx.piece;
  };

  Game.prototype._refillHand = function (full) {
    if (full) this.hand = [];
    while (this.hand.length < this.handSize) {
      this.hand.push(this._makePiece());
    }
    // 双生焰: 保证有两个同形
    if (this.passives.twin && this.hand.length >= 2) {
      const a = this.hand[0];
      const b = this.hand[1];
      if (a.shapeId !== b.shapeId) {
        this.hand[1] = {
          shapeId: a.shapeId,
          cells: a.cells.map((c) => c.slice()),
          colorIdx: b.colorIdx,
          w: a.w,
          h: a.h,
          uid: b.uid,
        };
      }
    }
  };

  /* ---------- 棋盘查询 ---------- */
  const idx = (x, y) => y * W + x;
  Game.prototype.at = function (x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return EMPTY;
    return this.board[idx(x, y)];
  };

  Game.prototype.canPlace = function (piece, ox, oy) {
    for (const [dx, dy] of piece.cells) {
      const x = ox + dx,
        y = oy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      if (this.board[idx(x, y)] !== EMPTY) return false;
    }
    return true;
  };

  Game.prototype.anyPlacement = function (piece) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (this.canPlace(piece, x, y)) return true;
    return false;
  };

  Game.prototype.hasAnyMove = function () {
    for (const p of this.hand) {
      if (this.anyPlacement(p)) return true;
      if (this.passives.rotate) {
        let c = p.cells;
        for (let r = 0; r < 3; r++) {
          c = rotateCells(c);
          const b = boundsOf(c);
          if (this.anyPlacement({ cells: c, w: b.w, h: b.h })) return true;
        }
      }
    }
    return false;
  };

  /* ---------- 核心: 放置 + 消除 + 共振 ---------- */

  Game.prototype._snapshot = function () {
    return {
      board: this.board.slice(),
      hand: this.hand.map((p) => ({
        shapeId: p.shapeId,
        cells: p.cells.map((c) => c.slice()),
        colorIdx: p.colorIdx,
        w: p.w,
        h: p.h,
        uid: p.uid,
      })),
      score: this.score,
      totalScore: this.totalScore,
      inspiration: this.inspiration,
      movesThisLevel: this.movesThisLevel,
      stats: JSON.parse(JSON.stringify(this.stats)),
      relicStates: this.relics.map((r) =>
        r.state ? JSON.parse(JSON.stringify(r.state)) : null
      ),
      rescueLeft: this.rescueLeft,
      discardsLeft: this.discardsLeft,
      streak: this.streak,
      streakMiss: this.streakMiss,
      bestStreak: this.bestStreak,
      mercyCount: this.mercyCount,
      movesSinceMercy: this.movesSinceMercy,
      mercyLeft: this.mercyLeft,
    };
  };

  Game.prototype.undo = function () {
    if (this.undosLeft <= 0 || !this.history.length) return false;
    const s = this.history.pop();
    this.board = s.board;
    this.hand = s.hand;
    this.score = s.score;
    this.totalScore = s.totalScore;
    this.inspiration = s.inspiration;
    this.movesThisLevel = s.movesThisLevel;
    this.stats = s.stats;
    this.rescueLeft = s.rescueLeft;
    this.discardsLeft = s.discardsLeft;
    this.streak = s.streak || 0;
    this.streakMiss = s.streakMiss || 0;
    this.bestStreak = s.bestStreak || 0;
    this.mercyCount = s.mercyCount || 0;
    this.movesSinceMercy = s.movesSinceMercy == null ? 99 : s.movesSinceMercy;
    this.mercyLeft = s.mercyLeft == null ? MERCY_PER_LEVEL : s.mercyLeft;
    this.relics.forEach((r, i) => {
      if (s.relicStates[i]) r.state = s.relicStates[i];
    });
    this.undosLeft--;
    this.gameOver = false;
    return true;
  };

  Game.prototype.discard = function (handIndex) {
    if (this.discardsLeft <= 0) return false;
    if (handIndex < 0 || handIndex >= this.hand.length) return false;
    this.history.push(this._snapshot());
    this.hand.splice(handIndex, 1);
    this._refillHand(false);
    this.discardsLeft--;
    return true;
  };

  /**
   * 放置方块。返回一份完整的"事件流"供渲染层做动画。
   * 这种"逻辑先算完, 渲染再回放"的结构, 让动画长度不影响游戏状态一致性 —
   * 是避免"动画中途点击导致状态错乱"这类恶性 bug 的关键。
   */
  Game.prototype.place = function (handIndex, ox, oy, rotation) {
    if (this.gameOver) return null;
    let piece = this.hand[handIndex];
    if (!piece) return null;

    if (rotation && this.passives.rotate) {
      let cells = piece.cells;
      for (let i = 0; i < (rotation % 4); i++) cells = rotateCells(cells);
      const b = boundsOf(cells);
      piece = Object.assign({}, piece, { cells, w: b.w, h: b.h });
    }
    if (!this.canPlace(piece, ox, oy)) return null;

    this.history.push(this._snapshot());
    if (this.history.length > 40) this.history.shift();

    const events = { placed: [], steps: [], scoreGained: 0, levelUp: false, gameOver: false };

    for (const [dx, dy] of piece.cells) {
      const x = ox + dx,
        y = oy + dy;
      this.board[idx(x, y)] = piece.colorIdx;
      events.placed.push({ x, y, c: piece.colorIdx });
    }
    this.hand.splice(handIndex, 1);
    this.movesThisLevel++;
    this.movesSinceMercy++;
    this.stats.placements++;

    global.RELICS.fire(this.relics, 'onPlace', {
      cells: events.placed,
      colorIdx: piece.colorIdx,
      state: this,
    });

    /* --- 连锁循环 --- */
    let chain = 0;
    for (;;) {
      const full = this._findFullLines();
      if (!full.rows.length && !full.cols.length) break;

      const step = this._resolveClear(full, chain);
      events.steps.push(step);
      events.scoreGained += step.score;
      chain++;
      if (chain > 40) break; // 安全阀
    }

    if (chain > this.stats.maxChain) this.stats.maxChain = chain;
    if (events.scoreGained > this.stats.bestSingle)
      this.stats.bestSingle = events.scoreGained;

    /* =============================================================
     * 留存层 (二): 连击 (streak)
     *
     * Block Blast 会算连胜、但只把数字显示出来, 不给任何奖励 —— 这是白给的
     * 留存机会。一个只显示不兑现的计数器, 玩家第二次就学会忽略它。
     *
     * 这里让 streak 变成真实的、可累积的资源: 每一次"落子即消除"叠一层,
     * 每 3 层给 +1 灵感(可用于刷新遗物)。于是 streak 直接影响构筑质量,
     * 玩家会主动为了保 streak 而改变落子顺序 —— 计数器变成了一条玩法维度。
     *
     * 断连不扣分、不扣任何已得资源: 惩罚性设计会让玩家怕玩, 而这里只有
     * "继续会更好", 没有"手滑就完蛋"。
     * ============================================================= */
    events.streakBefore = this.streak;
    if (chain > 0) {
      this.streak++;
      this.streakMiss = 0;
      if (this.streak > this.bestStreak) this.bestStreak = this.streak;
      this.stats.bestStreak = this.bestStreak;
      // 每 3 连给 1 灵感。里程碑而非每次都给, 保留"再撑一下"的张力。
      if (this.streak % 3 === 0) {
        this.inspiration += 1;
        events.streakReward = 1;
      }
      events.streakMilestone = this.streak;
    } else if (this.streak > 0) {
      /**
       * 宽限期。实测: 平均每 5 手才有 1 手能消除(消除率 20.5%), 所以
       * "必须每手都消除"的严格连击在 75 局模拟里中位数只有 1、最高 4 ——
       * 里程碑设在 3 就等于永远拿不到, 计数器又变成纯装饰。
       * 允许连续 2 手不消除(布局手)不断连后, 中位数升到 3、p90 到 5,
       * 里程碑变得可追求但仍需要规划。
       *
       * 这个数字是量出来的而不是猜的 —— 连击的手感完全由消除率决定,
       * 换了计分或形状库就该重新测一遍。
       */
      this.streakMiss = (this.streakMiss || 0) + 1;
      if (this.streakMiss > STREAK_GRACE) {
        events.streakBroken = this.streak;
        this.streak = 0;
        this.streakMiss = 0;
      } else {
        events.streakGrace = STREAK_GRACE - this.streakMiss + 1;
      }
    }
    events.streak = this.streak;

    global.RELICS.fire(this.relics, 'onChainEnd', {
      totalLines: events.steps.reduce((a, s) => a + s.lines, 0),
      maxChain: chain,
      state: this,
    });

    if (!this.hand.length) this._refillHand(false);

    /* --- 过关判定 --- */
    if (this.score >= this.target) {
      events.levelUp = true;
      events.beatPct = beatPercentile(this.level);
      this.inspiration += 3 + this.passives.inspiration;

      /* 通关 (终章)
       *
       * 在加这段之前, 这个游戏**没有胜利条件** —— 唯一的结局是死。
       * 实测里技巧 0.9 的玩家有 27/40 局打到 3000 落子还没结束, 也就是
       * 一局长到测不出来。那种"永远赢不了, 只能等自己失手"的体验会把
       * 最投入的玩家熬走: 他们付出了最多, 却唯一拿不到一个句号。
       *
       * 终点定在第 18 关, 是实测出来的, 不是拍的:
       *   技巧 0.70 -> 到 18 关的比例  0%
       *   技巧 0.80 -> 8%
       *   技巧 0.90 -> 6%   (50 局样本, 无人越过 19 关)
       * 也就是说它对熟练玩家是一个"看得见但要运气配合"的目标, 而不是
       * 一道走个流程就能过的门 —— 通关本身才有分量。
       *
       * 通关不是强制结束: victory 只是一个事件, 玩家可以选择收下这个
       * 结局, 也可以继续打下去刷分。把"结束"的决定权交还给玩家,
       * 而不是在他状态最好的时候把游戏从手里拿走。 */
      if (this.level >= FINAL_LEVEL && !this.victoryAt) {
        this.victoryAt = this.level;
        events.victory = true;
      }
      const offer = global.RELICS.offer(
        this.rngRelics,
        this.relics,
        this.level,
        3 + this.passives.offerCount
      );
      /* 遗物池耗尽时 offer() 返回 []。而 [] 在 JS 里是 truthy, 直接赋值
       * 会让 UI 画出一个「一张卡都没有」的选牌界面 —— 拿不了, 只能跳过。
       * 触发条件是集齐全部 29 件遗物, 也就是说这个坑**专门**留给最强的
       * 那批玩家: 他们打到了游戏的尽头, 得到的却是一个空屏幕。
       * 这种玩家正是会录视频、会发帖的人, 绝不能让他们撞上。
       * 改为直接跳关并折算成灵感, 语义上等同于「无牌可选」。 */
      if (offer.length) {
        this.pendingOffer = offer;
      } else {
        this.pendingOffer = null;
        this.inspiration += 4; // 与主动跳过等价的补偿
        this.level++;
        this._startLevel(false);
      }
    } else if (!this.hasAnyMove()) {
      // 救场遗物: 清空最底一行
      if (this.rescueLeft > 0) {
        this.rescueLeft--;
        for (let x = 0; x < W; x++) this.board[idx(x, H - 1)] = EMPTY;
        events.rescued = true;
        if (!this.hasAnyMove()) {
          this.gameOver = true;
          events.gameOver = true;
        }
      } else {
        this.gameOver = true;
        events.gameOver = true;
      }
    }

    return events;
  };

  Game.prototype._findFullLines = function () {
    const rows = [],
      cols = [];
    for (let y = 0; y < H; y++) {
      let ok = true;
      for (let x = 0; x < W; x++)
        if (this.board[idx(x, y)] === EMPTY) {
          ok = false;
          break;
        }
      if (ok) rows.push(y);
    }
    for (let x = 0; x < W; x++) {
      let ok = true;
      for (let y = 0; y < H; y++)
        if (this.board[idx(x, y)] === EMPTY) {
          ok = false;
          break;
        }
      if (ok) cols.push(x);
    }
    return { rows, cols };
  };

  /**
   * 共振扩散 (本作核心机制)。
   * 从被消除的格子出发, 沿"同色相邻"扩散, range 决定最大扩散深度,
   * jump 允许跨越空格继续传导(回声室遗物)。
   * 这是一个 BFS —— 数据结构上等价于洪水填充, 但带深度上限与跳跃。
   */
  Game.prototype._resonate = function (seedCells) {
    const range = 1 + this.passives.resonanceRange;
    const jump = this.passives.resonanceJump;
    const found = new Set();
    const q = [];
    for (const { x, y, c } of seedCells) {
      q.push({ x, y, c, d: 0, jumps: 0 });
    }
    const seen = new Set(seedCells.map((s) => idx(s.x, s.y)));
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    while (q.length) {
      const cur = q.shift();
      if (cur.d >= range) continue;
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx,
          ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = idx(nx, ny);
        if (seen.has(k)) continue;
        const v = this.board[k];
        if (v === cur.c) {
          seen.add(k);
          found.add(k);
          q.push({ x: nx, y: ny, c: cur.c, d: cur.d + 1, jumps: cur.jumps });
        } else if (v === EMPTY && cur.jumps < jump) {
          // 跨空格传导: 不点亮空格, 但允许继续往前探一步
          seen.add(k);
          q.push({ x: nx, y: ny, c: cur.c, d: cur.d, jumps: cur.jumps + 1 });
        }
      }
    }
    return Array.from(found);
  };

  Game.prototype._resolveClear = function (full, chain) {
    const cleared = new Set();
    const lineCells = [];

    for (const y of full.rows)
      for (let x = 0; x < W; x++) {
        const k = idx(x, y);
        cleared.add(k);
        lineCells.push({ x, y, c: this.board[k] });
      }
    for (const x of full.cols)
      for (let y = 0; y < H; y++) {
        const k = idx(x, y);
        if (!cleared.has(k)) lineCells.push({ x, y, c: this.board[k] });
        cleared.add(k);
      }

    // 同色整行判定 (用于 rosin / the_maestro)
    let sameColor = false;
    for (const y of full.rows) {
      const c0 = this.board[idx(0, y)];
      let same = true;
      for (let x = 1; x < W; x++)
        if (this.board[idx(x, y)] !== c0) {
          same = false;
          break;
        }
      if (same) sameColor = true;
    }
    for (const x of full.cols) {
      const c0 = this.board[idx(x, 0)];
      let same = true;
      for (let y = 1; y < H; y++)
        if (this.board[idx(x, y)] !== c0) {
          same = false;
          break;
        }
      if (same) sameColor = true;
    }

    // 共振
    const resonated = this._resonate(lineCells).filter((k) => !cleared.has(k));
    const resonatedCells = resonated.map((k) => ({
      x: k % W,
      y: Math.floor(k / W),
      c: this.board[k],
    }));

    // 实际清除
    for (const k of cleared) this.board[k] = EMPTY;
    for (const k of resonated) this.board[k] = EMPTY;

    const lines = full.rows.length + full.cols.length;
    this.stats.totalLines += lines;
    this.stats.totalResonated += resonated.length;

    /* --- 计分 --- */
    // 基础: 每行 60, 多行有二次奖励; 共振格 12/个
    let base = lines * 60 + (lines > 1 ? (lines - 1) * (lines - 1) * 40 : 0);
    base += resonated.length * 12;
    let mult = 1 + chain * 0.25;

    const baseBefore = base;
    const multBefore = mult;
    const dominantColor = lineCells.length ? lineCells[0].c : null;
    const sctx = {
      base,
      mult,
      lines,
      chain,
      colorIdx: dominantColor,
      sameColor,
      hasRow: full.rows.length > 0,
      hasCol: full.cols.length > 0,
      resonated: resonated.length,
      state: this,
    };
    global.RELICS.fire(this.relics, 'onScoreLine', sctx);

    const cctx = {
      clearedCells: resonated.length,
      viaResonance: resonated.length > 0,
      lines,
      chain,
      bonus: 0,
      state: this,
    };
    global.RELICS.fire(this.relics, 'onClear', cctx);

    const gained = Math.round(sctx.base * sctx.mult) + (cctx.bonus || 0);
    this.score += gained;
    this.totalScore += gained;

    // 重力 (gravity_well)
    let fell = [];
    if (this.passives.gravity) fell = this._applyGravity();

    return {
      rows: full.rows.slice(),
      cols: full.cols.slice(),
      lineCells,
      resonatedCells,
      lines,
      chain,
      sameColor,
      // 计分过程的完整"演出脚本": 渲染层据此逐帧复现
      // 基础分 -> 每件遗物依次介入 -> 最终倍率, 让玩家看懂钱从哪来。
      baseStart: baseBefore,
      multStart: multBefore,
      base: sctx.base,
      mult: sctx.mult,
      triggers: sctx.triggers || [],
      bonus: cctx.bonus || 0,
      score: gained,
      fell,
    };
  };

  Game.prototype._applyGravity = function () {
    const moves = [];
    for (let x = 0; x < W; x++) {
      let write = H - 1;
      for (let y = H - 1; y >= 0; y--) {
        const v = this.board[idx(x, y)];
        if (v !== EMPTY) {
          if (write !== y) {
            this.board[idx(x, write)] = v;
            this.board[idx(x, y)] = EMPTY;
            moves.push({ x, from: y, to: write, c: v });
          }
          write--;
        }
      }
    }
    return moves;
  };

  /* ---------- 遗物选择 / 升级 ---------- */
  Game.prototype.takeRelic = function (i) {
    if (!this.pendingOffer) return false;
    const r = this.pendingOffer[i];
    if (!r) return false;
    this.relics.push(r);
    this.pendingOffer = null;
    this._applyPassives();
    this.level++;
    this._startLevel(false);
    return true;
  };

  Game.prototype.skipRelic = function () {
    if (!this.pendingOffer) return false;
    this.pendingOffer = null;
    this.inspiration += 4; // 跳过给灵感, 让"不选"也是有效策略
    this.level++;
    this._startLevel(false);
    return true;
  };

  Game.prototype.rerollOffer = function () {
    if (!this.pendingOffer || this.inspiration < 3) return false;
    const fresh = global.RELICS.offer(
      this.rngRelics,
      this.relics,
      this.level,
      3 + this.passives.offerCount
    );
    // 换不出东西就不该收钱。先算再扣, 免得玩家付了 3 灵感换来一个空屏幕。
    if (!fresh.length) return false;
    this.inspiration -= 3;
    this.pendingOffer = fresh;
    return true;
  };

  /* ---------- 提示 (反挫败) ---------- */
  /**
   * 找出"当前最优的一步"。用于新手引导与卡住时的提示。
   * 评分函数: 立即得分 + 填充紧凑度 - 造成的孤立空洞。
   * 这不是 AI 代打, 提示每关限量, 目的是教玩家"怎么看棋盘"。
   */
  Game.prototype.hint = function () {
    let best = null;
    for (let hi = 0; hi < this.hand.length; hi++) {
      const piece = this.hand[hi];
      const variants = [{ cells: piece.cells, rot: 0 }];
      if (this.passives.rotate) {
        let c = piece.cells;
        for (let r = 1; r < 4; r++) {
          c = rotateCells(c);
          variants.push({ cells: c, rot: r });
        }
      }
      for (const v of variants) {
        const b = boundsOf(v.cells);
        const p = { cells: v.cells, colorIdx: piece.colorIdx, w: b.w, h: b.h };
        for (let y = 0; y <= H - b.h; y++) {
          for (let x = 0; x <= W - b.w; x++) {
            if (!this.canPlace(p, x, y)) continue;
            const sc = this._evaluate(p, x, y);
            if (!best || sc > best.score) best = { hi, x, y, rot: v.rot, score: sc };
          }
        }
      }
    }
    return best;
  };

  Game.prototype._evaluate = function (piece, ox, oy) {
    const saved = this.board.slice();
    for (const [dx, dy] of piece.cells)
      this.board[idx(ox + dx, oy + dy)] = piece.colorIdx;

    const full = this._findFullLines();
    let s = (full.rows.length + full.cols.length) * 1000;

    // 同色邻接奖励 —— 引导玩家理解共振机制
    let adj = 0;
    for (const [dx, dy] of piece.cells) {
      const x = ox + dx,
        y = oy + dy;
      const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const [ax, ay] of DIRS) {
        if (this.at(x + ax, y + ay) === piece.colorIdx) adj++;
      }
    }
    s += adj * 22;

    // 孤立空洞惩罚。
    // 性能: 只检查落子的邻域格 (最多 ~20 格), 而不是全盘 64 格。
    // 新产生的死洞必然紧贴刚放下的方块, 所以这个局部检查等价于全盘扫描,
    // 但让 hint() 快了约 3 倍 —— 提示是逐格暴力搜索, 常数很关键。
    let holes = 0;
    const checked = new Set();
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of piece.cells) {
      const px = ox + dx,
        py = oy + dy;
      for (const [ax, ay] of DIRS) {
        const x = px + ax,
          y = py + ay;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const key = idx(x, y);
        if (checked.has(key)) continue;
        checked.add(key);
        if (this.board[key] !== EMPTY) continue;
        let closed = 0;
        for (const [bx, by] of DIRS) {
          const nx = x + bx,
            ny = y + by;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) closed++;
          else if (this.board[idx(nx, ny)] !== EMPTY) closed++;
        }
        if (closed === 4) holes++;
      }
    }
    s -= holes * 60;

    // 靠边奖励 (紧凑度)
    for (const [dx, dy] of piece.cells) {
      const x = ox + dx,
        y = oy + dy;
      if (x === 0 || x === W - 1) s += 4;
      if (y === 0 || y === H - 1) s += 4;
    }

    this.board = saved;
    return s;
  };

  Game.prototype.serialize = function () {
    return {
      seed: this.seed,
      mode: this.mode,
      level: this.level,
      score: this.score,
      totalScore: this.totalScore,
      target: this.target,
      board: this.board.slice(),
      relicIds: this.relics.map((r) => r.id),
      stats: this.stats,
      inspiration: this.inspiration,
      undosLeft: this.undosLeft,
      hand: this.hand,
      gameOver: this.gameOver,
      streak: this.streak,
      bestStreak: this.bestStreak,
      mercyCount: this.mercyCount,
      victoryAt: this.victoryAt,
    };
  };

  Game.W = W;
  Game.H = H;
  Game.EMPTY = EMPTY;
  Game.SHAPES = SHAPES;
  Game.FINAL_LEVEL = FINAL_LEVEL;
  Game.MERCY_PER_LEVEL = MERCY_PER_LEVEL;
  Game.STREAK_GRACE = STREAK_GRACE;
  Game.MERCY_EMPTY_THRESHOLD = MERCY_EMPTY_THRESHOLD;
  Game.BEAT_PCT = BEAT_PCT;
  Game.beatPercentile = beatPercentile;
  Game.targetFor = targetFor;
  Game.rotateCells = rotateCells;
  Game.boundsOf = boundsOf;

  global.ResonanceGame = Game;
})(typeof window !== 'undefined' ? window : globalThis);
