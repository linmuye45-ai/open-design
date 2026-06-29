/* =====================================================================
 * 锦鲤棋牌 · 斗地主 AI 引擎 (ai.js)
 * 提供候选牌型枚举 + 多难度决策。
 * 难度: 1 新手(随机/保守) 2 普通 3 高手 4 大师(会算炸弹/留牌/配合)
 * 速度: 通过 thinkMs 控制（在 game 层使用）。
 * ===================================================================== */
(function (global) {
  'use strict';
  const R = global.Rules;

  /* 列举手牌中所有“能压过 last”的可出组合（last 为 null = 自由出） */
  function enumerateMoves(hand, last) {
    const moves = [];
    const byRank = groupByRank(hand);
    const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);

    // 自由出牌：枚举所有基础牌型；跟牌：只枚举同型更大 + 炸弹/王炸
    const addIfValid = (cards) => {
      if (!cards || cards.length === 0) return;
      const t = R.identify(cards);
      if (t.type === 'invalid') return;
      if (R.canBeat(t, last)) moves.push({ cards, info: t });
    };

    // 单张
    ranks.forEach(r => addIfValid([byRank[r][0]]));
    // 对子
    ranks.forEach(r => { if (byRank[r].length >= 2) addIfValid(byRank[r].slice(0, 2)); });
    // 三张 / 三带一 / 三带二
    ranks.forEach(r => {
      if (byRank[r].length >= 3) {
        const trio = byRank[r].slice(0, 3);
        addIfValid(trio);
        // 三带一
        const single = pickKickers(hand, byRank, [r], 1, 1);
        if (single) addIfValid(trio.concat(single));
        // 三带二
        const pair = pickKickers(hand, byRank, [r], 2, 1);
        if (pair) addIfValid(trio.concat(pair));
      }
    });
    // 炸弹
    ranks.forEach(r => { if (byRank[r].length === 4) addIfValid(byRank[r].slice(0, 4)); });
    // 王炸
    if (byRank[16] && byRank[17]) addIfValid([byRank[16][0], byRank[17][0]]);

    // 顺子（长度 5..12）
    enumerateStraights(byRank, ranks).forEach(addIfValid);
    // 连对
    enumeratePairRuns(byRank, ranks).forEach(addIfValid);
    // 飞机（带翅膀比较复杂，原型实现纯飞机 + 飞机带单/对的简化版）
    enumeratePlanes(hand, byRank, ranks).forEach(addIfValid);
    // 四带二
    ranks.forEach(r => {
      if (byRank[r].length === 4) {
        const k1 = pickKickers(hand, byRank, [r], 1, 2);
        if (k1) addIfValid(byRank[r].slice(0, 4).concat(k1));
      }
    });

    // 去重（按 cards id 集合）
    const seen = new Set();
    return moves.filter(m => {
      const key = m.cards.map(c => c.id).sort().join(',');
      if (seen.has(key)) return false; seen.add(key); return true;
    });
  }

  function groupByRank(hand) {
    const g = {};
    for (const c of hand) (g[c.rank] = g[c.rank] || []).push(c);
    return g;
  }

  // 从手牌挑选 size 张某 rank 作翅膀，需 count 组，排除 excludeRanks
  function pickKickers(hand, byRank, excludeRanks, size, count) {
    const result = [];
    const ranks = Object.keys(byRank).map(Number)
      .filter(r => !excludeRanks.includes(r))
      .sort((a, b) => a - b); // 优先出小牌当翅膀
    for (const r of ranks) {
      if (result.length / size >= count) break;
      if (byRank[r].length >= size && r < 16) { // 不用王当普通翅膀（简化）
        result.push(...byRank[r].slice(0, size));
        if (result.length >= size * count) break;
      }
    }
    return result.length === size * count ? result : null;
  }

  function enumerateStraights(byRank, ranks) {
    const res = [];
    const usable = ranks.filter(r => r <= 14 && byRank[r].length >= 1);
    for (let len = 5; len <= usable.length; len++) {
      for (let i = 0; i + len <= usable.length; i++) {
        const seg = usable.slice(i, i + len);
        if (seg[seg.length - 1] - seg[0] === len - 1)
          res.push(seg.map(r => byRank[r][0]));
      }
    }
    return res;
  }
  function enumeratePairRuns(byRank, ranks) {
    const res = [];
    const usable = ranks.filter(r => r <= 14 && byRank[r].length >= 2);
    for (let len = 3; len <= usable.length; len++) {
      for (let i = 0; i + len <= usable.length; i++) {
        const seg = usable.slice(i, i + len);
        if (seg[seg.length - 1] - seg[0] === len - 1)
          res.push(seg.flatMap(r => byRank[r].slice(0, 2)));
      }
    }
    return res;
  }
  function enumeratePlanes(hand, byRank, ranks) {
    const res = [];
    const trioRanks = ranks.filter(r => r <= 14 && byRank[r].length >= 3);
    for (let len = 2; len <= trioRanks.length; len++) {
      for (let i = 0; i + len <= trioRanks.length; i++) {
        const seg = trioRanks.slice(i, i + len);
        if (seg[seg.length - 1] - seg[0] !== len - 1) continue;
        const body = seg.flatMap(r => byRank[r].slice(0, 3));
        res.push(body); // 纯飞机
        // 飞机带单
        const singles = pickKickers(hand, byRank, seg, 1, len);
        if (singles) res.push(body.concat(singles));
        // 飞机带对
        const pairs = pickKickers(hand, byRank, seg, 2, len);
        if (pairs) res.push(body.concat(pairs));
      }
    }
    return res;
  }

  /* 评估手牌“危险度/强度”：剩余牌越少越想走，炸弹/大牌加分 */
  function handStrength(hand) {
    const byRank = groupByRank(hand);
    let score = 0;
    if (byRank[16] && byRank[17]) score += 8;
    Object.keys(byRank).forEach(r => {
      r = Number(r);
      if (byRank[r].length === 4) score += 6;
      if (r === 15) score += byRank[r].length * 2;
      if (r >= 14) score += byRank[r].length;
    });
    return score;
  }

  /* 主决策：返回选择的 move 或 null(过牌)
   * ctx: { hand, last, lastPlayerIsTeammate, myCardsLeft, oppMinLeft }
   * difficulty: 1..4
   */
  function decide(ctx, difficulty) {
    const moves = enumerateMoves(ctx.hand, ctx.last);
    if (moves.length === 0) return null; // 必须过

    // 自由出牌（last 为空）
    if (!ctx.last) {
      return chooseLead(ctx, moves, difficulty);
    }
    return chooseFollow(ctx, moves, difficulty);
  }

  function chooseLead(ctx, moves, difficulty) {
    // 过滤掉炸弹/王炸（领出时一般不主动拆炸，除非高难度残局）
    const nonBomb = moves.filter(m => m.info.bombLevel === 0);
    const pool = nonBomb.length ? nonBomb : moves;

    if (difficulty <= 1) {
      // 新手：随机出最小单张/对子优先
      pool.sort((a, b) => a.info.key - b.info.key || a.cards.length - b.cards.length);
      return pool[0];
    }
    // 普通及以上：优先出长牌型（顺子/连对/飞机）清手，再出小单张
    const score = (m) => {
      let s = 0;
      const t = m.info.type;
      if (t.includes('straight') || t.includes('plane') || t === 'straight_pair') s += 30 + m.cards.length;
      if (t === 'trio' || t === 'trio_one' || t === 'trio_pair') s += 15;
      if (t === 'pair') s += 8;
      if (t === 'single') s += 4;
      s -= m.info.key * 0.5; // 同类优先出小的
      // 残局：手牌少时优先能一把走完
      if (m.cards.length === ctx.hand.length) s += 100;
      return s;
    };
    pool.sort((a, b) => score(b) - score(a));
    // 大师级：若手里只剩可一把走完的，直接走
    return pool[0];
  }

  function chooseFollow(ctx, moves, difficulty) {
    const teammate = ctx.lastPlayerIsTeammate;
    // 队友出牌且自己不是地主：高难度倾向不压队友
    if (teammate && difficulty >= 2 && Math.random() < (difficulty >= 3 ? 0.9 : 0.6)) {
      // 除非能一把走完
      const finisher = moves.find(m => m.cards.length === ctx.hand.length);
      if (finisher) return finisher;
      return null;
    }

    const nonBomb = moves.filter(m => m.info.bombLevel === 0);
    const bombs = moves.filter(m => m.info.bombLevel > 0);

    if (difficulty <= 1) {
      // 新手：50% 概率跟最小，50% 过
      if (nonBomb.length && Math.random() < 0.7) {
        nonBomb.sort((a, b) => a.info.key - b.info.key);
        return nonBomb[0];
      }
      return nonBomb[0] || null;
    }

    // 普通/高手/大师：用最小可压牌跟（节省大牌）
    if (nonBomb.length) {
      nonBomb.sort((a, b) => a.info.key - b.info.key || a.cards.length - b.cards.length);
      const pick = nonBomb[0];
      // 高手判断：若对手只剩 1-2 张且我能一把走完，优先走
      const finisher = moves.find(m => m.cards.length === ctx.hand.length);
      if (finisher && difficulty >= 3) return finisher;
      // 高手/大师：对手将要获胜时动用炸弹拦截
      if (bombs.length && difficulty >= 3 && ctx.oppMinLeft <= 2 && ctx.oppIsEnemy) {
        bombs.sort((a, b) => a.info.bombLevel - b.info.bombLevel || a.info.key - b.info.key);
        return bombs[0];
      }
      // 大牌(A/2)是否值得压：普通难度有概率保留
      if (difficulty === 2 && pick.info.key >= 15 && Math.random() < 0.4) return null;
      return pick;
    }
    // 只剩炸弹：高难度拦截，否则过
    if (bombs.length && difficulty >= 3 && ctx.oppMinLeft <= 3 && ctx.oppIsEnemy) {
      bombs.sort((a, b) => a.info.key - b.info.key);
      return bombs[0];
    }
    return null;
  }

  /* 叫地主决策：根据手牌强度返回 0..3 分（>=阈值则叫） */
  function evaluateCall(hand) {
    return handStrength(hand);
  }

  global.AI = { enumerateMoves, decide, evaluateCall, handStrength };
})(typeof window !== 'undefined' ? window : globalThis);
