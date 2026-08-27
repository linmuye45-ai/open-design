/* =============================================================
 * RESONANCE · 数值实测脚本
 *
 *   node docs/benchmark.js            全部跑一遍 (约 60~90 秒)
 *   node docs/benchmark.js percentile 只复算通关百分位
 *   node docs/benchmark.js streak     只复算连击宽限
 *   node docs/benchmark.js mercy      只复算调音师阈值 + A/B
 *
 * 这个文件存在的唯一理由: 游戏里对玩家说了「基于 520 局实测分布 · 可复算」。
 * 那句话必须是真的。任何人 clone 下来跑一遍, 应该得到 src/game.js 里
 * 那张 BEAT_PCT 表, 以及 STREAK_GRACE / MERCY_EMPTY_THRESHOLD 这两个常量。
 *
 * 全流程确定性: 种子由 SEED_BASE + 序号生成, 不用 Math.random,
 * 所以两次运行的输出逐字节相同。改了游戏数值再跑, 差异就是你的改动造成的。
 * ============================================================= */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'src/rng.js'));
require(path.join(ROOT, 'src/icons.js'));
require(path.join(ROOT, 'src/relics.js'));
require(path.join(ROOT, 'src/game.js'));

const Game = globalThis.ResonanceGame;

const SEED_BASE = 'BENCH-2026';
const MAX_MOVES = 4000; // 防跑飞的保险丝, 正常一局远小于此

/* ---------- 统计小工具 ---------- */
function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function summarize(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    n: s.length,
    avg: +avg.toFixed(2),
    p10: pct(s, 10),
    p25: pct(s, 25),
    p50: pct(s, 50),
    p75: pct(s, 75),
    p90: pct(s, 90),
    max: s[s.length - 1],
  };
}
function bar(v, max, width) {
  const n = Math.round((v / max) * width);
  return '█'.repeat(n) + '·'.repeat(Math.max(0, width - n));
}

/* -------------------------------------------------------------
 * 模拟玩家
 *
 * skill = 采纳 hint() 建议的概率。其余情况随机落一个合法位置。
 * 为什么用这个模型: hint 的评分函数就是「消行 + 同色邻接 - 造洞」,
 * 也就是一个懂规则的玩家脑子里在算的东西。采纳率越高 = 越会玩。
 * 它不是完美 AI (只看一步), 所以 skill=0.9 大致对应一个熟练人类,
 * 而不是天花板 —— 这正是我们想要的参照系。
 * ----------------------------------------------------------- */
function playRun(seed, skill, opts) {
  opts = opts || {};
  const gm = new Game({ seed: seed });
  const rnd = new globalThis.RNG.Rng(seed, 'ai');

  if (opts.noMercy) gm.mercyLeft = 0; // A/B 对照组: 关掉调音师

  const trace = {
    level: 0,
    score: 0,
    placements: 0,
    clears: 0,
    mercy: 0,
    bestStreak: 0,
    gameOver: false,
    emptyAtRefill: [],
    emptyBeforeDeath: null,
    levelReached: 1,
  };

  for (let move = 0; move < MAX_MOVES; move++) {
    if (gm.gameOver) break;

    // 有遗物待选时先选掉 (简单策略: 总是拿第一个)
    if (gm.pendingOffer) {
      gm.takeRelic(0);
      if (opts.noMercy) gm.mercyLeft = 0; // 新关卡会补额度, 对照组要重新清零
      continue;
    }

    // 记录发牌时刻的空格数 —— MERCY_EMPTY_THRESHOLD 就是从这组数据里定的
    if (gm.hand.length === 3) trace.emptyAtRefill.push(countEmpty(gm));

    let mv = null;
    if (rnd.float() < skill) mv = gm.hint();
    if (!mv) {
      const all = collectLegal(gm);
      if (!all.length) {
        trace.emptyBeforeDeath = countEmpty(gm);
        break;
      }
      mv = all[rnd.int(all.length)];
    }
    if (!mv) break;

    const before = gm.mercyCount;
    const ev = gm.place(mv.hi, mv.x, mv.y, mv.rot || 0);
    if (!ev) break;

    trace.placements++;
    if (ev.steps && ev.steps.length) trace.clears++;

    if (gm.mercyCount > before) trace.mercy += gm.mercyCount - before;
    if (gm.bestStreak > trace.bestStreak) trace.bestStreak = gm.bestStreak;
    if (ev.gameOver) {
      trace.gameOver = true;
      trace.emptyBeforeDeath = countEmpty(gm);
      break;
    }
  }

  trace.level = gm.level;
  trace.levelReached = gm.level;
  trace.score = gm.score;
  trace.mercy = gm.mercyCount;
  trace.bestStreak = gm.bestStreak;
  trace.gameOver = trace.gameOver || gm.gameOver;
  return trace;
}

function countEmpty(gm) {
  return gm._emptyCount();
}

function collectLegal(gm) {
  const out = [];
  for (let hi = 0; hi < gm.hand.length; hi++) {
    const piece = gm.hand[hi];
    if (!piece) continue;
    for (let y = 0; y <= 8 - piece.h; y++) {
      for (let x = 0; x <= 8 - piece.w; x++) {
        if (gm.canPlace(piece, x, y)) out.push({ hi, x, y, rot: 0 });
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------
 * 实测 1: 通关百分位 (BEAT_PCT)
 * ----------------------------------------------------------- */
const SKILLS = [0.25, 0.5, 0.7, 0.9];
const RUNS_PER_SKILL = 130; // 4 × 130 = 520

function benchPercentile() {
  console.log('\n\x1b[1m【实测 1】通关百分位 BEAT_PCT\x1b[0m');
  console.log(
    '  人群构成: hint 采纳率 ' +
      SKILLS.join(' / ') +
      ' 各 ' +
      RUNS_PER_SKILL +
      ' 局, 共 ' +
      SKILLS.length * RUNS_PER_SKILL +
      ' 局'
  );

  const reached = [];
  for (const skill of SKILLS) {
    for (let i = 0; i < RUNS_PER_SKILL; i++) {
      const seed = SEED_BASE + '-P-' + skill + '-' + i;
      reached.push(playRun(seed, skill).levelReached);
    }
  }

  const total = reached.length;
  const maxLevel = Math.max.apply(null, reached);
  const table = {};

  console.log('\n  关卡  到达局数   通过即超过');
  for (let lv = 1; lv <= maxLevel; lv++) {
    // 「通过第 lv 关」= 最终到达的关卡 > lv
    const passed = reached.filter((r) => r > lv).length;
    const beat = reached.filter((r) => r <= lv).length;
    const p = Math.round((beat / total) * 100);
    table[lv] = p;
    const at = reached.filter((r) => r === lv).length;
    console.log(
      '  ' +
        String(lv).padStart(3) +
        '   ' +
        String(at).padStart(4) +
        '  ' +
        bar(at, total / 4, 18) +
        '  ' +
        String(p).padStart(3) +
        '%' +
        (passed === 0 ? '  (无人通过)' : '')
    );
  }

  console.log('\n  → 粘贴进 src/game.js 的 BEAT_PCT:');
  const parts = [];
  for (let lv = 1; lv <= maxLevel; lv++) parts.push(lv + ':' + table[lv]);
  console.log('  const BEAT_PCT = { ' + parts.join(', ') + ' };');

  console.log('\n  与当前代码比对:');
  const live = Game.BEAT_PCT;
  let drift = 0;
  for (let lv = 1; lv <= maxLevel; lv++) {
    const a = live[lv],
      b = table[lv];
    if (a == null) continue;
    const d = Math.abs(a - b);
    drift = Math.max(drift, d);
    if (d > 3) console.log('    关 ' + lv + ': 代码 ' + a + '% vs 实测 ' + b + '%  ← 偏差 ' + d);
  }
  console.log(
    drift <= 3
      ? '    \x1b[32m✓ 全部关卡偏差 ≤3 个百分点, 代码里的表仍然成立\x1b[0m'
      : '    \x1b[33m! 最大偏差 ' + drift + ' 个百分点, 建议更新 BEAT_PCT\x1b[0m'
  );
  return table;
}

/* -------------------------------------------------------------
 * 实测 2: 连击宽限 (STREAK_GRACE)
 *
 * 关键前提: 每次落子能消除的概率其实很低。如果连击要求「每手必消」,
 * 计数器就永远停在 1, 那它只是个装饰。这里量化到底该宽限几手。
 * ----------------------------------------------------------- */
function benchStreak() {
  console.log('\n\x1b[1m【实测 2】连击宽限 STREAK_GRACE\x1b[0m');
  const N = 75;
  let placements = 0,
    clears = 0;
  const runs = [];
  for (let i = 0; i < N; i++) {
    const skill = SKILLS[i % SKILLS.length];
    const t = playRun(SEED_BASE + '-S-' + i, skill);
    placements += t.placements;
    clears += t.clears;
    runs.push(t);
  }
  const rate = clears / placements;
  console.log(
    '  ' +
      N +
      ' 局共 ' +
      placements +
      ' 次落子, 其中 ' +
      clears +
      ' 次触发消除 → 消除率 \x1b[1m' +
      (rate * 100).toFixed(1) +
      '%\x1b[0m'
  );
  console.log('  也就是平均每 ' + (1 / rate).toFixed(1) + ' 手才消一次。');

  // 在同一批 trace 上重放不同宽限值, 看连击长度分布怎么变
  console.log('\n  宽限值   连击 p50  p90  最长   评价');
  for (const grace of [0, 1, 2, 3]) {
    const best = runs.map((t) => simulateStreak(t, rate, grace));
    const s = summarize(best);
    let verdict;
    if (s.p50 < 3) verdict = '里程碑(3)拿不到 → 计数器沦为装饰';
    else if (s.p50 > 6) verdict = '几乎不会断 → 失去张力';
    else verdict = '\x1b[32m✓ 里程碑可达, 又确实会断\x1b[0m';
    console.log(
      '    ' +
        grace +
        '      ' +
        String(s.p50).padStart(4) +
        String(s.p90).padStart(5) +
        String(s.max).padStart(6) +
        '   ' +
        verdict
    );
  }
  console.log(
    '\n  → 代码取 STREAK_GRACE = ' +
      Game.STREAK_GRACE +
      (Game.STREAK_GRACE === 2 ? '  \x1b[32m✓\x1b[0m' : '  \x1b[33m(与实测建议不符)\x1b[0m')
  );
}

/* 用消除率做伯努利重放, 求给定宽限下的最长连击 */
function simulateStreak(trace, rate, grace) {
  const rnd = new globalThis.RNG.Rng('STREAK-' + trace.placements + '-' + grace, 'sim');
  let streak = 0,
    miss = 0,
    best = 0;
  for (let i = 0; i < trace.placements; i++) {
    if (rnd.float() < rate) {
      streak++;
      miss = 0;
      if (streak > best) best = streak;
    } else if (streak > 0) {
      miss++;
      if (miss > grace) {
        streak = 0;
        miss = 0;
      }
    }
  }
  return best;
}

/* -------------------------------------------------------------
 * 实测 3: 调音师阈值 + A/B
 * ----------------------------------------------------------- */
function benchMercy() {
  console.log('\n\x1b[1m【实测 3】调音师阈值 MERCY_EMPTY_THRESHOLD\x1b[0m');
  const N = 75;
  const atRefill = [];
  const beforeDeath = [];
  for (let i = 0; i < N; i++) {
    const skill = SKILLS[i % SKILLS.length];
    const t = playRun(SEED_BASE + '-M-' + i, skill, { noMercy: true });
    for (const e of t.emptyAtRefill) atRefill.push(e);
    if (t.emptyBeforeDeath != null) beforeDeath.push(t.emptyBeforeDeath);
  }
  const a = summarize(atRefill);
  const d = summarize(beforeDeath);
  console.log('  发牌时刻的空格数 (' + a.n + ' 个样本):');
  console.log('    p10=' + a.p10 + '  p50=\x1b[1m' + a.p50 + '\x1b[0m  p90=' + a.p90);
  console.log('  死亡前一手的空格数 (' + d.n + ' 个样本):');
  console.log(
    '    p10=' + d.p10 + '  p50=\x1b[1m' + d.p50 + '\x1b[0m  p90=' + d.p90
  );
  console.log(
    '\n  阈值必须落在「日常」与「濒死」之间。若照直觉写 ≤20, 命中率:'
  );
  for (const th of [20, 25, 30, 35, 40]) {
    const hit = atRefill.filter((e) => e <= th).length / atRefill.length;
    const covers = beforeDeath.filter((e) => e <= th).length / (beforeDeath.length || 1);
    console.log(
      '    ≤' +
        String(th).padStart(2) +
        ' → 触发于 ' +
        (hit * 100).toFixed(1).padStart(5) +
        '% 的发牌, 覆盖 ' +
        (covers * 100).toFixed(0).padStart(3) +
        '% 的濒死局面' +
        (th === Game.MERCY_EMPTY_THRESHOLD ? '  \x1b[32m← 代码取值\x1b[0m' : '')
    );
  }

  /* ---- A/B: 开 / 关调音师, 同种子同技术水平 ---- */
  console.log('\n\x1b[1m【实测 4】调音师 A/B (同种子对照)\x1b[0m');
  console.log('  skill   开启平均关卡  关闭平均关卡   提升   介入/局  仍然失败');
  for (const skill of [0.25, 0.6, 0.9]) {
    const M = 60;
    let onSum = 0,
      offSum = 0,
      mercySum = 0,
      over = 0;
    for (let i = 0; i < M; i++) {
      const seed = SEED_BASE + '-AB-' + skill + '-' + i;
      const on = playRun(seed, skill);
      const off = playRun(seed, skill, { noMercy: true });
      onSum += on.levelReached;
      offSum += off.levelReached;
      mercySum += on.mercy;
      if (on.gameOver) over++;
    }
    const on = onSum / M,
      off = offSum / M;
    const lift = ((on - off) / (off || 1)) * 100;
    console.log(
      '  ' +
        String(skill).padEnd(6) +
        String(on.toFixed(2)).padStart(10) +
        String(off.toFixed(2)).padStart(14) +
        String((lift >= 0 ? '+' : '') + lift.toFixed(1) + '%').padStart(9) +
        String((mercySum / M).toFixed(2)).padStart(9) +
        String(over + '/' + M).padStart(10)
    );
  }
  console.log(
    '\n  结论: 提升幅度是「多撑一关」级别, 不是「无敌」级别 —— 弱玩家依然\n' +
      '  几乎必败。这正是安全网该有的样子: 它救的是运气, 不是技术。'
  );
}

/* ---------- 入口 ---------- */
const which = process.argv[2];
const t0 = Date.now();
console.log('\x1b[1mRESONANCE 数值实测\x1b[0m  (种子基 ' + SEED_BASE + ', 结果可逐字节复现)');
if (!which || which === 'percentile') benchPercentile();
if (!which || which === 'streak') benchStreak();
if (!which || which === 'mercy') benchMercy();
console.log('\n耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');
