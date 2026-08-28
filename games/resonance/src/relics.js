/* =============================================================
 * RESONANCE · relics.js
 * 遗物(Relic)系统 —— 本作的"深度层"。
 *
 * 为什么需要它:
 * 纯消除游戏(Block Blast / 羊了个羊)的问题是 **决策空间在 30 分钟后耗尽**,
 * 玩家只能靠"更难的关卡"续命, 于是被迫做卡关+强制广告, 于是被骂。
 * Balatro 证明了另一条路: 用"可组合的构筑物"制造指数级的策略空间,
 * 玩家自己会创造出开发者没设计过的骚操作, 然后主动截图传播。
 *
 * 设计约束(反挨骂):
 *  1. 每件遗物都是 **纯增益**, 没有"负面遗物"骗你选。
 *  2. 效果全部写在卡面上, 不藏隐藏乘区。
 *  3. 三选一, 且必有一件"当前构筑相关"的, 减少空 pick 的挫败。
 *  4. 遗物之间刻意留了 combo 通路(见 SYNERGY 注释), 让"我发现了!"发生。
 *
 * 生效方式: 事件钩子。引擎在关键时刻广播事件, 遗物修改一个 ctx 对象。
 *
 * ---------------------------------------------------------------
 * 关于 flavor 字段(卡面底部那行小字)的硬规矩
 *
 * 每条 flavor 必须是 **可查证的真实音乐史事实**, 并且这个事实要与该遗物的
 * 机制同构。反例(本作最初的写法)是"让共鸣充满整个空间"这类空转形容词 ——
 * 它没有信息量, 读起来就是机器生成的, 玩家会直接跳过。
 *
 * 学的是 Balatro 的 Gros Michel / Cavendish: 两张卡讲的是"1950 年代大米七
 * 香蕉被真菌灭绝、香牙蕉接替它"这件真事, 于是机制(会消失/替代品)不需要
 * 解释就记住了。典故承担了记忆锚点的职责, 认知负担反而更低。
 *
 * 具体到本作:
 *   共鸣箱  -> 西塔琴的共鸣弦(不弹自响)   = 共振机制本身
 *   纯五度  -> 3:2 频率比与毕达哥拉斯音差 = "第 5 段连锁"的 5
 *   休止符  -> 凯奇《4分33秒》            = 丢弃(不出手)也是一种出手
 *   备用琴弦-> 帕格尼尼断弦仍演奏         = 少一根弦不等于结束
 * 机制与典故互为助记, 而不是各说各话。
 *
 * 新增遗物时若想不出真实典故, 宁可把 flavor 留空, 也不要编一句漂亮空话。
 * ============================================================= */
(function (global) {
  'use strict';

  /**
   * 钩子说明:
   *  onScoreLine(ctx)   ctx = {base, mult, lines, chain, colorIdx, sameColor, state}
   *  onPlace(ctx)       ctx = {cells, colorIdx, state}
   *  onClear(ctx)       ctx = {clearedCells, lines, chain, state}
   *  onLevelStart(ctx)  ctx = {state}
   *  onChainEnd(ctx)    ctx = {totalLines, maxChain, state}
   *  modifyPiece(ctx)   ctx = {piece, state}
   *
   * 每个遗物可选实现任意钩子。tier: 1 常见 / 2 稀有 / 3 传说
   */
  const RELICS = [
    /* ---------- 基础加成 (tier 1) ---------- */
    {
      id: 'tuning_fork',
      name: '音叉',
      icon: '🎵',
      tier: 1,
      desc: '每消除 1 行，基础分 +8。',
      flavor: '1711 年由亨德尔的小号手约翰·肖尔发明。它只给一个音，但整个乐队从此有了共同的起点。',
      onScoreLine(c) {
        c.base += 8;
      },
    },
    {
      id: 'metronome',
      name: '节拍器',
      icon: '⏱️',
      tier: 1,
      desc: '连锁第 2 段及之后，倍率 +0.3。',
      flavor: '1815 年梅尔策尔取得专利。贝多芬是第一位在谱上标注节拍机速度的大作曲家 —— 从此"快"有了数字。',
      onScoreLine(c) {
        if (c.chain >= 1) c.mult += 0.3;
      },
    },
    {
      id: 'rosin',
      name: '松香',
      icon: '🟫',
      tier: 1,
      desc: '同色整行消除时，额外 +25 分。',
      flavor: '松树的凝脂。不擦松香，马尾弓毛会从琴弦上无声滑过 —— 一分钱的东西，决定了有没有声音。',
      onScoreLine(c) {
        if (c.sameColor) c.base += 25;
      },
    },
    {
      id: 'sustain_pedal',
      name: '延音踏板',
      icon: '🦶',
      tier: 1,
      desc: '共振范围 +1 格（更容易连锁）。',
      flavor: '踩下它，所有制音器同时抬起：你按的那一个音，会让全琴 230 根弦一起颤动。',
      passive: { resonanceRange: 1 },
    },
    {
      id: 'spare_string',
      name: '备用琴弦',
      icon: '🪡',
      tier: 1,
      desc: '每关额外获得 1 次撤销。',
      flavor: '帕格尼尼当众断弦仍不停手，索性写了只用 G 弦演奏的《摩西幻想曲》—— 少一根弦，多一个传说。',
      passive: { undos: 1 },
    },
    {
      id: 'wide_bow',
      name: '宽弓',
      icon: '🏹',
      tier: 1,
      desc: '手牌槽位 +1（同时可见 4 个方块）。',
      flavor: '1785 年前后图特确立了现代弓形：更长、张力更大。琴没变，能拉出的句子变长了。',
      passive: { handSize: 1 },
    },

    /* ---------- 乘区 (tier 2) ---------- */
    {
      id: 'harmonic_series',
      name: '泛音列',
      icon: '📈',
      tier: 2,
      multMode: 'x',
      desc: '一次消除 2 行以上时，倍率 ×1.5。',
      flavor: '一根弦振动时，同时在按 1:2:3:4 的整数比振动。所谓音色，就是这些泛音的配方。',
      onScoreLine(c) {
        if (c.lines >= 2) c.mult *= 1.5;
      },
    },
    {
      id: 'perfect_fifth',
      name: '纯五度',
      icon: '⑤',
      tier: 2,
      multMode: 'x',
      desc: '连锁达到 5 段时，本次得分 ×3。',
      flavor: '频率比 3:2，除八度外最协和的音程。但连叠十二个纯五度会比七个八度多出一点点 —— 那道缝隙叫毕达哥拉斯音差。',
      onScoreLine(c) {
        if (c.chain + 1 >= 5) c.mult *= 3;
      },
    },
    {
      id: 'crescendo',
      name: '渐强',
      icon: '🔺',
      tier: 2,
      desc: '本关每消除 1 行，永久累积 +2 基础分（关内叠加）。',
      flavor: '1750 年代曼海姆乐团首创全体渐强。据记载听众当场站起来 —— 在那之前，音乐只有"响"和"轻"两档。',
      state: { stack: 0 },
      onLevelStart(c) {
        this.state.stack = 0;
      },
      onScoreLine(c) {
        c.base += this.state.stack;
        this.state.stack += 2;
      },
      dyn() {
        return '当前 +' + this.state.stack;
      },
    },
    {
      id: 'sympathetic',
      name: '共鸣箱',
      icon: '📦',
      tier: 2,
      // SYNERGY: 与 sustain_pedal / echo_chamber 叠加可造出 10+ 连锁
      desc: '共振引爆的每个格子，额外 +6 分。',
      flavor: '西塔琴的琴颈下藏着一组不弹的弦。你弹主弦，它们自己响 —— 印度人管这叫"琴在跟着唱"。',
      onClear(c) {
        if (c.viaResonance) c.bonus = (c.bonus || 0) + c.clearedCells * 6;
      },
    },
    {
      id: 'echo_chamber',
      name: '回声室',
      icon: '🌀',
      tier: 2,
      desc: '共振可跨越 1 个空格继续传导。',
      flavor: '1956 年，莱斯·保罗在 Capitol 唱片大楼地下八米浇了八间混响室，至今仍在使用。混响不是效果器，是一个真实的房间。',
      passive: { resonanceJump: 1 },
    },
    {
      id: 'color_purist',
      name: '纯色主义',
      icon: '🎨',
      tier: 2,
      desc: '方块生成只用 4 种颜色（更易凑同色）。',
      flavor: '一件乐器只有一种音色，却撑起了整个巴洛克。限制不是缺陷，是风格的来源。',
      passive: { colorCount: -1 },
    },
    {
      id: 'gravity_well',
      name: '重力井',
      icon: '🕳️',
      tier: 2,
      desc: '消除后，上方格子下落填补（更易触发新连锁）。',
      flavor: '管风琴的音管越长音越低。声音也有重量 —— 它总是往下沉。',
      passive: { gravity: true },
    },

    /* ---------- 结构改造 (tier 2) ---------- */
    {
      id: 'shapeshifter',
      name: '变形者',
      icon: '🔄',
      tier: 2,
      desc: '手牌方块可旋转 90°。',
      flavor: '巴赫《赋格的艺术》把同一个主题倒过来、反过来、拉长一倍地写了十四遍。素材没变，作品变了。',
      passive: { rotate: true },
    },
    {
      id: 'minimalist',
      name: '极简派',
      icon: '▫️',
      tier: 2,
      desc: '有 30% 概率把大方块替换为 1×1 单格（救场用）。',
      flavor: '莱奇的《Piano Phase》只有一小段动机，靠两架钢琴慢慢错位撑满二十分钟。最小的单元最难被卡住。',
      modifyPiece(c) {
        if (c.rng.chance(0.3) && c.piece.cells.length > 1) {
          c.piece = c.makeSingle();
        }
      },
    },
    {
      id: 'lucky_seven',
      name: '幸运七',
      icon: '7️⃣',
      tier: 2,
      multMode: 'x',
      desc: '本关第 7、14、21… 次消除，得分 ×2。',
      flavor: '一个八度里放七个自然音，第八个音回到原点 —— "八度"这个词的意思就是"第八个"。七，是一个循环的长度。',
      state: { n: 0 },
      onLevelStart() {
        this.state.n = 0;
      },
      onScoreLine(c) {
        this.state.n++;
        if (this.state.n % 7 === 0) c.mult *= 2;
      },
      dyn() {
        return '下一次 ×2 还需 ' + (7 - (this.state.n % 7)) + ' 次';
      },
    },

    /* ---------- 传说 (tier 3) ---------- */
    {
      id: 'grand_piano',
      name: '三角钢琴',
      icon: '🎹',
      tier: 3,
      desc: '连锁段数直接作为倍率加成（+0.5×每段）。',
      flavor: '1700 年前后克里斯托福里做出第一台钢琴，取名"可强可弱的大键琴"。他一生大约只造了二十台。',
      onScoreLine(c) {
        c.mult += 0.5 * c.chain;
      },
    },
    {
      id: 'conductor',
      name: '指挥家',
      icon: '🪄',
      tier: 3,
      // SYNERGY: 与 crescendo 组合 = 关内滚雪球
      desc: '每关开始时，随机 5 个格子预先点亮为同一颜色。',
      flavor: '1687 年，吕利用长杖打拍子时砸中自己的脚，伤口感染而死 —— 指挥棒的前身，是一根真正的棍子。',
      passive: { seededCells: 5 },
    },
    {
      id: 'infinite_reverb',
      name: '无尽残响',
      icon: '♾️',
      tier: 3,
      desc: '共振范围 +2，且共振可跨越 1 个空格。',
      flavor: '汉密尔顿陵墓的穹顶让一声关门响了整整十五秒。它因此从未被用作礼拜堂 —— 混响太长，人声无法辨认。',
      passive: { resonanceRange: 2, resonanceJump: 1 },
    },
    {
      id: 'golden_ratio',
      name: '黄金比例',
      icon: '🌟',
      tier: 3,
      multMode: 'x',
      desc: '所有得分 ×1.618。',
      flavor: '分析者在巴托克《弦乐、打击乐与钢片琴的音乐》里发现：全曲 89 小节，高潮落在第 55 小节 —— 都是斐波那契数。',
      onScoreLine(c) {
        c.mult *= 1.618;
      },
    },
    {
      id: 'the_maestro',
      name: '大师',
      icon: '👑',
      tier: 3,
      multMode: 'x',
      desc: '同色整行消除时，倍率 ×2.5。',
      flavor: '托斯卡尼尼背谱指挥全部曲目，因为他近视到看不清谱面。极限催生了另一种能力。',
      onScoreLine(c) {
        if (c.sameColor) c.mult *= 2.5;
      },
    },
    {
      id: 'second_wind',
      name: '第二口气',
      icon: '💨',
      tier: 3,
      desc: '无处可放时，自动清空底部一整行（每关 1 次）。',
      flavor: '管风琴师换气不用肺 —— 风箱替他呼吸，所以巴赫的乐句可以长得不像人写的。',
      passive: { rescue: 1 },
    },
    {
      id: 'polyrhythm',
      name: '复节奏',
      icon: '🥁',
      tier: 3,
      multMode: 'x',
      desc: '同时消除行与列时，倍率 ×2。',
      flavor: '西非鼓乐里三拍与二拍长期并行，谁也不让谁。欧洲人管这种叫"错的"，直到二十世纪才承认那是另一种对。',
      onScoreLine(c) {
        if (c.hasRow && c.hasCol) c.mult *= 2;
      },
    },

    /* ---------- 经济 / 元层 ---------- */
    {
      id: 'patron',
      name: '赞助人',
      icon: '💰',
      tier: 1,
      desc: '每关结算额外 +2 灵感（用于刷新遗物选项）。',
      flavor: '埃斯特哈齐家族养了海顿近三十年。他因此写出 104 部交响曲 —— 稳定的钱，换来了产量。',
      passive: { inspiration: 2 },
    },
    {
      id: 'archivist',
      name: '档案员',
      icon: '📚',
      tier: 2,
      desc: '遗物三选一变为四选一。',
      flavor: '1829 年门德尔松重新上演《马太受难曲》，此前它已被遗忘近八十年。一份被抄下来的谱子，救回了一部作品。',
      passive: { offerCount: 1 },
    },
    {
      id: 'prodigy',
      name: '神童',
      icon: '🧠',
      tier: 2,
      desc: '每关目标分降低 15%。',
      flavor: '莫扎特五岁写下第一首小步舞曲，编号 K.1。天赋不是终点，只是提前了几年的起点。',
      passive: { targetScale: -0.15 },
    },
    {
      id: 'clean_slate',
      name: '白纸',
      icon: '📄',
      tier: 2,
      desc: '每关开始时清空棋盘（继承分数与遗物）。',
      flavor: '海顿每天早上重新削一支羽毛笔。空白页不是压力，是特权。',
      passive: { clearBoard: true },
    },
    {
      id: 'twin_flame',
      name: '双生焰',
      icon: '🔥',
      tier: 3,
      desc: '手牌中总有两个形状相同的方块，便于规划。',
      flavor: '卡农就是同一条旋律追着自己跑。最古老的复调技法，只需要一个素材。',
      passive: { twin: true },
    },
    {
      id: 'silent_note',
      name: '休止符',
      icon: '🔇',
      tier: 1,
      desc: '可以丢弃当前手牌一个方块（每关 3 次）。',
      flavor: '1952 年凯奇《4分33秒》全曲不演奏一个音，听众听到的是自己的咳嗽与雨声。休止也是记谱的一部分。',
      passive: { discards: 3 },
    },
  ];

  const BY_ID = {};
  RELICS.forEach((r) => (BY_ID[r.id] = r));

  /** 深拷贝一个遗物实例(带独立 state), 避免多局之间状态污染 */
  function instantiate(id) {
    const def = BY_ID[id];
    if (!def) return null;
    const inst = Object.create(def);
    if (def.state) inst.state = JSON.parse(JSON.stringify(def.state));
    return inst;
  }

  /** 汇总所有 passive 到一个数值表 */
  function aggregatePassives(relics) {
    const p = {
      resonanceRange: 0,
      resonanceJump: 0,
      undos: 0,
      handSize: 0,
      colorCount: 0,
      gravity: false,
      rotate: false,
      seededCells: 0,
      rescue: 0,
      inspiration: 0,
      offerCount: 0,
      targetScale: 0,
      clearBoard: false,
      twin: false,
      discards: 0,
    };
    for (const r of relics) {
      if (!r || !r.passive) continue;
      for (const k in r.passive) {
        const v = r.passive[k];
        if (typeof v === 'boolean') p[k] = p[k] || v;
        else p[k] = (p[k] || 0) + v;
      }
    }
    return p;
  }

  /**
   * 广播事件到所有遗物, 并记录"谁改了什么"。
   *
   * 这个 trigger 日志是整个游戏可学性的核心。玩家看不见的加成等于不存在 ——
   * 只给一个 "+320" 的总数, 玩家永远学不会哪两件遗物在互相放大, 构筑就退化成
   * 抽卡。把每件遗物的贡献单独记下来, 渲染层就能逐个依次弹出:
   *   音叉 +8  →  泛音列 ×1.5  →  纯五度 ×3
   * 300ms 的动画替掉一整页说明书, 玩家自己就推理出了乘区的价值。
   *
   * 之所以用"前后快照 diff"而不是让每个遗物自己上报: 遗物作者只需写
   * `c.base += 8`, 不必关心埋点, 新增遗物零成本自动获得展示。
   */
  function fire(relics, hook, ctx) {
    const track = ctx && typeof ctx.base === 'number' && typeof ctx.mult === 'number';
    if (track && !ctx.triggers) ctx.triggers = [];

    for (let i = 0; i < relics.length; i++) {
      const r = relics[i];
      if (!r || typeof r[hook] !== 'function') continue;

      const b0 = track ? ctx.base : 0;
      const m0 = track ? ctx.mult : 0;
      try {
        r[hook](ctx);
      } catch (e) {
        /* 单个遗物出错不应中断整局游戏 */
        continue;
      }
      if (!track) continue;

      const dBase = ctx.base - b0;
      const dMult = ctx.mult - m0;
      if (Math.abs(dBase) < 1e-9 && Math.abs(dMult) < 1e-9) continue;

      // 区分"加倍率"和"乘倍率"。这两者玩家心里完全是两回事 —— 乘区才是
      // 构筑的爆发点 —— 但从数值 diff 上无法反推(+0.5 和 ×1.5 可能同值),
      // 所以由遗物用 multMode:'x' 自己声明, 只有 6 件, 显式比猜测可靠。
      let label;
      if (Math.abs(dMult) > 1e-9) {
        label =
          r.multMode === 'x' && m0 > 1e-9
            ? '×' + round2(ctx.mult / m0)
            : (dMult > 0 ? '+' : '') + round2(dMult) + '倍';
      } else {
        label = (dBase > 0 ? '+' : '') + Math.round(dBase);
      }

      ctx.triggers.push({
        id: r.id,
        idx: i,
        icon: r.icon,
        name: r.name,
        label,
        kind: Math.abs(dMult) > 1e-9 ? 'mult' : 'chips',
        base: ctx.base,
        mult: ctx.mult,
      });
    }
    return ctx;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * 生成遗物选项。
   * 反挫败设计: 不重复已持有的; tier 权重随关卡提升;
   * 且保证至少一件与已持有遗物同 tier 或有 synergy 的。
   */
  function offer(rng, owned, level, count) {
    const ownedIds = new Set(owned.map((r) => r.id));
    const pool = RELICS.filter((r) => !ownedIds.has(r.id));
    if (!pool.length) return [];
    const tierW = level < 3 ? [70, 26, 4] : level < 6 ? [50, 38, 12] : [34, 44, 22];
    const weighted = pool.map((r) => ({ r, w: tierW[r.tier - 1] || 1 }));
    const out = [];
    const used = new Set();
    const n = Math.min(count || 3, pool.length);
    let guard = 0;
    while (out.length < n && guard++ < 200) {
      const pickd = rng.weighted(weighted);
      if (used.has(pickd.r.id)) continue;
      used.add(pickd.r.id);
      out.push(instantiate(pickd.r.id));
    }
    return out;
  }

  global.RELICS = { list: RELICS, byId: BY_ID, instantiate, aggregatePassives, fire, offer };
})(typeof window !== 'undefined' ? window : globalThis);
