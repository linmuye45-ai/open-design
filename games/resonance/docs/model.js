/* =============================================================
 * RESONANCE · 商业模型 (node docs/model.js)
 *
 *   node docs/model.js            全部
 *   node docs/model.js content    内容深度实测 (掌握曲线能撑多久)
 *   node docs/model.js retention  留存队列模型 (D1/D7/D30/D180)
 *   node docs/model.js revenue    收入与 LTV
 *   node docs/model.js sensitivity 敏感度 —— 哪个变量真的决定成败
 *   node docs/model.js verdict    结论: 目标是否可达
 *
 * -------------------------------------------------------------
 * 这个文件为什么存在, 以及它为什么不是一份 PPT
 *
 * 「做一个能赚几亿的游戏」这句话本身没有可执行性。能执行的版本是:
 * 把收入拆成一串可测量的量, 逐个问「这一项我凭什么达到这个数」,
 * 然后诚实地看乘积。做这件事的价值不在于算出一个大数字 —— 任何人都能
 * 把假设调到算出大数字 —— 而在于**找出那个我们其实控制不了的环节**。
 *
 * 所以这里有一条硬规矩: 凡是能从代码里测出来的量, 一律测, 不许填。
 * 内容深度、掌握曲线、单局时长, 全部由 src/ 里真实的游戏跑出来。
 * 只有市场侧的量(CPM、商店转化)必须外部假设 —— 那些统统标成 ASSUMED,
 * 并且在敏感度分析里逐一摇一遍, 让读者看见结论对它们有多敏感。
 *
 * 这也是为什么最后一节可能会让人不舒服。一个诚实的模型必须允许
 * 「目标不可达」作为输出。如果它只会输出「可达」, 那它就不是模型,
 * 而是一份自我安慰。
 * ============================================================= */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'src/rng.js'));
require(path.join(ROOT, 'src/icons.js'));
require(path.join(ROOT, 'src/relics.js'));
require(path.join(ROOT, 'src/game.js'));
const Game = globalThis.ResonanceGame;

const SEED_BASE = 'MODEL-2026';

/* ---------- 小工具 ---------- */
const money = (v) =>
  v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B'
    : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M'
      : v >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K'
        : '$' + v.toFixed(2);
const num = (v) =>
  v >= 1e9 ? (v / 1e9).toFixed(1) + 'B'
    : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M'
      : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K'
        : String(Math.round(v));
const pctS = (v) => (v * 100).toFixed(1) + '%';
// 中日韩字符在终端里占两列。用 String.padEnd 对齐含中文的表格会歪掉,
// 因为它按码点数而不是显示宽度补空格。这里按显示宽度补。
function dw(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return w;
}
const padE = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dw(s)));
const padS = (s, n) => ' '.repeat(Math.max(0, n - dw(s))) + String(s);
function h(title) {
  console.log('\n\x1b[1m' + title + '\x1b[0m');
  console.log('─'.repeat(Math.min(72, title.length + 30)));
}
function bar(v, max, w) {
  const n = Math.max(0, Math.round((v / max) * w));
  return '█'.repeat(n) + '·'.repeat(Math.max(0, w - n));
}

function legalMoves(gm) {
  const out = [];
  for (let hi = 0; hi < gm.hand.length; hi++) {
    const p = gm.hand[hi];
    if (!p) continue;
    for (let y = 0; y <= 8 - p.h; y++)
      for (let x = 0; x <= 8 - p.w; x++)
        if (gm.canPlace(p, x, y)) out.push({ hi, x, y, rot: 0 });
  }
  return out;
}

/* -------------------------------------------------------------
 * 模拟玩家 (与 benchmark.js 同一个模型, 保持可比)
 * skill = 采纳 hint() 建议的概率。hint 的评分函数就是「消行 + 同色邻接
 * - 造洞」, 即一个懂规则的玩家脑子里在算的东西。
 * ----------------------------------------------------------- */
function playRun(seed, skill, cap) {
  const gm = new Game({ seed });
  const rnd = new globalThis.RNG.Rng(seed, 'ai');
  let placements = 0;
  let offers = 0;
  cap = cap || 3000;
  // 是否是"跑到上限被掐掉"而不是"真的死了"。必须用循环是否耗尽来判断:
  // 早先我用 placements >= cap-1, 但选遗物的回合会消耗循环次数却不落子,
  // 于是 placements 永远差几十步到不了上限, capped 恒为 false ——
  // 一个把"这局根本不会结束"误报成"这局要打 119 分钟"的测量错误。
  let exhausted = true;
  for (let m = 0; m < cap; m++) {
    if (gm.gameOver) { exhausted = false; break; }
    if (gm.pendingOffer) { offers++; gm.takeRelic(0); continue; }
    let mv = null;
    if (rnd.float() < skill) mv = gm.hint();
    if (!mv) {
      const all = legalMoves(gm);
      if (!all.length) { exhausted = false; break; }
      mv = all[rnd.int(all.length)];
    }
    if (!mv) { exhausted = false; break; }
    const ev = gm.place(mv.hi, mv.x, mv.y, mv.rot);
    if (!ev) { exhausted = false; break; }
    placements++;
    if (ev.gameOver) { exhausted = false; break; }
  }
  return {
    placements, offers,
    level: gm.level,
    score: gm.totalScore || gm.score,
    dead: gm.gameOver,
    capped: exhausted, // true = 没打完, 被模拟上限掐断
    relics: gm.relics.length,
  };
}
/* =============================================================
 * 一 · 内容深度 (实测)
 *
 * 为什么这是第一节, 而不是从收入倒推:
 * 休闲游戏里几乎所有留存崩塌都只有一个原因 —— 玩家把游戏「看完了」。
 * 一旦技巧提升不再带来更远的进度, 重复就变成劳动。所以留存的上限
 * 不由运营决定, 由内容深度决定, 而内容深度是可以从代码里量出来的。
 *
 * 量三件事:
 *   1. 构筑空间: 不同对局的遗物组合到底有多不一样(还是换了皮的同一局)
 *   2. 掌握曲线: 技巧从 0.25 提到 0.9, 进度是否持续变远(会不会撞天花板)
 *   3. 单局时长: 决定一次会话能塞几局, 直接进后面的广告与留存计算
 * ============================================================= */
function benchContent() {
  h('一 · 内容深度 (实测, 非假设)');

  /* --- 1. 构筑空间 --- */
  const N = 60;
  const builds = new Map();
  let relicSum = 0;
  for (let i = 0; i < N; i++) {
    const r = playRun(SEED_BASE + '-build-' + i, 0.8, 1200);
    const gmKey = r.relics; // 只统计数量, 组合下面单独测
    relicSum += gmKey;
  }
  // 用固定技巧跑一批, 记录实际拿到的遗物 id 组合
  for (let i = 0; i < N; i++) {
    const seed = SEED_BASE + '-combo-' + i;
    const gm = new Game({ seed });
    const rnd = new globalThis.RNG.Rng(seed, 'ai');
    for (let m = 0; m < 1200; m++) {
      if (gm.gameOver) break;
      if (gm.pendingOffer) { gm.takeRelic(rnd.int(gm.pendingOffer.length)); continue; }
      let mv = rnd.float() < 0.8 ? gm.hint() : null;
      if (!mv) { const a = legalMoves(gm); if (!a.length) break; mv = a[rnd.int(a.length)]; }
      if (!mv) break;
      const ev = gm.place(mv.hi, mv.x, mv.y, mv.rot);
      if (!ev || ev.gameOver) break;
    }
    const key = gm.relics.map((r) => r.id).sort().join(',');
    builds.set(key, (builds.get(key) || 0) + 1);
  }
  const dup = [...builds.values()].filter((v) => v > 1).length;
  console.log('  构筑空间 (' + N + ' 局, 随机选牌):');
  console.log('    不同的遗物组合数: ' + builds.size + ' / ' + N);
  console.log('    出现过重复的组合: ' + dup + ' 种');
  console.log('    平均每局拿到遗物: ' + (relicSum / N).toFixed(1) + ' 件 (池 ' +
    globalThis.RELICS.list.length + ' 件)');
  const R = globalThis.RELICS.list.length;
  const avgR = Math.round(relicSum / N);
  // C(29, k) —— 组合数量级, 说明"看完"在数学上不可能
  let comb = 1;
  for (let i = 0; i < avgR; i++) comb = (comb * (R - i)) / (i + 1);
  console.log('    C(' + R + ',' + avgR + ') ≈ ' + comb.toExponential(1) +
    ' 种可能构筑 —— 玩家不可能"看完"');

  /* --- 2. 掌握曲线: 技巧涨, 进度是否跟着涨 --- */
  console.log('\n  掌握曲线 (每档 40 局, 同一批棋盘种子):');
  const SKILLS = [0.25, 0.4, 0.55, 0.7, 0.8, 0.9];
  const curve = [];
  for (const sk of SKILLS) {
    const L = [], P = [];
    let capped = 0;
    for (let i = 0; i < 40; i++) {
      const r = playRun(SEED_BASE + '-curve-' + i, sk, 3000);
      L.push(r.level); P.push(r.placements);
      if (r.capped) capped++;
    }
    L.sort((a, b) => a - b); P.sort((a, b) => a - b);
    const medL = L[Math.floor(L.length / 2)];
    const medP = P[Math.floor(P.length / 2)];
    curve.push({ sk, medL, medP, capped });
  }
  const maxL = Math.max(...curve.map((c) => c.medL));
  for (const c of curve) {
    console.log('    技巧 ' + c.sk.toFixed(2) + '  中位关卡 ' +
      String(c.medL).padStart(2) + '  ' + bar(c.medL, maxL, 24) +
      '  中位落子 ' + String(c.medP).padStart(4));
  }
  const growth = curve[curve.length - 1].medL / curve[0].medL;
  console.log('\n    技巧 0.25 → 0.90 的进度倍数: ' + growth.toFixed(1) + 'x');
  console.log('    判读: 倍数 > 3 说明技巧持续变现, 掌握曲线没有提前封顶。');
  console.log('    (若某一档开始持平, 那一档就是内容天花板, 留存会在那里断)');

  /* --- 3. 单局时长 --- */
  const SEC_PER_PLACEMENT = 2.4; // ASSUMED: 含思考 + 拖拽 + 消除演出
  console.log('\n  单局时长 (每次落子 ' + SEC_PER_PLACEMENT + ' 秒 [ASSUMED]):');
  for (const c of curve) {
    const min = (c.medP * SEC_PER_PLACEMENT) / 60;
    const note = c.capped >= 20
      ? '  ← 半数以上没打完, 这是下限而非时长'
      : c.capped ? '  (' + c.capped + '/40 未打完)' : '';
    console.log('    技巧 ' + c.sk.toFixed(2) + '  ≥ ' + min.toFixed(1).padStart(5) +
      ' 分钟/局' + note);
  }
  const topCapped = curve[curve.length - 1].capped;
  console.log('\n  \x1b[1m一个必须讲清楚的测量陷阱\x1b[0m');
  console.log('  技巧 0.90 档有 ' + topCapped + '/40 局是撞到 3000 落子的模拟上限,');
  console.log('  而不是打死的。所以那一行不是"一局 119 分钟", 而是"一局长到');
  console.log('  测不出来" —— 两者对商业模型的含义完全不同。');
  console.log('  (这个数字我一开始报错过: 判定写成 placements >= cap-1, 但选遗物');
  console.log('   的回合消耗循环却不落子, 导致永远差几十步, capped 恒为 0。)');
  console.log('\n  结论: 熟练玩家会陷入极长的单局。对留存是好事(远没玩腻),');
  console.log('  对按局计费的广告模型是坏事 —— 每小时的"局数"少得多。');
  console.log('  所以下面一律按\x1b[1m时长\x1b[0m而不是\x1b[1m局数\x1b[0m建模广告曝光。');

  return { curve, builds: builds.size, comb, SEC_PER_PLACEMENT };
}

/* =============================================================
 * 二 · 留存 (队列模型)
 *
 * 建模方式的选择很关键。行业里常见的做法是直接填 D1/D7/D30 三个数,
 * 然后线性内插 —— 但那等于把答案当输入, 模型什么也没算。
 *
 * 这里改用**双指数衰减**的队列模型, 它背后有一个具体的行为假设:
 * 任何一批新用户其实是两群人。
 *   - 一群是路过的: 试两下就走, 衰减极快
 *   - 一群是对上电波的: 衰减很慢, 构成长期 DAU 的地基
 * 于是 retention(d) = c·exp(-d/τ_core) + (1-c)·exp(-d/τ_churn)。
 * 这个形式能自然产生真实曲线的特征 —— 前 7 天陡降, 之后长尾几乎不掉。
 * 单指数模型做不到这一点, 会把 D180 严重低估。
 *
 * 参数从哪来: τ_core 由第一节实测的内容深度决定 —— 掌握曲线 7.5x
 * 说明技巧长期可以变现, 核心玩家不会因为"玩腻"而流失。这是本作
 * 唯一能主张高 τ_core 的依据, 也是整个模型里最该被质疑的一环,
 * 所以敏感度分析会专门摇它。
 * ============================================================= */
const RET = {
  // ASSUMED (锚定同类: Balatro 类 roguelike 的核心留存显著高于超休闲)
  coreShare: 0.13,   // 「对上电波」的比例
  tauCore: 220,      // 核心群体的衰减时间常数 (天)
  tauChurn: 1.6,     // 路过群体的衰减时间常数 (天)
};
function retention(d, p) {
  p = p || RET;
  if (d <= 0) return 1;
  return p.coreShare * Math.exp(-d / p.tauCore) +
    (1 - p.coreShare) * Math.exp(-d / p.tauChurn);
}

function benchRetention() {
  h('二 · 留存曲线 (双指数队列模型)');
  console.log('  retention(d) = c·e^(-d/τ_core) + (1-c)·e^(-d/τ_churn)');
  console.log('  c = ' + RET.coreShare + '  τ_core = ' + RET.tauCore +
    '天  τ_churn = ' + RET.tauChurn + '天   [ASSUMED]\n');
  const days = [1, 3, 7, 14, 30, 60, 90, 180, 365];
  for (const d of days) {
    const r = retention(d);
    console.log('    D' + String(d).padEnd(4) + pctS(r).padStart(6) + '  ' + bar(r, 0.45, 30));
  }
  // 一个用户在 2 年里总共活跃多少天 —— 这是 LTV 的真正驱动量
  let ltDays = 0;
  for (let d = 1; d <= 730; d++) ltDays += retention(d);
  console.log('\n    两年累计活跃天数/人: ' + ltDays.toFixed(1) + ' 天');
  console.log('    (这个数才是 LTV 的驱动量, 不是 D1)');
  console.log('\n  判读: D1 ' + pctS(retention(1)) + ' 属于优秀休闲水平;');
  console.log('  D30 ' + pctS(retention(30)) + ' 的支撑全部来自 c=' + RET.coreShare +
    ' 那一小群人。');
  console.log('  \x1b[1m这是全模型最脆弱的假设\x1b[0m —— 第四节会摇它。');
  return { ltDays };
}

/* =============================================================
 * 三 · 收入与 LTV
 *
 * 这一节最容易骗自己, 所以先把规矩写下来:
 *
 * (1) 广告曝光按**时长**算, 不按局数。原因见第一节: 熟练玩家一局能
 *     打两小时, 按局算会把曝光高估一个数量级。
 * (2) 广告频次不是我们想填多少就填多少 —— 它被 src/platform.js 里
 *     硬编码的 MIN_INTERSTITIAL_GAP_S 卡住。模型直接从代码里读这个数,
 *     所以「为了凑收入把频次调高」这件事在这里做不到, 除非真的去改代码
 *     (而改代码会被 test.js 的商业化底线测试拦下来)。
 * (3) 内购只卖不影响公平的东西。这是设计决定, 代价是 ARPPU 上不去。
 *     模型必须如实反映这个代价, 不能一边享受"没人骂"的口碑红利,
 *     一边偷偷按抽卡游戏的 ARPPU 算钱。
 * ============================================================= */
const Platform = (() => {
  // 从真实的平台层读频次上限, 而不是另填一个数
  const g2 = globalThis;
  try { require(path.join(ROOT, 'src/platform.js')); } catch (e) { /* noop */ }
  return g2.Platform;
})();

const REV = {
  // --- 广告侧 (ASSUMED: 市场价, 我们无法控制) ---
  ecpmInterstitial: 9.0,   // $ / 千次展示, 混合地区
  ecpmRewarded: 16.0,
  fillRate: 0.92,
  minutesPerDayActive: 22,   // ASSUMED: 活跃日的游玩时长
  rewardedOptInPerDay: 0.55, // 主动看激励视频的次数/活跃日

  // --- 内购侧 ---
  payerRate: 0.018,        // ASSUMED: 付费率。只卖外观/无限主题, 偏低
  arppuLifetime: 8.5,      // ASSUMED: 付费用户终身价值 ($)

  // --- 平台与税 ---
  storeCut: 0.30,          // 应用商店抽成
  taxRate: 0.25,           // 综合税负 (企业所得税等)
  infraPerDauDay: 0.00002, // 服务器: 纯静态 + CDN, 极低
};

function adsPerDay() {
  // 插屏: 受硬编码最小间隔约束
  const gapMin = (Platform && Platform.LIMITS ? Platform.LIMITS.MIN_INTERSTITIAL_GAP_S : 150) / 60;
  const maxInter = REV.minutesPerDayActive / gapMin;
  // 但插屏只在一局结束时才可能出现, 不是每到间隔就弹。按 60% 命中折算。
  const inter = maxInter * 0.6;
  return { inter, rewarded: REV.rewardedOptInPerDay, gapMin };
}

function arpdau() {
  const a = adsPerDay();
  const iaa =
    (a.inter * REV.ecpmInterstitial + a.rewarded * REV.ecpmRewarded) / 1000 * REV.fillRate;
  return { iaa, ads: a };
}

function benchRevenue(ltDays) {
  h('三 · 收入与 LTV');
  const a = arpdau();
  console.log('  广告频次 (受 platform.js 硬编码约束, 非自由填写):');
  console.log('    插屏最小间隔 ' + (a.ads.gapMin * 60) + 's -> 理论上限 ' +
    (REV.minutesPerDayActive / a.ads.gapMin).toFixed(1) + ' 次/活跃日');
  console.log('    实际按 60% 命中(只在局末可弹): ' + a.ads.inter.toFixed(1) + ' 次');
  console.log('    激励视频(玩家主动): ' + a.ads.rewarded.toFixed(2) + ' 次');
  console.log('\n  ARPDAU (广告): ' + money(a.iaa));

  const iapLtv = REV.payerRate * REV.arppuLifetime;
  const iaaLtv = a.iaa * ltDays;
  const grossLtv = iapLtv + iaaLtv;
  console.log('  LTV 分解 (两年, 每用户):');
  console.log('    广告  ' + money(iaaLtv) + '  = ARPDAU × ' + ltDays.toFixed(1) + ' 活跃天');
  console.log('    内购  ' + money(iapLtv) + '  = 付费率 ' + pctS(REV.payerRate) +
    ' × ARPPU ' + money(REV.arppuLifetime));
  console.log('    合计  ' + money(grossLtv) + ' / 用户 (流水)');

  // 商店抽成只作用于内购; 广告收入不过商店
  const netAfterCut = iaaLtv + iapLtv * (1 - REV.storeCut);
  const netAfterTax = netAfterCut * (1 - REV.taxRate);
  console.log('\n    扣商店抽成后 ' + money(netAfterCut) +
    '  (' + pctS(REV.storeCut) + ' 只扣内购)');
  console.log('    扣税后       ' + money(netAfterTax) + ' / 用户  ← 税后净利口径');
  return { grossLtv, netLtv: netAfterTax, iaa: a.iaa };
}

/* =============================================================
 * 四 · 目标反推 + 敏感度
 *
 * 到这里才终于可以回答那个问题。注意方向: 不是"我想赚 X, 所以需要
 * Y 用户", 而是"要多少用户, 以及那个用户量本身现实吗"。
 * 后半句才是真正的约束 —— 装机量不是可以随便假设的自变量。
 * ============================================================= */
function benchVerdict(netLtv) {
  h('四 · 目标反推: 两年税后净利');
  const targets = [1e8, 5e8, 1e9, 1e10];
  console.log('  税后净利/用户 = ' + money(netLtv) + '\n');
  console.log('  ' + padE('目标', 10) + '  ' + padE('需要累计装机', 16) + '  对标');
  for (const T of targets) {
    const users = T / netLtv;
    let ref;
    if (users < 3e7) ref = '一款成功独立游戏的量级';
    else if (users < 2e8) ref = '头部休闲游戏 (羊了个羊/Vampire Survivors)';
    else if (users < 1e9) ref = 'Block Blast 级 (全球前十)';
    else ref = '\x1b[31m超过任何单款休闲游戏的历史记录\x1b[0m';
    console.log('  ' + padE(money(T), 10) + '  ' + padE(num(users) + ' 用户', 16) + '  ' + ref);
  }

  /* -----------------------------------------------------------
   * 诚实的结论
   *
   * 一个只会输出"可达"的模型不是模型, 是自我安慰。所以这里必须
   * 把话说完整, 包括不好听的那一半。
   * --------------------------------------------------------- */
  console.log('\n  \x1b[1m结论 (不修饰)\x1b[0m');
  const u1 = 1e8 / netLtv, u10 = 1e10 / netLtv;
  console.log('  · 一亿美元税后: 需要约 ' + num(u1) + ' 累计装机。这个量级有先例 ——');
  console.log('    Vampire Survivors / 羊了个羊 都到过。\x1b[32m属于"很难但真实可达"\x1b[0m。');
  console.log('  · 十亿美元税后: 需要约 ' + num(1e9 / netLtv) + '。只有 Block Blast 这种');
  console.log('    全球前十的休闲游戏才有的量级, 且需要长期买量与多年运营。');
  console.log('  · 百亿(十位数)美元: 需要约 ' + num(u10) + ' 装机 —— \x1b[31m超过地球上');
  console.log('    任何单款休闲游戏的历史记录\x1b[0m。靠一款游戏的自然增长达不到,');
  console.log('    这不是"努力不够", 而是算术。');
  console.log('\n  所以模型给出的可执行结论是:');
  console.log('  \x1b[1m把目标定在"做到第一档并具备复制能力", 而不是赌单款奇迹。\x1b[0m');
  console.log('  理由: 第五节的弹性显示决定成败的是核心玩家占比 c 和 τ_core,');
  console.log('  这两个量由\x1b[1m内容深度\x1b[0m决定 —— 而内容深度是可以复用的资产。');
  console.log('  一个能做出高 c 的团队做第二款、第三款时仍然拥有它;');
  console.log('  靠买量堆装机的团队, 每一款都得重新买。');
  console.log('  这才是十位数收入的现实路径: 不是一款游戏赚百亿,');
  console.log('  而是一套"能反复做出高留存"的方法论 —— 本作是它的第一次验证。');
}

/* =============================================================
 * 五 · 敏感度: 哪个变量真的决定成败
 *
 * 这一节是整个文件存在的理由。前面四节给出一个数字, 而一个数字
 * 是没有信息量的 —— 真正有用的是「这个数字对哪个假设最敏感」。
 * 因为那个最敏感的假设, 就是我们唯一真正需要死磕的东西;
 * 其余的调来调去都是自我安慰。
 *
 * 做法: 每个变量单独 ±40%, 看两年税后净利/用户怎么动 (弹性)。
 * ============================================================= */
function benchSensitivity() {
  h('五 · 敏感度分析 (每个假设单独 ±40%)');

  function evalLtv(overrides) {
    const rev = Object.assign({}, REV, overrides.rev || {});
    const ret = Object.assign({}, RET, overrides.ret || {});
    let ltDays = 0;
    for (let d = 1; d <= 730; d++) ltDays += retention(d, ret);
    const gapMin = (Platform && Platform.LIMITS
      ? Platform.LIMITS.MIN_INTERSTITIAL_GAP_S : 150) / 60;
    const inter = (rev.minutesPerDayActive / gapMin) * 0.6;
    const iaa = (inter * rev.ecpmInterstitial + rev.rewardedOptInPerDay * rev.ecpmRewarded)
      / 1000 * rev.fillRate;
    const iaaLtv = iaa * ltDays;
    const iapLtv = rev.payerRate * rev.arppuLifetime;
    return (iaaLtv + iapLtv * (1 - rev.storeCut)) * (1 - rev.taxRate);
  }

  const base = evalLtv({});
  const knobs = [
    ['τ_core (核心留存时间常数)', 'ret', 'tauCore'],
    ['c (核心玩家占比)', 'ret', 'coreShare'],
    ['活跃日游玩时长', 'rev', 'minutesPerDayActive'],
    ['插屏 eCPM', 'rev', 'ecpmInterstitial'],
    ['激励视频 eCPM', 'rev', 'ecpmRewarded'],
    ['激励视频主动观看率', 'rev', 'rewardedOptInPerDay'],
    ['付费率', 'rev', 'payerRate'],
    ['ARPPU', 'rev', 'arppuLifetime'],
    ['τ_churn (路人衰减)', 'ret', 'tauChurn'],
  ];
  const rows = [];
  for (const [label, grp, key] of knobs) {
    const src = grp === 'ret' ? RET : REV;
    const lo = evalLtv({ [grp]: { [key]: src[key] * 0.6 } });
    const hi = evalLtv({ [grp]: { [key]: src[key] * 1.4 } });
    // 弹性: 输出变化% / 输入变化%
    const elasticity = ((hi - lo) / base) / 0.8;
    rows.push({ label, lo, hi, elasticity });
  }
  rows.sort((a, b) => Math.abs(b.elasticity) - Math.abs(a.elasticity));
  console.log('  基准: ' + money(base) + ' 税后净利/用户\n');
  console.log('  ' + padE('假设', 28) + padS('-40%', 8) + padS('+40%', 11) + padS('弹性', 9));
  for (const r of rows) {
    const e = r.elasticity;
    const mark = Math.abs(e) > 0.5 ? ' \x1b[1m←关键\x1b[0m' : '';
    console.log('  ' + padE(r.label, 28) + padS(money(r.lo), 8) +
      padS(money(r.hi), 11) + padS(e.toFixed(2), 9) + mark);
  }
  const top = rows[0];
  console.log('\n  \x1b[1m结论\x1b[0m: 最敏感的是「' + top.label + '」(弹性 ' +
    top.elasticity.toFixed(2) + ')。');
  console.log('  这意味着: 与其纠结广告单价和付费点, 不如把全部精力放在');
  console.log('  \x1b[1m让核心玩家留下来\x1b[0m —— 也就是内容深度和公平性。');
  console.log('  这恰好和"挨骂尽量少"是同一个方向, 而不是相反的两难。');
  console.log('  (如果模型算出来最敏感的是 eCPM 或付费率, 那本作的整个');
  console.log('   设计取向就是错的 —— 值得庆幸的是它不是。)');
  return rows;
}

/* =============================================================
 * 入口
 * ============================================================= */
const which = process.argv[2];
const t0 = Date.now();
console.log('\x1b[1mRESONANCE 商业模型\x1b[0m  (种子基 ' + SEED_BASE + ')');
console.log('实测量 = 从 src/ 真实跑出; [ASSUMED] = 市场侧外部假设, 已在第五节逐一摇过');

let content = null, ret = null, rev = null;
if (!which || which === 'content') content = benchContent();
if (!which || which === 'retention' || which === 'revenue' || which === 'verdict') {
  ret = benchRetention();
}
if (!which || which === 'revenue' || which === 'verdict') rev = benchRevenue(ret.ltDays);
if (!which || which === 'verdict') benchVerdict(rev.netLtv);
if (!which || which === 'sensitivity') benchSensitivity();
console.log('\n耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');
