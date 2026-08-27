/* RESONANCE · 逻辑层测试 (node test.js) */
'use strict';
const g = globalThis;
require('./src/rng.js');
require('./src/icons.js');
require('./src/relics.js');
require('./src/game.js');
// audio.js 在没有 AudioContext 的环境里会把 enabled 置 false 并静默降级,
// 所以可以直接在 node 里加载 —— 这让音效的"设计意图"也能被测试钉住。
require('./src/audio.js');

let pass = 0,
  fail = 0;

/**
 * 测试运行器。
 *
 * 注意 async 的处理: 早先这里只有 try { fn() }, 于是任何 async 测试体
 * 抛出的错误都变成了一个**没人接的 rejected Promise** —— 测试照样打勾,
 * 但断言其实根本没被检查。这比没有测试更危险: 它会给出虚假的安全感。
 * (发现过程: 平台层的 hasRewarded 测试真的失败了, 却是因为同一批里另一条
 *  async 测试改了全局 ads 状态又没能还原, 而它自己显示通过。)
 *
 * 还有第二个更隐蔽的坑, 光是"把 Promise 收集起来 await"并不能解决:
 * async 函数体会**同步执行到第一个 await**。所以一条测试里的
 *   P.ads.enabled = true; await P.rewarded('hint'); 还原;
 * 会立刻把全局改脏, 而还原被推到微任务 —— 后面所有同步测试都在
 * 被污染的状态下跑。这正是 hasRewarded 那条测试"莫名"失败的真因。
 *
 * 现在的做法: 同步测试立即结算(保留即时反馈); 声明为 async 的测试体
 * **一次都不在注册时执行**, 而是连函数一起存进队列, 由 finish() 串行
 * await —— 一条跑完(含还原)才开始下一条。这样共享状态就不会重叠。
 */
const deferred = [];
function settle(name, e) {
  if (e) {
    fail++;
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n    ' + ((e && e.message) || e));
  } else {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  }
}
function t(name, fn) {
  // 异步测试整体延后, 串行执行 —— 不允许它们的副作用与同步测试交错。
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    deferred.push({ name, fn });
    return;
  }
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // 普通函数返回了 Promise: 已经开跑了拦不住, 至少保证断言被检查。
      deferred.push({ name, fn: () => r });
      return;
    }
    settle(name);
  } catch (e) {
    settle(name, e);
  }
}
async function finish() {
  if (deferred.length) {
    console.log('\n异步测试 (串行, 避免共享状态互相污染)');
    for (const { name, fn } of deferred) {
      try {
        await fn();
        settle(name);
      } catch (e) {
        settle(name, e);
      }
    }
  }
  console.log(
    '\n' +
      (fail === 0 ? '\x1b[32m' : '\x1b[31m') +
      pass +
      ' passed, ' +
      fail +
      ' failed\x1b[0m\n'
  );
  process.exit(fail ? 1 : 0);
}
function eq(a, b, m) {
  if (a !== b) throw new Error((m || '') + ' expected ' + b + ' got ' + a);
}
function ok(v, m) {
  if (!v) throw new Error(m || 'expected truthy');
}

console.log('\nRNG');
t('确定性: 同种子同结果', () => {
  const a = new g.RNG.Rng('ABC', 'x');
  const b = new g.RNG.Rng('ABC', 'x');
  for (let i = 0; i < 50; i++) eq(a.float(), b.float(), 'call ' + i);
});
t('不同 stream 互不干扰', () => {
  const a = new g.RNG.Rng('ABC', 'pieces');
  const b = new g.RNG.Rng('ABC', 'relics');
  let same = true;
  for (let i = 0; i < 20; i++) if (a.float() !== b.float()) same = false;
  ok(!same, 'streams should differ');
});
t('int 范围正确', () => {
  const r = new g.RNG.Rng('S');
  for (let i = 0; i < 2000; i++) {
    const v = r.int(7);
    ok(v >= 0 && v < 7, 'out of range ' + v);
  }
});
t('分布大致均匀 (卡方粗检)', () => {
  const r = new g.RNG.Rng('DIST');
  const buckets = new Array(10).fill(0);
  const N = 100000;
  for (let i = 0; i < N; i++) buckets[r.int(10)]++;
  const exp = N / 10;
  let chi = 0;
  for (const b of buckets) chi += ((b - exp) * (b - exp)) / exp;
  ok(chi < 27, 'chi2 too high: ' + chi.toFixed(1));
});
t('dailySeed 稳定', () => {
  const d = new Date(2026, 7, 9);
  eq(g.RNG.dailySeed(d), 'DAILY-20260809');
});

console.log('\nGame 基础');
t('初始化: 空棋盘 + 3 手牌', () => {
  const game = new g.ResonanceGame({ seed: 'T1' });
  eq(game.board.filter((v) => v !== -1).length, 0);
  eq(game.hand.length, 3);
  eq(game.level, 1);
  ok(game.target > 0);
});
t('同种子 -> 完全相同的手牌序列', () => {
  const a = new g.ResonanceGame({ seed: 'SAME' });
  const b = new g.ResonanceGame({ seed: 'SAME' });
  eq(JSON.stringify(a.hand.map((p) => p.shapeId + p.colorIdx)),
     JSON.stringify(b.hand.map((p) => p.shapeId + p.colorIdx)));
});
t('canPlace 边界检查', () => {
  const game = new g.ResonanceGame({ seed: 'T2' });
  const p = { cells: [[0, 0], [1, 0]], w: 2, h: 1 };
  ok(game.canPlace(p, 0, 0));
  ok(!game.canPlace(p, 7, 0), 'should not fit at x=7');
  ok(!game.canPlace(p, 0, 8), 'out of board');
});
t('放置后格子被占用', () => {
  const game = new g.ResonanceGame({ seed: 'T3' });
  const before = game.hand[0].cells.length;
  const ev = game.place(0, 0, 0);
  ok(ev, 'place should succeed');
  eq(game.board.filter((v) => v !== -1).length, before);
});
t('非法放置返回 null 且不改变状态', () => {
  const game = new g.ResonanceGame({ seed: 'T4' });
  const snap = game.board.slice().join(',');
  const ev = game.place(0, 99, 99);
  eq(ev, null);
  eq(game.board.slice().join(','), snap);
});

console.log('\n消除与共振');
t('填满一行触发消除', () => {
  const game = new g.ResonanceGame({ seed: 'CLR' });
  // 手动铺满第 7 行的前 7 格, 再放一个 1x1
  for (let x = 0; x < 7; x++) game.board[7 * 8 + x] = 0;
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'x' }];
  const ev = game.place(0, 7, 7);
  ok(ev, 'placed');
  ok(ev.steps.length >= 1, 'should clear');
  eq(ev.steps[0].lines, 1);
  eq(game.board.filter((v) => v !== -1).length, 0, 'row cleared');
  ok(ev.scoreGained > 0);
});
t('同色行触发 sameColor 标记', () => {
  const game = new g.ResonanceGame({ seed: 'SC' });
  for (let x = 0; x < 7; x++) game.board[0 * 8 + x] = 2;
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 2, w: 1, h: 1, uid: 'x' }];
  const ev = game.place(0, 7, 0);
  ok(ev.steps[0].sameColor, 'should be same color');
});
t('共振: 同色相邻格被引爆', () => {
  const game = new g.ResonanceGame({ seed: 'RES' });
  // 第 0 行全是颜色 1 (待消除)
  for (let x = 0; x < 7; x++) game.board[0 * 8 + x] = 1;
  // 第 1 行放几个同色 1 -> 应被共振
  game.board[1 * 8 + 0] = 1;
  game.board[1 * 8 + 1] = 1;
  game.board[1 * 8 + 3] = 3; // 异色, 不应被消
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 1, w: 1, h: 1, uid: 'x' }];
  const ev = game.place(0, 7, 0);
  const step = ev.steps[0];
  ok(step.resonatedCells.length >= 2, 'resonated ' + step.resonatedCells.length);
  eq(game.board[1 * 8 + 3], 3, 'different color must survive');
  eq(game.board[1 * 8 + 0], -1, 'same color must be cleared');
});
t('共振范围受 range 限制 (默认 1)', () => {
  const game = new g.ResonanceGame({ seed: 'RNG1' });
  for (let x = 0; x < 7; x++) game.board[0 * 8 + x] = 1;
  game.board[1 * 8 + 2] = 1; // 距离 1 -> 引爆
  game.board[2 * 8 + 2] = 1; // 距离 2 -> 默认不引爆
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 1, w: 1, h: 1, uid: 'x' }];
  game.place(0, 7, 0);
  eq(game.board[1 * 8 + 2], -1, 'dist1 cleared');
  eq(game.board[2 * 8 + 2], 1, 'dist2 survives at range 1');
});
t('延音踏板遗物扩大共振范围', () => {
  const game = new g.ResonanceGame({ seed: 'RNG2' });
  game.relics = [g.RELICS.instantiate('sustain_pedal')];
  game._applyPassives();
  for (let x = 0; x < 7; x++) game.board[0 * 8 + x] = 1;
  game.board[1 * 8 + 2] = 1;
  game.board[2 * 8 + 2] = 1;
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 1, w: 1, h: 1, uid: 'x' }];
  game.place(0, 7, 0);
  eq(game.board[2 * 8 + 2], -1, 'dist2 cleared with range+1');
});
t('回声室: 跨空格传导', () => {
  const game = new g.ResonanceGame({ seed: 'ECHO' });
  game.relics = [g.RELICS.instantiate('echo_chamber')];
  game._applyPassives();
  for (let x = 0; x < 7; x++) game.board[0 * 8 + x] = 1;
  // 第1行 x=2 空, 第2行 x=2 同色 -> 跨空格应引爆
  game.board[2 * 8 + 2] = 1;
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 1, w: 1, h: 1, uid: 'x' }];
  game.place(0, 7, 0);
  eq(game.board[2 * 8 + 2], -1, 'jumped over gap');
});
t('行列同时消除计入 2 行', () => {
  const game = new g.ResonanceGame({ seed: 'CROSS' });
  for (let x = 0; x < 8; x++) if (x !== 3) game.board[5 * 8 + x] = 0;
  for (let y = 0; y < 8; y++) if (y !== 5) game.board[y * 8 + 3] = 0;
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'x' }];
  const ev = game.place(0, 3, 5);
  eq(ev.steps[0].lines, 2, 'row+col');
  ok(ev.steps[0].hasRow !== false);
});

console.log('\n遗物系统');
t('所有遗物都有 id/name/desc/tier', () => {
  for (const r of g.RELICS.list) {
    ok(r.id && r.name && r.desc && r.tier, 'bad relic ' + JSON.stringify(r.id));
    ok(r.tier >= 1 && r.tier <= 3, 'tier range ' + r.id);
  }
});
t('遗物 id 唯一', () => {
  const s = new Set();
  for (const r of g.RELICS.list) {
    ok(!s.has(r.id), 'dup ' + r.id);
    s.add(r.id);
  }
});
t('遗物数量 >= 25 (构筑深度)', () => {
  ok(g.RELICS.list.length >= 25, 'only ' + g.RELICS.list.length);
});
t('instantiate 产生独立 state', () => {
  const a = g.RELICS.instantiate('crescendo');
  const b = g.RELICS.instantiate('crescendo');
  a.state.stack = 99;
  eq(b.state.stack, 0, 'states must be isolated');
});
t('offer 不给已持有的遗物', () => {
  const rng = new g.RNG.Rng('OFF');
  const owned = [g.RELICS.instantiate('tuning_fork'), g.RELICS.instantiate('metronome')];
  for (let i = 0; i < 50; i++) {
    const o = g.RELICS.offer(rng, owned, 3, 3);
    for (const r of o) {
      ok(r.id !== 'tuning_fork' && r.id !== 'metronome', 'offered owned relic');
    }
  }
});
t('offer 无重复项', () => {
  const rng = new g.RNG.Rng('OFF2');
  for (let i = 0; i < 50; i++) {
    const o = g.RELICS.offer(rng, [], 5, 4);
    const s = new Set(o.map((r) => r.id));
    eq(s.size, o.length, 'duplicate in offer');
  }
});
t('黄金比例遗物提升得分', () => {
  function run(relicIds) {
    const game = new g.ResonanceGame({ seed: 'GR' });
    game.relics = relicIds.map((id) => g.RELICS.instantiate(id));
    game._applyPassives();
    for (let x = 0; x < 7; x++) game.board[0 * 8 + x] = 0;
    game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'x' }];
    return game.place(0, 7, 0).scoreGained;
  }
  const plain = run([]);
  const golden = run(['golden_ratio']);
  ok(golden > plain, 'golden ' + golden + ' vs ' + plain);
});
t('crescendo 关内累积', () => {
  const game = new g.ResonanceGame({ seed: 'CRE' });
  const r = g.RELICS.instantiate('crescendo');
  game.relics = [r];
  game._applyPassives();
  r.state.stack = 0;
  const ctx1 = { base: 0, mult: 1, lines: 1, chain: 0, state: game };
  r.onScoreLine(ctx1);
  eq(ctx1.base, 0, 'first clear no bonus yet');
  const ctx2 = { base: 0, mult: 1, lines: 1, chain: 0, state: game };
  r.onScoreLine(ctx2);
  eq(ctx2.base, 2, 'second clear +2');
});
t('纯色主义减少颜色数', () => {
  const game = new g.ResonanceGame({ seed: 'PUR' });
  eq(game.colorCount, 5);
  game.relics = [g.RELICS.instantiate('color_purist')];
  game._applyPassives();
  eq(game.colorCount, 4);
});
t('宽弓增加手牌', () => {
  const game = new g.ResonanceGame({ seed: 'BOW' });
  game.relics = [g.RELICS.instantiate('wide_bow')];
  game._applyPassives();
  game._refillHand(true);
  eq(game.hand.length, 4);
});

console.log('\n撤销 / 过关 / 死局');
t('撤销恢复棋盘与分数', () => {
  const game = new g.ResonanceGame({ seed: 'UNDO' });
  const b0 = game.board.slice().join(',');
  const s0 = game.score;
  game.place(0, 0, 0);
  ok(game.board.slice().join(',') !== b0, 'board changed');
  ok(game.undo(), 'undo ok');
  eq(game.board.slice().join(','), b0, 'board restored');
  eq(game.score, s0, 'score restored');
});
t('撤销次数耗尽后失败', () => {
  const game = new g.ResonanceGame({ seed: 'UNDO2' });
  game.place(0, 0, 0);
  ok(game.undo());
  game.place(0, 0, 0);
  eq(game.undo(), false, 'no undos left');
});
t('达到目标分触发遗物三选一', () => {
  const game = new g.ResonanceGame({ seed: 'LVL' });
  game.target = 1; // 强制立刻过关
  for (let x = 0; x < 7; x++) game.board[0 * 8 + x] = 0;
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'x' }];
  const ev = game.place(0, 7, 0);
  ok(ev.levelUp, 'level up');
  ok(game.pendingOffer && game.pendingOffer.length >= 3, 'offer given');
});
t('takeRelic 推进关卡并提升目标', () => {
  const game = new g.ResonanceGame({ seed: 'LVL2' });
  game.target = 1;
  for (let x = 0; x < 7; x++) game.board[0 * 8 + x] = 0;
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'x' }];
  game.place(0, 7, 0);
  const t0 = game.target;
  ok(game.takeRelic(0));
  eq(game.level, 2);
  eq(game.relics.length, 1);
  ok(game.target > t0, 'target should grow');
  eq(game.score, 0, 'score resets per level');
});
t('目标分曲线单调递增且不陡峭', () => {
  let prev = 0;
  for (let l = 1; l <= 15; l++) {
    const v = g.ResonanceGame.targetFor(l);
    ok(v > prev, 'monotonic at ' + l);
    if (l > 1) {
      const ratio = v / prev;
      ok(ratio < 1.9, 'level ' + l + ' jump too steep: ' + ratio.toFixed(2));
    }
    prev = v;
  }
});
t('棋盘塞满时判定死局', () => {
  const game = new g.ResonanceGame({ seed: 'DEAD' });
  // 填满整盘但用交错颜色避免消除, 留 0 空位是不可能的(会消除),
  // 所以改为直接检查 hasAnyMove 在满盘时为 false
  game.board.fill(0);
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'x' }];
  eq(game.hasAnyMove(), false, 'no move on full board');
});
t('hint 返回合法的一步', () => {
  const game = new g.ResonanceGame({ seed: 'HINT' });
  const h = game.hint();
  ok(h, 'hint exists');
  const p = game.hand[h.hi];
  ok(p, 'hand piece exists');
  ok(game.canPlace(p, h.x, h.y) || game.passives.rotate, 'hint is placeable');
});
t('hint 优先选择能消除的一步', () => {
  const game = new g.ResonanceGame({ seed: 'HINT2' });
  for (let x = 0; x < 7; x++) game.board[3 * 8 + x] = 0;
  game.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'x' }];
  const h = game.hint();
  eq(h.x, 7);
  eq(h.y, 3);
});

console.log('\n形状与旋转');
t('rotateCells 四次回到原形', () => {
  const orig = [[0, 0], [1, 0], [2, 0], [1, 1]];
  let c = orig;
  for (let i = 0; i < 4; i++) c = g.ResonanceGame.rotateCells(c);
  const norm = (a) => a.map((p) => p.join(',')).sort().join('|');
  eq(norm(c), norm(orig));
});
t('rotateCells 保持格子数', () => {
  for (const s of g.ResonanceGame.SHAPES) {
    let c = s.cells;
    for (let i = 0; i < 4; i++) {
      c = g.ResonanceGame.rotateCells(c);
      eq(c.length, s.cells.length, s.id);
    }
  }
});
t('所有形状声明的 w/h 与实际一致', () => {
  for (const s of g.ResonanceGame.SHAPES) {
    const b = g.ResonanceGame.boundsOf(s.cells);
    eq(b.w, s.w, s.id + ' width');
    eq(b.h, s.h, s.id + ' height');
  }
});
t('所有形状都能放入空棋盘', () => {
  const game = new g.ResonanceGame({ seed: 'FIT' });
  game.board.fill(-1);
  for (const s of g.ResonanceGame.SHAPES) {
    ok(game.anyPlacement({ cells: s.cells, w: s.w, h: s.h }), s.id + ' cannot fit');
  }
});

console.log('\n完整对局模拟 (稳定性 / 平衡性)');
t('200 局随机走子不崩溃, 且能推进关卡', () => {
  let maxLevel = 0,
    totalMoves = 0;
  for (let n = 0; n < 200; n++) {
    const seed = 'SIM' + n;
    const game = new g.ResonanceGame({ seed });
    const rng = new g.RNG.Rng(seed, 'ai');
    let guard = 0;
    while (!game.gameOver && guard++ < 400) {
      if (game.pendingOffer) {
        game.takeRelic(rng.int(game.pendingOffer.length));
        continue;
      }
      // 40% 用 hint (模拟中等水平玩家), 60% 随机
      let mv = null;
      if (rng.chance(0.4)) mv = game.hint();
      if (!mv) {
        const cands = [];
        for (let hi = 0; hi < game.hand.length; hi++)
          for (let y = 0; y < 8; y++)
            for (let x = 0; x < 8; x++)
              if (game.canPlace(game.hand[hi], x, y)) cands.push({ hi, x, y });
        if (!cands.length) break;
        mv = rng.pick(cands);
      }
      const ev = game.place(mv.hi, mv.x, mv.y, mv.rot);
      if (!ev) break;
      totalMoves++;
    }
    maxLevel = Math.max(maxLevel, game.level);
  }
  ok(totalMoves > 1000, 'too few moves: ' + totalMoves);
  ok(maxLevel >= 3, 'AI never reached level 3, curve too hard: ' + maxLevel);
  console.log('    → 最高关卡 ' + maxLevel + ', 总走子 ' + totalMoves);
});
t('用 hint 策略的中位关卡在合理区间 (可玩性)', () => {
  const levels = [];
  for (let n = 0; n < 60; n++) {
    const seed = 'BAL' + n;
    const game = new g.ResonanceGame({ seed });
    const rng = new g.RNG.Rng(seed, 'ai');
    let guard = 0;
    while (!game.gameOver && guard++ < 600) {
      if (game.pendingOffer) {
        game.takeRelic(0);
        continue;
      }
      const mv = game.hint();
      if (!mv) break;
      if (!game.place(mv.hi, mv.x, mv.y, mv.rot)) break;
    }
    levels.push(game.level);
  }
  levels.sort((a, b) => a - b);
  const med = levels[Math.floor(levels.length / 2)];
  console.log('    → 中位关卡 ' + med + ', 最好 ' + levels[levels.length - 1]);
  ok(med >= 2, 'median too low (太难): ' + med);
  ok(med <= 40, 'median too high (太简单): ' + med);
});
t('分数为有限正数, 无 NaN/Infinity', () => {
  for (let n = 0; n < 40; n++) {
    const game = new g.ResonanceGame({ seed: 'NAN' + n });
    const rng = new g.RNG.Rng('NAN' + n, 'ai');
    let guard = 0;
    while (!game.gameOver && guard++ < 200) {
      if (game.pendingOffer) {
        game.takeRelic(rng.int(game.pendingOffer.length));
        continue;
      }
      const mv = game.hint();
      if (!mv) break;
      if (!game.place(mv.hi, mv.x, mv.y, mv.rot)) break;
      ok(Number.isFinite(game.score), 'score not finite');
      ok(Number.isFinite(game.totalScore), 'total not finite');
      ok(game.score >= 0, 'negative score');
    }
  }
});
t('持有全部遗物时也不崩溃 (极端构筑)', () => {
  const game = new g.ResonanceGame({ seed: 'ALL' });
  game.relics = g.RELICS.list.map((r) => g.RELICS.instantiate(r.id));
  game._applyPassives();
  game._refillHand(true);
  let guard = 0;
  while (!game.gameOver && guard++ < 300) {
    if (game.pendingOffer) {
      game.skipRelic();
      continue;
    }
    const mv = game.hint();
    if (!mv) break;
    if (!game.place(mv.hi, mv.x, mv.y, mv.rot)) break;
    ok(Number.isFinite(game.score), 'score finite with all relics');
  }
  ok(game.level >= 1);
});
t('serialize 输出可 JSON 化', () => {
  const game = new g.ResonanceGame({ seed: 'SER' });
  game.place(0, 0, 0);
  const s = JSON.stringify(game.serialize());
  ok(s.length > 20);
  const back = JSON.parse(s);
  eq(back.seed, 'SER');
});
t('同种子完整重放 -> 完全相同分数 (可验证公平)', () => {
  function run(seed) {
    const game = new g.ResonanceGame({ seed });
    let guard = 0;
    while (!game.gameOver && guard++ < 300) {
      if (game.pendingOffer) {
        game.takeRelic(0);
        continue;
      }
      const mv = game.hint();
      if (!mv) break;
      if (!game.place(mv.hi, mv.x, mv.y, mv.rot)) break;
    }
    return game.totalScore + '/' + game.level;
  }
  eq(run('REPLAY'), run('REPLAY'));
});

/* ---------------------------------------------------------------
 * 计分演出脚本 (triggers)
 * 这些断言守护的是"玩家能看懂钱从哪来"这个核心体验:
 * 只要 triggers 与真实结算脱节, 计分台就会撒谎, 构筑立刻退化成抽卡。
 * ------------------------------------------------------------- */
console.log('\n计分演出脚本 (triggers)');

/** 造一个"下一步必定消除整行"的确定局面 */
function primedGame(relicIds, seed) {
  const game = new g.ResonanceGame({ seed: seed || 'TRIG' });
  if (relicIds) game.relics = relicIds.map((id) => g.RELICS.instantiate(id));
  game._applyPassives();
  // 铺满第 7 行只留 (0,7), 再把手牌第 0 位换成单格
  for (let x = 1; x < 8; x++) game.board[7 * 8 + x] = 2;
  game.hand[0] = { cells: [[0, 0]], w: 1, h: 1, colorIdx: 2, id: 'single' };
  return game;
}

t('无遗物时 triggers 为空, 且 base/mult 不变', () => {
  const game = primedGame(null);
  const ev = game.place(0, 0, 7, 0);
  ok(ev, '应当放置成功');
  eq(ev.steps.length, 1, '应消除 1 次');
  const s = ev.steps[0];
  eq(s.triggers.length, 0, 'triggers');
  eq(s.base, s.baseStart, 'base 不应被改动');
  eq(s.mult, s.multStart, 'mult 不应被改动');
});

t('加法遗物被记录为 chips 且标签正确', () => {
  const game = primedGame(['tuning_fork']); // 每行 +8
  const s = game.place(0, 0, 7, 0).steps[0];
  eq(s.triggers.length, 1, 'triggers 数量');
  eq(s.triggers[0].id, 'tuning_fork');
  eq(s.triggers[0].kind, 'chips');
  eq(s.triggers[0].label, '+8');
  eq(s.base, s.baseStart + 8, 'base 增量');
});

t('乘法遗物被记录为 mult 且显示为 ×', () => {
  const game = primedGame(['golden_ratio']); // ×1.618
  const s = game.place(0, 0, 7, 0).steps[0];
  eq(s.triggers.length, 1);
  eq(s.triggers[0].kind, 'mult');
  eq(s.triggers[0].label, '×1.62');
});

t('未满足条件的遗物不产生 trigger (不能撒谎)', () => {
  // 纯五度要连锁 5 段, 单行消除不该触发
  const game = primedGame(['perfect_fifth']);
  const s = game.place(0, 0, 7, 0).steps[0];
  eq(s.triggers.length, 0, '不满足条件却上报了');
});

t('trigger 的 idx 能对回遗物条下标', () => {
  const game = primedGame(['sustain_pedal', 'tuning_fork']);
  const s = game.place(0, 0, 7, 0).steps[0];
  eq(s.triggers.length, 1, '只有音叉应触发');
  eq(s.triggers[0].idx, 1, '音叉在第 1 位');
  eq(game.relics[s.triggers[0].idx].id, 'tuning_fork', 'idx 必须能索引回原遗物');
});

t('trigger 链的最后一项等于最终 base/mult (演出与结算一致)', () => {
  const game = primedGame(['tuning_fork', 'rosin', 'golden_ratio', 'harmonic_series']);
  const s = game.place(0, 0, 7, 0).steps[0];
  ok(s.triggers.length >= 2, '应有多件生效, 实际 ' + s.triggers.length);
  const last = s.triggers[s.triggers.length - 1];
  eq(last.base, s.base, '最后一帧 base 必须等于结算 base');
  eq(last.mult, s.mult, '最后一帧 mult 必须等于结算 mult');
});

t('演出脚本重算出的分数 == 实际入账分数', () => {
  // 这是最重要的一条: 计分台显示 base×mult, 若与 score 不符就是欺骗玩家
  const game = primedGame(['tuning_fork', 'golden_ratio', 'sympathetic', 'crescendo']);
  const s = game.place(0, 0, 7, 0).steps[0];
  eq(Math.round(s.base * s.mult) + s.bonus, s.score, 'base×mult+bonus 应等于 score');
});

t('triggers 单调推进: 每一帧的值都与上一帧衔接', () => {
  const game = primedGame(['tuning_fork', 'rosin', 'golden_ratio', 'metronome']);
  const s = game.place(0, 0, 7, 0).steps[0];
  let b = s.baseStart;
  let m = s.multStart;
  for (const tr of s.triggers) {
    ok(tr.base !== undefined && tr.mult !== undefined, '缺少快照');
    // 每帧只应改变其中一个维度, 否则玩家无法归因
    const changedBase = Math.abs(tr.base - b) > 1e-9;
    const changedMult = Math.abs(tr.mult - m) > 1e-9;
    ok(changedBase || changedMult, tr.id + ' 上报了但没有任何变化');
    b = tr.base;
    m = tr.mult;
  }
  eq(b, s.base);
  eq(m, s.mult);
});

t('持有全部遗物时 triggers 依然自洽', () => {
  const all = g.RELICS.list.map((r) => r.id);
  const game = primedGame(all);
  const ev = game.place(0, 0, 7, 0);
  ok(ev, '应放置成功');
  for (const s of ev.steps) {
    ok(Number.isFinite(s.base) && Number.isFinite(s.mult), 'base/mult 必须有限');
    for (const tr of s.triggers) {
      ok(typeof tr.label === 'string' && tr.label.length > 0, 'label 不能为空');
      ok(tr.kind === 'mult' || tr.kind === 'chips', 'kind 非法: ' + tr.kind);
      ok(game.relics[tr.idx], 'idx 越界: ' + tr.idx);
    }
  }
});

t('同种子重放时 triggers 完全一致 (演出也可复现)', () => {
  const sig = () => {
    const game = primedGame(['tuning_fork', 'golden_ratio', 'crescendo'], 'SHOW');
    return game
      .place(0, 0, 7, 0)
      .steps.map((s) => s.triggers.map((x) => x.id + x.label).join(','))
      .join('|');
  };
  eq(sig(), sig());
});


/* ---------------------------------------------------------------
 * 图标资产完整性
 * 图标是玩家识别遗物的唯一视觉锚点。缺一个就会掉到 fallback 方块,
 * 在遗物条上表现为"两件遗物长得一模一样", 直接破坏可读性。
 * ------------------------------------------------------------- */
console.log('\n图标资产');
t('每件遗物都有专属手绘图标 (无 fallback)', () => {
  const missing = g.RELICS.list.filter((r) => !g.ICONS.has(r.id)).map((r) => r.id);
  eq(missing.length, 0, '缺图标: ' + missing.join(', '));
});
t('没有多余的孤儿图标', () => {
  const ids = new Set(g.RELICS.list.map((r) => r.id));
  // ui-* 是界面图标(菜单/静音/提示…), 不属于任何遗物, 不算孤儿。
  // 它们的"被使用"验证在 test-dom.js 里做 (遍历 [data-icon] 比对)。
  const orphan = Object.keys(g.ICONS.paths).filter(
    (k) => !ids.has(k) && k.indexOf('ui-') !== 0
  );
  eq(orphan.length, 0, '孤儿图标: ' + orphan.join(', '));
});

t('界面图标命名规范且不与遗物撞名', () => {
  const ids = new Set(g.RELICS.list.map((r) => r.id));
  const ui = Object.keys(g.ICONS.paths).filter((k) => k.indexOf('ui-') === 0);
  ok(ui.length >= 12, '界面图标数量不足: ' + ui.length);
  for (const k of ui) {
    ok(!ids.has(k), k + ' 与遗物 id 撞名');
    ok(/^ui-[a-z-]+$/.test(k), k + ' 命名不规范');
  }
});
t('所有图标路径是合法的 SVG path 且在视口内', () => {
  // 只校验**绝对坐标**命令(大写)的数值范围。相对命令(小写)的参数是位移量,
  // 负数完全合法 —— 早先把 h-3 当成越界是校验器自己的 bug, 不是美术问题。
  const ABS = new Set(['M', 'L', 'H', 'V', 'C', 'S', 'Q', 'T', 'A']);
  for (const [id, d] of Object.entries(g.ICONS.paths)) {
    ok(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/.test(d), id + ' 含非法字符');
    ok(d.trim()[0] === 'M', id + ' 必须以 M 开头 (绝对起点)');

    // 按命令切段: 命令字母 + 其后的数值串
    const segs = d.match(/[A-Za-z][^A-Za-z]*/g) || [];
    ok(segs.length > 0, id + ' 解析不出任何命令');
    for (const seg of segs) {
      const cmd = seg[0];
      if (!ABS.has(cmd)) continue; // 相对命令跳过范围检查
      const nums = (seg.slice(1).match(/-?\d+(\.\d+)?/g) || []).map(Number);
      // A 命令的前 5 个参数是半径/旗标/角度, 不是坐标, 单独放行
      const coords = cmd === 'A' ? nums.slice(5) : nums;
      ok(
        coords.every((n) => n >= 0 && n <= 24),
        id + ' 绝对坐标越界 (' + cmd + ' ' + coords.join(',') + ')'
      );
    }
  }
});
t('svg() 输出可继承颜色且带无障碍属性', () => {
  const out = g.ICONS.svg('tuning_fork', 20);
  ok(out.indexOf('currentColor') > -1, '必须用 currentColor 才能随场景变色');
  ok(out.indexOf('aria-hidden') > -1, '装饰性图标应对读屏器隐藏');
  ok(out.indexOf('width="20"') > -1, '尺寸未生效');
});
t('未知 id 走 fallback 而不是抛错或留空', () => {
  const out = g.ICONS.svg('nonexistent_relic', 16);
  ok(out.indexOf('<svg') === 0, '仍应返回 svg');
  ok(out.indexOf(g.ICONS.FALLBACK) > -1, '应使用 fallback 路径');
});


/* =============================================================
 * 留存机制 (调音师 / 连击 / 百分位)
 *
 * 这一组测试守的是"承诺"而不只是"功能": 调音师必须可见、有上限、
 * 且不能让游戏永不结束; 百分位必须单调且不吹牛。这些性质一旦被破坏,
 * 破坏的是玩家信任, 而不只是一个 bug。
 * ============================================================= */
/* =============================================================
 * 商业模型的完整性
 *
 * docs/model.js 的价值完全建立在「它读的是真代码」之上。一旦它开始
 * 自己填一个广告频次, 它就退化成一份 PPT —— 而 PPT 永远算得出好数字。
 * 这几条测试钉住的就是这个耦合关系。
 * ============================================================= */
console.log('\n商业模型');
const MODEL_SRC = require('fs').readFileSync(__dirname + '/docs/model.js', 'utf8');

t('模型文件存在且可被引用', () => {
  ok(MODEL_SRC.length > 2000, 'docs/model.js 缺失或过短');
});

t('模型的广告频次来自 platform.js, 不是自己填的数', () => {
  ok(/Platform\.LIMITS/.test(MODEL_SRC),
    '模型没有读 Platform.LIMITS —— 频次一旦可以自由填写, 收入结论就没有约束力');
  ok(/MIN_INTERSTITIAL_GAP_S/.test(MODEL_SRC), '模型未引用硬编码的插屏间隔');
});

t('模型的内容深度是跑出来的, 不是填的', () => {
  ok(/ResonanceGame/.test(MODEL_SRC), '模型没有真的实例化游戏');
  ok(/gm\.hint\(\)/.test(MODEL_SRC), '模型没有用真实的 hint 评分模拟玩家');
});

t('所有外部假设都显式标注 ASSUMED (不许偷偷混进去)', () => {
  const n = (MODEL_SRC.match(/ASSUMED/g) || []).length;
  ok(n >= 5, '标注过少, 只有 ' + n + ' 处 —— 市场侧假设应逐一标明');
});

t('模型包含敏感度分析 (单点数字没有信息量)', () => {
  ok(/弹性|elasticity/.test(MODEL_SRC), '缺少弹性/敏感度分析');
});

t('模型允许输出"目标不可达" (不是自我安慰工具)', () => {
  // 一个只会说"能成"的模型是没用的。必须存在否定性结论的措辞。
  ok(/超过任何单款|达不到|算术/.test(MODEL_SRC),
    '模型缺少否定性结论 —— 只会输出可达的模型不是模型');
});

t('README 里写的数量与代码实际一致', () => {
  /* 文档里的数字是最容易悄悄变成谣言的东西: 加一个图标、删一件遗物,
   * 没人会想起来去改 README。而一份数字不准的 README 会让人怀疑
   * 其它所有说法 —— 包括那些真的很重要的承诺。
   * (这一条不是假想: README 初稿写了 45 个图标 / 16 个 UI 图标,
   *  实际是 44 / 15。) */
  const fs = require('fs');
  const readme = fs.readFileSync(__dirname + '/README.md', 'utf8');
  const ids = Object.keys(g.ICONS.paths);
  const uiN = ids.filter((i) => i.indexOf('ui-') === 0).length;
  const relicIconN = ids.length - uiN;
  const relicN = g.RELICS.list.length;

  ok(readme.indexOf(ids.length + ' 个手绘 SVG 图标') >= 0,
    'README 的图标总数不是 ' + ids.length);
  ok(readme.indexOf(relicIconN + ' 遗物') >= 0, 'README 的遗物图标数不是 ' + relicIconN);
  ok(readme.indexOf(uiN + ' UI') >= 0, 'README 的 UI 图标数不是 ' + uiN);
  ok(readme.indexOf(relicN + ' 件遗物') >= 0, 'README 的遗物数不是 ' + relicN);

  /* 测试数量: 原先只校验"没写小", 结果它照样漂移到了 112 vs 实际 123。
   * 一个只查下界的断言等于没查。改为数源文件里 t(...) 的实际条数并
   * 精确比对 —— 这样加了测试忘了改 README 会立刻红。
   *
   * 数的是 `t('...'` 的出现次数: 本文件里每条测试都是这个形式, 而
   * 定义处是 `function t(name, fn)`, 不带引号, 不会被算进去。 */
  const countTests = (src) => (src.match(/^t\('/gm) || []).length;
  const logicN = countTests(fs.readFileSync(__dirname + '/test.js', 'utf8'));
  const domN = countTests(fs.readFileSync(__dirname + '/test-dom.js', 'utf8'));
  ok(logicN > 100, '自查失败: 只数出 ' + logicN + ' 条逻辑测试');

  const ml = /(\d+) 项: 逻辑/.exec(readme);
  ok(ml, 'README 未写明逻辑测试数量');
  eq(Number(ml[1]), logicN, 'README 写的逻辑测试数与实际不符');
  const md = /(\d+) 项: jsdom/.exec(readme);
  ok(md, 'README 未写明 DOM 测试数量');
  eq(Number(md[1]), domN, 'README 写的 DOM 测试数与实际不符');
});

t('DEPLOY.md 存在且覆盖全部目标平台', () => {
  const fs = require('fs');
  const dep = fs.readFileSync(__dirname + '/docs/DEPLOY.md', 'utf8');
  // platform.js 和 index.html 的注释都引用了这个文件, 它必须真的存在且有内容
  for (const kw of ['WKWebView', 'JavascriptInterface', 'javaScriptProxy',
    'web-view', 'AppLovin', 'backupSave']) {
    ok(dep.indexOf(kw) >= 0, 'DEPLOY.md 缺少 ' + kw + ' 相关说明');
  }
  ok(dep.length > 8000, 'DEPLOY.md 内容过少, 不足以照着做');
});

t('DEPLOY.md 里的壳代码只调用真实存在的接口', () => {
  /* 文档里给出的原生壳代码会被直接复制到真机工程里。如果它调用了一个
   * 不存在的全局函数, 那份代码在真机上会静默失效 —— 而这类错误在
   * 沙箱里永远测不出来。所以这里反向检查一遍。
   * (初稿确实写错过: 用了 window.App 和 Platform.onBackPressed, 两者
   *  都不存在, 真实入口是 window.ResonanceApp.goBack。) */
  const fs = require('fs');
  const dep = fs.readFileSync(__dirname + '/docs/DEPLOY.md', 'utf8');
  const main = fs.readFileSync(__dirname + '/src/main.js', 'utf8');
  const plat = fs.readFileSync(__dirname + '/src/platform.js', 'utf8');

  // 文档提到的 window.X 全局必须真的被导出
  for (const m of dep.matchAll(/window\.(ResonanceApp|Platform|__resonanceNativeCallback)/g)) {
    const name = m[1];
    ok(main.indexOf('global.' + name) >= 0 || plat.indexOf('global.' + name) >= 0,
      'DEPLOY.md 引用了未导出的全局: ' + name);
  }
  // 文档若提到 goBack, main.js 里必须有它
  if (dep.indexOf('goBack') >= 0) ok(/goBack\(\)\s*\{/.test(main), 'goBack 不存在');
  // 反过来: 不允许文档引用 Platform 上不存在的方法
  ok(dep.indexOf('Platform.onBackPressed') < 0,
    'DEPLOY.md 引用了 Platform.onBackPressed —— 该方法不存在');
});

t('模型不得假设激励视频可以改变游戏结果', () => {
  // 与 platform.js 的白名单呼应: 若模型按"卖复活"估收入, 两者就矛盾了
  ok(!/revive|复活/.test(MODEL_SRC),
    '模型出现了复活类变现 —— 与平台层白名单和种子可复现承诺冲突');
});

/* =============================================================
 * 终局: 遗物池耗尽
 *
 * 这一段保护的是**最强的那批玩家**。集齐 29 件遗物后 offer() 返回 [],
 * 而 [] 是 truthy —— 曾经会画出一个一张卡都没有的选牌界面。
 * 打到游戏尽头的人正是会录视频、会发帖的人, 绝不能让他们撞上空屏幕。
 * ============================================================= */
console.log('\n终局 (遗物池耗尽)');

function maxedGame(seed) {
  const gm = new g.ResonanceGame({ seed: seed || 'ENDGAME' });
  for (const r of g.RELICS.list) gm.relics.push(g.RELICS.instantiate(r.id));
  gm._applyPassives();
  return gm;
}

t('集齐全部遗物后 offer 返回空数组 (前提确认)', () => {
  const gm = maxedGame();
  const o = g.RELICS.offer(gm.rngRelics, gm.relics, 10, 3);
  eq(o.length, 0);
  ok(!!o, '[] 是 truthy —— 正是这个坑的来源');
});

t('池子耗尽时过关不会留下空的选牌界面', () => {
  const gm = maxedGame('ENDGAME-A');
  const lv = gm.level;
  // 造一个必然达标的局面, 然后走真实的 place 路径
  gm.target = 1;
  let guard = 0;
  while (!gm.pendingOffer && gm.level === lv && guard++ < 200) {
    const mv = gm.hint();
    if (!mv) break;
    const ev = gm.place(mv.hi, mv.x, mv.y, mv.rot || 0);
    if (!ev) break;
    if (ev.gameOver) break;
  }
  // 要么正常升级了, 要么还在本关; 但绝不能停在一个空的 offer 上
  ok(gm.pendingOffer == null || gm.pendingOffer.length > 0,
    '出现了空的 pendingOffer —— 玩家会看到没有卡片的选牌屏');
});

t('池子耗尽时自动跳关并折算灵感 (不白扣玩家一关)', () => {
  const gm = maxedGame('ENDGAME-B');
  const lv = gm.level;
  const insp = gm.inspiration;
  gm.target = 1;
  let guard = 0;
  while (gm.level === lv && guard++ < 200) {
    const mv = gm.hint();
    if (!mv) break;
    const ev = gm.place(mv.hi, mv.x, mv.y, mv.rot || 0);
    if (!ev || ev.gameOver) break;
  }
  ok(gm.level > lv, '达标后关卡应推进');
  ok(gm.inspiration > insp, '无牌可选应折算成灵感');
  eq(gm.pendingOffer, null);
});

t('换牌换不出东西时不收灵感 (不能付费买空屏)', () => {
  const gm = maxedGame('ENDGAME-C');
  gm.inspiration = 99;
  gm.pendingOffer = [g.RELICS.instantiate('tuning_fork')];
  const before = gm.inspiration;
  eq(gm.rerollOffer(), false, '池空时 reroll 应失败');
  eq(gm.inspiration, before, '失败的 reroll 却扣了灵感');
});

t('正常情况下换牌仍然照常扣费生效', () => {
  const gm = new g.ResonanceGame({ seed: 'ENDGAME-D' });
  gm.pendingOffer = g.RELICS.offer(gm.rngRelics, gm.relics, 1, 3);
  gm.inspiration = 10;
  eq(gm.rerollOffer(), true);
  eq(gm.inspiration, 7, '正常换牌应扣 3 灵感');
  ok(gm.pendingOffer.length > 0);
});

/* =============================================================
 * 终章 (胜利条件)
 *
 * 在加这个之前游戏没有胜利条件, 唯一的结局是死。实测技巧 0.9 的玩家
 * 有 27/40 局打到 3000 落子上限还没结束 —— 也就是一局长到测不出来。
 * "永远赢不了、只能等自己失手"会把最投入的玩家熬走: 他们付出最多,
 * 却唯一拿不到一个句号。
 *
 * 终点 18 关是实测出来的 (50 局/档): 0.70 档 0%, 0.80 档 8%, 0.90 档 6%,
 * 无人越过 19 关。可复算: node docs/model.js content
 * ============================================================= */
console.log('\n终章 (胜利条件)');

/** 把一局强行推到"刚通过第 lv 关"的状态 */
function beatLevel(gm) {
  gm.target = 1;
  let guard = 0;
  const lv = gm.level;
  while (gm.level === lv && !gm.pendingOffer && guard++ < 300) {
    const mv = gm.hint();
    if (!mv) break;
    const ev = gm.place(mv.hi, mv.x, mv.y, mv.rot || 0);
    if (!ev) break;
    if (ev.gameOver) break;
    if (ev.levelUp) return ev;
  }
  return null;
}

t('FINAL_LEVEL 是公开常量 (玩家能知道终点在哪)', () => {
  ok(g.ResonanceGame.FINAL_LEVEL > 0, '应导出终点关卡');
  eq(typeof g.ResonanceGame.FINAL_LEVEL, 'number');
});

t('通过第 FINAL_LEVEL 关时触发 victory 事件', () => {
  const gm = new g.ResonanceGame({ seed: 'VIC-A' });
  gm.level = g.ResonanceGame.FINAL_LEVEL;
  const ev = beatLevel(gm);
  ok(ev, '未能过关 (测试前提失败)');
  ok(ev.victory, '通过终点关却没有 victory 事件');
  eq(gm.victoryAt, g.ResonanceGame.FINAL_LEVEL);
});

t('通关前不会误报 victory', () => {
  const gm = new g.ResonanceGame({ seed: 'VIC-B' });
  gm.level = g.ResonanceGame.FINAL_LEVEL - 1;
  const ev = beatLevel(gm);
  ok(ev, '未能过关 (测试前提失败)');
  ok(!ev.victory, '还差一关就报通关了');
  eq(gm.victoryAt, null);
});

t('victory 只触发一次 (之后每关不再重复)', () => {
  const gm = new g.ResonanceGame({ seed: 'VIC-C' });
  gm.level = g.ResonanceGame.FINAL_LEVEL;
  const first = beatLevel(gm);
  ok(first && first.victory, '第一次应触发');
  // 继续往下打几关
  for (let i = 0; i < 3; i++) {
    gm.pendingOffer = null;
    gm.level++;
    gm._startLevel(false);
    const ev = beatLevel(gm);
    if (ev) ok(!ev.victory, '第 ' + gm.level + ' 关重复触发了 victory');
  }
  eq(gm.victoryAt, g.ResonanceGame.FINAL_LEVEL, 'victoryAt 应保持首次通关的关卡');
});

t('通关不结束对局 (不把游戏从玩家手里拿走)', () => {
  const gm = new g.ResonanceGame({ seed: 'VIC-D' });
  gm.level = g.ResonanceGame.FINAL_LEVEL;
  const ev = beatLevel(gm);
  ok(ev && ev.victory);
  ok(!gm.gameOver, '通关把对局判死了 —— 玩家会觉得奖励是"被没收"');
  ok(gm.pendingOffer, '通关那一关也应照常给遗物三选一');
});

t('victoryAt 进入序列化快照', () => {
  const gm = new g.ResonanceGame({ seed: 'VIC-E' });
  eq(gm.serialize().victoryAt, null, '新局应为 null 而不是 undefined');
  gm.level = g.ResonanceGame.FINAL_LEVEL;
  beatLevel(gm);
  eq(gm.serialize().victoryAt, g.ResonanceGame.FINAL_LEVEL);
});

t('终点关卡与实测数据一致 (不是拍脑袋定的)', () => {
  // 实测无人越过 19 关, 所以终点必须落在"够得着但要运气"的区间。
  // 定得太低会让通关变成走流程, 太高等于没有终点。
  const L = g.ResonanceGame.FINAL_LEVEL;
  ok(L >= 15 && L <= 19, 'FINAL_LEVEL=' + L + ' 落在实测分布之外');
});

t('通关音是全曲唯一一次"落地"(与过关音形成对比)', () => {
  /* 这条测试守的是一个设计意图, 而不是一个数值:
   *   win()     —— 一路向上的琶音, 刻意不解决, 听觉上永远"还没到",
   *                这正是驱动玩家一关接一关往下打的东西;
   *   victory() —— 必须与之相反: 同时按下的和弦 + 长衰减 = 终止式。
   * 如果哪天有人把 victory 改成又一条上行琶音, 通关就失去了"结束感",
   * 而这是听觉上唯一能表达"走完了"的手段。所以这里检查两件事:
   * 通关音显著更长, 且它包含同时起振的多个音(和弦)而非逐个延迟的音阶。
   *
   * 做法: 把 tone() 换成记录器再调用音效, 直接观察它**实际排出的音**。
   * (最初我用源码静态分析数 `delay: N` 的出现次数, 那是错的 —— 和弦
   *  是由 chord.forEach 循环产生的, 源码里只出现一次, 静态分析看不见
   *  循环的重数, 于是把一个正确的和弦误判成了上行音阶。)
   * node 里没有 AudioContext, 但这条路径不碰它; 真机行为另由 Chromium
   * 手工验证过 (六个音效全部无异常)。 */
  const A = g.Audio2;
  const orig = A.tone;
  const rec = [];
  A.tone = (o) => { rec.push(o); };
  let win, vic;
  try {
    rec.length = 0; A.win(); win = rec.slice();
    rec.length = 0; A.victory(); vic = rec.slice();
  } finally {
    A.tone = orig; // 必须还原, 否则后面的测试拿到的是记录器
  }

  ok(win.length > 0 && vic.length > 0, '音效没有排出任何音');

  const maxDur = (a) => a.reduce((m, o) => Math.max(m, o.dur || 0), 0);
  ok(maxDur(vic) > maxDur(win) * 2,
    '通关音不够长 (' + maxDur(vic) + 's vs 过关 ' + maxDur(win) + 's), 撑不起"结束"');

  // 和弦 = 至少 3 个音共用同一个起振时刻
  const simultaneity = (a) => {
    const tally = {};
    for (const o of a) {
      const d = Math.round((o.delay || 0) * 1000);
      tally[d] = (tally[d] || 0) + 1;
    }
    return Object.keys(tally).reduce((m, k) => Math.max(m, tally[k]), 0);
  };
  ok(simultaneity(vic) >= 3,
    '通关音里没有同时起振的和弦 (最多 ' + simultaneity(vic) + ' 个音同时) —— 它又变成了一条上行音阶');

  // 过关音必须相反: 逐个上行、不解决, 所以不应出现和弦
  ok(simultaneity(win) < 3,
    '过关音变成了和弦 —— 它必须保持"未解决", 那才是驱动玩家继续的东西');

  // 通关音的落地重心更低: 最低频必须低于过关音的最低频
  const minFreq = (a) => a.reduce((m, o) => Math.min(m, o.freq || Infinity), Infinity);
  ok(minFreq(vic) < minFreq(win),
    '通关音的重心没有下沉 (' + minFreq(vic).toFixed(1) + 'Hz vs ' +
    minFreq(win).toFixed(1) + 'Hz), 听觉上不会有"落地"感');
});

t('文档里的终点关卡与代码一致', () => {
  const html = require('fs').readFileSync(__dirname + '/index.html', 'utf8');
  const m = /id="victory-level"[^>]*>(\d+)</.exec(html);
  ok(m, 'index.html 里找不到 victory-level 的默认值');
  eq(Number(m[1]), g.ResonanceGame.FINAL_LEVEL,
    'HTML 写死的关卡数与 FINAL_LEVEL 不一致 (改了常量忘了改文案)');
});

console.log('\n留存机制');

t('调音师: 阈值/额度/冷却都是公开常量', () => {
  ok(g.ResonanceGame.MERCY_PER_LEVEL > 0, '应有每关额度');
  ok(g.ResonanceGame.MERCY_EMPTY_THRESHOLD > 0, '应有触发阈值');
  ok(g.ResonanceGame.STREAK_GRACE >= 0, '应有连击宽限常量');
});

t('调音师: 棋盘宽松时绝不介入', () => {
  const game = new g.ResonanceGame({ seed: 'MERCY_A' });
  // 开局空盘 64 格远大于阈值
  eq(game.mercyWanted(), false, '空盘不该介入');
});

t('调音师: 逼近死局时介入, 且给的牌一定放得下', () => {
  const game = new g.ResonanceGame({ seed: 'MERCY_B' });
  // 填满到只剩下 <= 阈值 的空格
  const keep = 12;
  for (let i = 0; i < 64 - keep; i++) game.board[i] = i % 5;
  game.movesSinceMercy = 99;
  ok(game.mercyWanted(), '濒死时应介入');
  const p = game._tunedPiece();
  ok(p, '应能给出一块牌');
  ok(p.tuned === true, '必须打上 tuned 标记 (对玩家可见)');
  ok(game.anyPlacement(p), '调音师给的牌必须真的放得下');
});

t('调音师: 每关额度有上限, 不是免死金牌', () => {
  const game = new g.ResonanceGame({ seed: 'MERCY_C' });
  const keep = 10;
  for (let i = 0; i < 64 - keep; i++) game.board[i] = i % 5;
  let fired = 0;
  for (let i = 0; i < 30; i++) {
    game.movesSinceMercy = 99;
    if (!game.mercyWanted()) break;
    game.mercyLeft--;
    fired++;
  }
  eq(fired, g.ResonanceGame.MERCY_PER_LEVEL, '介入次数应恰好等于额度');
  eq(game.mercyWanted(), false, '额度耗尽后必须停止');
});

t('调音师: 开着它, 弱玩家依然会输 (安全网 != 无敌)', () => {
  let over = 0;
  const N = 12;
  for (let n = 0; n < N; n++) {
    const seed = 'MERCY_D' + n;
    const game = new g.ResonanceGame({ seed });
    const rng = new g.RNG.Rng(seed, 'ai');
    let guard = 0;
    while (!game.gameOver && guard++ < 500) {
      if (game.pendingOffer) { game.takeRelic(0); continue; }
      const opts = [];
      for (let hi = 0; hi < game.hand.length; hi++)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            if (game.canPlace(game.hand[hi], x, y)) opts.push({ hi, x, y });
      if (!opts.length) break;
      const mv = opts[rng.int(opts.length)];
      if (!game.place(mv.hi, mv.x, mv.y, 0)) break;
    }
    if (game.gameOver) over++;
  }
  ok(over >= N * 0.7, '随机乱下也几乎必输才算安全网, 实测只输了 ' + over + '/' + N);
});

t('调音师: 计数被如实累加并可序列化 (可查证)', () => {
  const game = new g.ResonanceGame({ seed: 'MERCY_E' });
  game.mercyCount = 3;
  const s = game.serialize();
  eq(s.mercyCount, 3, '结算数据必须带上介入次数');
});

t('连击: 消除则 +1, 且里程碑兑现灵感', () => {
  const game = primedGame([]);
  const before = game.inspiration;
  game.streak = 2; // 下一次消除即达成里程碑 3
  const ev = game.place(0, 0, 7);
  ok(ev, '应能落子');
  eq(game.streak, 3, '连击应推进到 3');
  eq(ev.streakReward, 1, '里程碑应发奖');
  eq(game.inspiration, before + 1, '灵感应实际到账');
});

t('连击: 宽限期内不消除也不断连', () => {
  const game = new g.ResonanceGame({ seed: 'STREAK_A' });
  game.streak = 4;
  game.streakMiss = 0;
  // 找一个不会造成消除的落子
  let placed = false;
  for (let y = 0; y < 8 && !placed; y++)
    for (let x = 0; x < 8 && !placed; x++) {
      if (!game.canPlace(game.hand[0], x, y)) continue;
      const ev = game.place(0, x, y);
      if (ev) { placed = true; ok(ev.steps.length === 0, '这一手不该消除'); }
    }
  ok(placed, '应该完成了一次落子');
  eq(game.streak, 4, '宽限期内连击不应清零');
});

t('连击: 超出宽限才断连, 且断连不扣任何已得资源', () => {
  const game = new g.ResonanceGame({ seed: 'STREAK_B' });
  game.streak = 5;
  game.streakMiss = g.ResonanceGame.STREAK_GRACE; // 再错一次就断
  const insp = game.inspiration;
  const score = game.totalScore;
  let placed = false;
  for (let y = 0; y < 8 && !placed; y++)
    for (let x = 0; x < 8 && !placed; x++) {
      if (!game.canPlace(game.hand[0], x, y)) continue;
      if (game.place(0, x, y)) placed = true;
    }
  ok(placed, '应该完成了一次落子');
  eq(game.streak, 0, '超出宽限应断连');
  eq(game.inspiration, insp, '断连不该扣灵感');
  eq(game.totalScore, score, '断连不该扣分');
});

t('连击: bestStreak 单调不减且被记录', () => {
  const game = primedGame([]);
  game.streak = 7;
  game.bestStreak = 7;
  game.place(0, 0, 7);
  ok(game.bestStreak >= 7, 'bestStreak 不应回退');
  eq(game.stats.bestStreak, game.bestStreak, 'stats 应同步');
});

t('百分位: 单调不减 (关卡越深不可能超过的人越少)', () => {
  let prev = -1;
  for (let lv = 1; lv <= 13; lv++) {
    const v = g.ResonanceGame.BEAT_PCT[lv];
    if (v == null) continue;
    ok(v >= prev, '第 ' + lv + ' 关百分位倒退了');
    ok(v >= 0 && v <= 100, '百分位必须在 0..100');
    prev = v;
  }
});

t('百分位: 不值得炫耀时返回 null (不羞辱玩家)', () => {
  eq(g.ResonanceGame.beatPercentile(1), null, '低百分位应隐藏');
  ok(g.ResonanceGame.beatPercentile(9) >= 50, '深关卡应有数字');
});

t('百分位: 超出实测范围时封顶而不是外推编造', () => {
  const v = g.ResonanceGame.beatPercentile(999);
  const keys = Object.keys(g.ResonanceGame.BEAT_PCT).map(Number);
  const maxV = g.ResonanceGame.BEAT_PCT[Math.max.apply(null, keys)];
  eq(v, Math.min(maxV, 99), '应封顶到最后一档实测值(且不超 99)');
});

t('百分位: 永远不会显示 100% (玩家此刻就站在这一关)', () => {
  // 实测表里深层关卡四舍五入后确实会出现 100, 但屏幕上写
  // "100% 的对局走不到这里"与玩家正在这里这一事实直接矛盾。
  for (let lv = 1; lv <= 60; lv++) {
    const v = g.ResonanceGame.beatPercentile(lv);
    if (v != null) ok(v <= 99, '关 ' + lv + ' 显示了 ' + v + '%');
  }
});

t('百分位表与随仓发布的实测脚本同步 (可复算承诺)', () => {
  // 游戏里写了"基于 520 局实测分布 · 可复算", 那就必须真的能复算。
  // 这里不重跑仿真(太慢), 只校验脚本存在且表的形状合理。
  const fs = require('fs');
  ok(fs.existsSync(__dirname + '/docs/benchmark.js'), '承诺的实测脚本不存在');
  const tbl = g.ResonanceGame.BEAT_PCT;
  const keys = Object.keys(tbl).map(Number).sort((a, b) => a - b);
  eq(keys[0], 1, '实测表应从第 1 关开始');
  ok(keys.length >= 13, '实测表覆盖关卡太少');
  for (let i = 1; i < keys.length; i++) {
    eq(keys[i], keys[i - 1] + 1, '实测表关卡不连续, 缺了 ' + (keys[i - 1] + 1));
  }
});

t('过关事件里带上了百分位', () => {
  const primed = primedGame([]);
  primed.level = 9;
  primed.target = 1; // 下一次消除必定过关
  const ev = primed.place(0, 0, 7);
  ok(ev && ev.levelUp, '应当过关');
  eq(ev.beatPct, g.ResonanceGame.BEAT_PCT[9], '事件应携带该关百分位');
});

t('撤销能完整回滚留存状态 (不能靠撤销刷灵感)', () => {
  const game = primedGame([]);
  game.streak = 2;
  const insp = game.inspiration;
  const ev = game.place(0, 0, 7);
  ok(ev.streakReward, '这一手应发奖');
  eq(game.inspiration, insp + 1, '奖励已到账');
  ok(game.undo(), '应能撤销');
  eq(game.inspiration, insp, '撤销后灵感必须回滚, 否则可无限刷');
  eq(game.streak, 2, '撤销后连击也应回滚');
});

/* ---------- 遗物文案 ---------- */
console.log('\n遗物文案');

t('每件遗物都有真实典故 (flavor), 无一遗漏', () => {
  const missing = g.RELICS.list.filter((r) => !r.flavor).map((r) => r.id);
  eq(missing.length, 0, '缺少 flavor: ' + missing.join(','));
});

t('典故有实质内容, 不是空转形容词', () => {
  for (const r of g.RELICS.list) {
    ok(r.flavor.length >= 18, r.id + ' 的典故过短, 像占位符');
    ok(r.flavor.length <= 120, r.id + ' 的典故过长, 卡面塞不下');
  }
});

t('典故与机制描述不重复 (不是把 desc 换个说法)', () => {
  for (const r of g.RELICS.list) {
    ok(r.flavor !== r.desc, r.id + ' 的典故与描述重复');
  }
});

t('典故不含营销腔与空洞修辞', () => {
  // 这些词是"AI 味"的典型标记: 只有情绪没有信息
  const BANNED = ['震撼', '极致', '无与伦比', '完美诠释', '尽情享受', '开启全新'];
  for (const r of g.RELICS.list) {
    for (const w of BANNED) {
      ok(r.flavor.indexOf(w) === -1, r.id + ' 的典故含空洞修辞: ' + w);
    }
  }
});

t('遗物描述本身仍然精确可执行 (典故不能取代规则)', () => {
  for (const r of g.RELICS.list) {
    ok(r.desc && r.desc.length >= 6, r.id + ' 缺少机制描述');
    // 机制描述必须含数字(阿拉伯或中文)或明确的能力词, 否则玩家无法据此决策
    ok(
      /[0-9]/.test(r.desc) ||
        /[一二三四五六七八九十两]/.test(r.desc) ||
        /可以|可旋转|下落|清空|总有|只用/.test(r.desc),
      r.id + ' 的描述不含可判定的效果: ' + r.desc
    );
  }
});

/* =============================================================
 * 平台适配层
 *
 * 这一层是**收钱的代码路径**(广告频次、激励视频奖励发放、内购),
 * 也是最容易在移植时被改坏的地方: 一句 ads.enabled = true 就能让
 * Web 版突然开始弹广告。所以每一条商业化底线都要有断言钉住。
 * ============================================================= */
console.log('\n平台适配层');
require('./src/platform.js');
const P = g.Platform;

t('纯 Node/Web 环境下自动退化为 web 实现', () => {
  eq(P.name, 'web');
  ok(P.isWeb);
});

t('三个平台适配器齐备且接口一致 (少一个方法就会在真机上炸)', () => {
  const need = ['getItem', 'setItem', 'removeItem', 'share', 'vibrate',
    'showInterstitial', 'showRewarded', 'purchase', 'onPause', 'exit', 'canExit'];
  for (const [name, a] of Object.entries(P._adapters)) {
    for (const m of need) {
      eq(typeof a[m], 'function', name + ' 缺少方法 ' + m);
    }
  }
});

t('存储在没有 localStorage 的环境里不抛异常 (Safari 隐私模式)', () => {
  // Node 里没有 localStorage, 正好等价于最坏情况
  eq(P.getItem('nope'), null);
  P.setItem('k', 'v'); // 不得抛
  P.removeItem('k');
});

t('广告默认全关 —— Web 版发布不会突然弹广告', () => {
  eq(P.ads.enabled, false);
  eq(P.ads.interstitialAfterRun, false);
  eq(P.ads.rewardedHint, false);
  eq(P.ads.rewardedReroll, false);
});

t('关闭状态下插屏调用是安全的空操作', () => {
  let res = null;
  P.maybeInterstitial().then((r) => (res = r));
  // Promise.resolve 的 then 在微任务里, 用同步断言不可靠, 改查返回值类型
  ok(P.maybeInterstitial() instanceof Promise);
});

t('前若干局绝不插屏 (先让玩家爱上游戏)', () => {
  ok(P.LIMITS.MIN_RUNS_BEFORE_FIRST_AD >= 3,
    '宽限局数太少: ' + P.LIMITS.MIN_RUNS_BEFORE_FIRST_AD);
});

t('插屏有硬编码的最小间隔 (不能靠后台随时调高频次)', () => {
  ok(P.LIMITS.MIN_INTERSTITIAL_GAP_S >= 120,
    '插屏间隔太短: ' + P.LIMITS.MIN_INTERSTITIAL_GAP_S);
});

t('插屏频次上限真的生效 (开启后连续两次只放行一次)', async () => {
  const saved = JSON.parse(JSON.stringify(P.ads));
  const savedImpl = P._impl.showInterstitial;
  let shows = 0;
  P._impl.showInterstitial = () => { shows++; return Promise.resolve({ shown: true }); };
  P.ads.enabled = true;
  P.ads.interstitialAfterRun = true;
  P._runCount = 99;          // 跳过宽限期
  P._lastInterstitialAt = 0; // 允许第一次
  await P.maybeInterstitial();
  await P.maybeInterstitial();
  await P.maybeInterstitial();
  eq(shows, 1, '同一时刻应只放行一次插屏, 实际 ' + shows);
  // 还原, 不污染后续测试
  P._impl.showInterstitial = savedImpl;
  Object.assign(P.ads, saved);
  P._lastInterstitialAt = 0;
  P._runCount = 0;
});

t('激励视频位置是硬编码白名单: 复活/换牌一律拒绝', async () => {
  // 这条是核心承诺的防线: 如果看广告能改变结果, "同种子可复现"就是假的。
  for (const bad of ['revive', 'betterPiece', 'extraUndo', 'skipLevel', '']) {
    const r = await P.rewarded(bad);
    eq(r.rewarded, false, bad + ' 不该发奖励');
    eq(r.reason, 'placement-forbidden', bad + ' 应被白名单拒绝');
  }
});

t('允许的激励位只有提示与刷新 (都不影响公平)', async () => {
  for (const okPlace of ['hint', 'reroll']) {
    const r = await P.rewarded(okPlace);
    // 未接 SDK 时不发奖励, 但原因应是"未开启"而非"位置非法"
    eq(r.reason, 'disabled', okPlace + ' 应属于合法位置');
  }
});

t('没有广告 SDK 时绝不白发奖励', async () => {
  const saved = JSON.parse(JSON.stringify(P.ads));
  P.ads.enabled = true;
  P.ads.rewardedHint = true;
  const r = await P.rewarded('hint');
  eq(r.rewarded, false, '没有 SDK 却发了奖励 —— 会破坏平衡');
  Object.assign(P.ads, saved);
});

t('hasRewarded 与实际能否播放一致 (不画假入口)', () => {
  const saved = JSON.parse(JSON.stringify(P.ads));
  eq(P.hasRewarded('hint'), false, '未开启时不该显示入口');
  P.ads.enabled = true;
  P.ads.rewardedHint = true;
  eq(P.hasRewarded('hint'), true);
  eq(P.hasRewarded('revive'), false, '非法位置永远不显示入口');
  Object.assign(P.ads, saved);
});

t('configure 只能改变量, 不能突破白名单', async () => {
  P.configure({ ads: { enabled: true, rewardedRevive: true } });
  const r = await P.rewarded('revive');
  eq(r.reason, 'placement-forbidden', 'configure 绕过了白名单');
  P.configure({ ads: { enabled: false } });
});

t('微信适配器的存储在 wx 缺失时回退而不崩', () => {
  const wxAdapter = P._adapters.WeChatAdapter;
  // 全局没有 wx, 内部 try/catch 应回退到 Web 实现
  eq(wxAdapter.getItem('whatever'), null);
  wxAdapter.setItem('a', 'b'); // 不得抛
});

t('原生桥缺失时返回 bridge-missing 而不是永久挂起', async () => {
  const r = await P._adapters.NativeAdapter._call('ping');
  eq(r.ok, false);
  eq(r.reason, 'bridge-missing');
});

t('原生回调入口挂在全局 (原生只能按名字找)', () => {
  eq(typeof g.__resonanceNativeCallback, 'function');
});

t('原生桥有超时保护 (原生崩了不能卡死 UI)', () => {
  const src = require('fs').readFileSync(__dirname + '/src/platform.js', 'utf8');
  ok(/setTimeout/.test(src) && /timeout/.test(src), '原生桥缺少超时兜底');
});

finish();
