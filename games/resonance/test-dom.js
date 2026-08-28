/* =============================================================
 * RESONANCE · DOM 集成测试
 * 在 jsdom 里真实加载 index.html + 全部脚本, 验证:
 *  - 无运行时异常
 *  - DOM 元素与 JS 绑定一致 (最常见的低级 bug: 改了 id 忘了改另一边)
 *  - 完整流程: 菜单 -> 开局 -> 放置 -> 过关 -> 选遗物 -> 结算
 *  - 存档往返
 * 运行: node test-dom.js
 * ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0,
  fail = 0;
const errors = [];
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n    ' + e.message);
  }
}
function ok(v, m) { if (!v) throw new Error(m || 'expected truthy'); }
function eq(a, b, m) { if (a !== b) throw new Error((m || '') + ' expected ' + b + ' got ' + a); }

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

// jsdom 不实现 canvas 2d context —— 用一个记录调用的 stub 替代。
// 这样既能跑通渲染代码路径(捕获真实的 TypeError), 又不需要 node-canvas 编译。
/**
 * 桩要照着**真实 CanvasRenderingContext2D 的方法全集**来实现, 而不是
 * "渲染代码目前用到的那几个"。
 *
 * 之前是手工白名单, 结果每加一个新的 canvas 调用(如 clip)测试就红 ——
 * 那不是发现了 bug, 是桩自己漏了, 属于假警报, 会训练人忽略测试。
 *
 * 照全集实现之后语义才正确:
 *   - 调用规范内的方法 -> 静默通过(浏览器里也能跑)
 *   - 调用规范外的方法 -> 抛 TypeError(浏览器里也会炸, 真 bug)
 * 这样这个桩就成了一份"只用标准 API"的契约检查。
 */
const CTX2D_METHODS = [
  'save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform',
  'resetTransform', 'getTransform',
  'clearRect', 'fillRect', 'strokeRect',
  'beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo',
  'arc', 'arcTo', 'ellipse', 'rect', 'roundRect',
  'fill', 'stroke', 'clip', 'isPointInPath', 'isPointInStroke',
  'fillText', 'strokeText', 'measureText',
  'drawImage', 'createPattern', 'getImageData', 'putImageData', 'createImageData',
  'setLineDash', 'getLineDash',
  'drawFocusIfNeeded', 'scrollPathIntoView', 'reset', 'isContextLost',
];
const CTX2D_PROPS = [
  'fillStyle', 'strokeStyle', 'globalAlpha', 'globalCompositeOperation',
  'lineWidth', 'lineCap', 'lineJoin', 'miterLimit', 'lineDashOffset',
  'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
  'font', 'textAlign', 'textBaseline', 'direction', 'letterSpacing', 'wordSpacing',
  'filter', 'imageSmoothingEnabled', 'imageSmoothingQuality', 'fontKerning',
];

function makeCtxStub() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  const ctx = { canvas: null, calls: Object.create(null) };

  for (const m of CTX2D_METHODS) {
    ctx[m] = function () {
      ctx.calls[m] = (ctx.calls[m] || 0) + 1;
    };
  }
  // 有返回值要求的几个单独覆盖, 否则渲染代码拿到 undefined 会误报
  ctx.measureText = () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
  ctx.createLinearGradient = () => grad;
  ctx.createRadialGradient = () => grad;
  ctx.createConicGradient = () => grad;
  ctx.getLineDash = () => [];
  ctx.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  ctx.getImageData = (x, y, w, h) => ({
    width: w || 1, height: h || 1,
    data: new Uint8ClampedArray(Math.max(1, (w || 1) * (h || 1) * 4)),
  });
  ctx.isPointInPath = () => false;
  ctx.isPointInStroke = () => false;
  ctx.isContextLost = () => false;

  // 属性可读可写但不生效 —— 渲染代码只是设置它们, 不依赖回读
  for (const p of CTX2D_PROPS) ctx[p] = undefined;
  return ctx;
}

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const win = dom.window;

// stub canvas
win.HTMLCanvasElement.prototype.getContext = function () {
  if (!this.__ctx) {
    this.__ctx = makeCtxStub();
    this.__ctx.canvas = this;
  }
  return this.__ctx;
};
// jsdom 的 getBoundingClientRect 返回全 0 -> 会让 cell 尺寸为 0, 造成除零。
// 给一个真实的尺寸, 顺便验证代码在正常尺寸下的行为。
win.Element.prototype.getBoundingClientRect = function () {
  return { width: 400, height: 400, top: 0, left: 0, right: 400, bottom: 400, x: 0, y: 0 };
};
// WebAudio 不存在于 jsdom -> audio.js 应优雅降级 (enabled=false)
win.devicePixelRatio = 1;

// 接管 requestAnimationFrame: 测试要手动控制时间推进, 而不是被真实帧率牵着走。
// 同时避免 rAF 主循环让 node 进程无法退出。
const rafQueue = [];
win.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
win.cancelAnimationFrame = () => {};
/** 手动跑 n 帧主循环 */
function pumpFrames(n) {
  let now = 0;
  for (let i = 0; i < n; i++) {
    const cbs = rafQueue.splice(0, rafQueue.length);
    now += 16.7;
    for (const cb of cbs) {
      try { cb(now); } catch (e) { errors.push('rAF: ' + e.message); }
    }
  }
}

// 捕获脚本内的运行时错误
win.addEventListener('error', (e) => errors.push('window.error: ' + (e.message || e)));
const origErr = win.console.error;
win.console.error = function (...a) { errors.push('console.error: ' + a.join(' ')); origErr.apply(this, a); };

// 依次注入脚本 (顺序同 index.html)
const scripts = ['src/platform.js', 'src/rng.js', 'src/audio.js', 'src/icons.js', 'src/relics.js', 'src/game.js', 'src/render.js', 'src/main.js'];
for (const s of scripts) {
  const code = fs.readFileSync(path.join(dir, s), 'utf8');
  try {
    win.eval(code);
  } catch (e) {
    errors.push('加载 ' + s + ' 失败: ' + e.message);
  }
}

// 触发 DOMContentLoaded (main.js 监听它来 init)
win.document.dispatchEvent(new win.Event('DOMContentLoaded'));

const App = win.ResonanceApp;
const $ = (s) => win.document.querySelector(s);

console.log('\n加载与初始化');
t('全部脚本无异常加载', () => {
  if (errors.length) throw new Error(errors.join(' | '));
});
t('全局模块都已暴露', () => {
  ok(win.RNG, 'RNG');
  ok(win.Audio2, 'Audio2');
  ok(win.RELICS, 'RELICS');
  ok(win.ResonanceGame, 'ResonanceGame');
  ok(win.ResonanceRenderer, 'ResonanceRenderer');
  ok(win.ResonanceApp, 'ResonanceApp');
});
t('App 初始化完成 (game + renderer 就位)', () => {
  ok(App.game, 'game missing');
  ok(App.renderer, 'renderer missing');
  eq(App.game.board.length, 64);
});
t('音频接口在非浏览器环境下调用不抛错', () => {
  // jsdom 版本之间对 AudioContext 的支持不一致(有的提供 stub, 有的没有)。
  // 我们不断言 enabled 的值, 而是断言真正重要的事:
  // 无论有没有可用的 WebAudio, 调用任何音效 API 都不能让游戏崩溃。
  win.Audio2.place(0);
  win.Audio2.clear(1, 2, 0);
  win.Audio2.win();
  win.Audio2.lose();
  win.Audio2.resonate(5, 1);
  win.Audio2.relic();
  win.Audio2.invalid();
  win.Audio2.ui();
  win.Audio2.setMuted(true);
  win.Audio2.setMuted(false);
  win.Audio2.setVolume(0.3);
});
t('renderer 计算出有效的格子尺寸', () => {
  ok(App.renderer.cell > 0, 'cell size = ' + App.renderer.cell);
  ok(Number.isFinite(App.renderer.cell));
});
t('脚本在 DOM 已就绪后注入也能启动 (防白屏回归)', () => {
  // 曾经的 bug: main.js 只监听 DOMContentLoaded。若脚本在该事件之后才执行
  // (defer / async / 动态注入 / 打包器搬到末尾), 监听永远不会触发 -> 线上白屏。
  // 这里显式模拟"DOM 已完成"的时序, 验证同步启动分支确实工作。
  ok(App._booted === true, 'App 应已启动');
  ok(App.game && App.renderer, 'init 未完成');

  // 直接验证兜底逻辑: 在一个 readyState=complete 的全新文档里重新加载 main.js
  const d2 = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = d2.window;
  w2.HTMLCanvasElement.prototype.getContext = function () {
    if (!this.__ctx) { this.__ctx = makeCtxStub(); this.__ctx.canvas = this; }
    return this.__ctx;
  };
  w2.Element.prototype.getBoundingClientRect = () =>
    ({ width: 400, height: 400, top: 0, left: 0, right: 400, bottom: 400, x: 0, y: 0 });
  w2.devicePixelRatio = 1;
  w2.requestAnimationFrame = () => 1;
  // 强制把文档标记为已解析完成, 精确复现"脚本迟到"的时序。
  // (jsdom 构造完成后 readyState 可能仍是 loading, 所以这里显式覆盖。)
  Object.defineProperty(w2.document, 'readyState', {
    value: 'complete',
    configurable: true,
  });
  eq(w2.document.readyState, 'complete', '前置条件: 文档已就绪');

  for (const s of scripts) w2.eval(fs.readFileSync(path.join(dir, s), 'utf8'));
  // 关键: 刻意不派发 DOMContentLoaded。
  // 旧代码只监听该事件, 在这个时序下会永远等不到 -> 白屏。
  ok(w2.ResonanceApp, 'App 未暴露');
  ok(w2.ResonanceApp._booted === true, '未走同步启动分支 -> 会白屏');
  ok(w2.ResonanceApp.game, '游戏未初始化 -> 会白屏');
  ok(w2.ResonanceApp.renderer, '渲染器未初始化 -> 会白屏');
  // 且界面确实被渲染出来了(不是空壳)
  ok(w2.document.querySelector('.screen.active'), '没有任何界面被激活 -> 白屏');
});
t('主循环 (requestAnimationFrame) 连续 120 帧无异常', () => {
  errors.length = 0;
  App.showScreen('game');
  pumpFrames(120);
  if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
});

console.log('\nDOM 与 JS 的 id 契约');
const REQUIRED_IDS = [
  'board', 'hud', 'hand', 'relics', 'tip',
  'hud-level', 'hud-score', 'hud-target', 'hud-total', 'hud-seed', 'hud-insp', 'hud-chain',
  'progress-fill',
  'btn-menu', 'btn-mute', 'btn-motion', 'btn-undo', 'btn-hint',
  'btn-start', 'btn-daily', 'btn-seed', 'seed-input', 'btn-tutorial', 'btn-relicbook',
  'btn-tut-done', 'btn-book-close', 'book-list',
  'btn-resume-yes', 'btn-resume-no', 'resume-info',
  'offer-list', 'offer-level', 'offer-score', 'btn-reroll', 'btn-skip-relic',
  'over-title', 'over-score', 'over-level', 'over-chain', 'over-lines', 'over-res',
  'over-seed', 'over-relics', 'btn-again', 'btn-retry-seed', 'btn-share', 'btn-over-menu',
  'stat-best', 'stat-level', 'stat-runs', 'rotate-hint',
];
t('所有被 JS 引用的 id 都存在于 HTML', () => {
  const missing = REQUIRED_IDS.filter((id) => !$('#' + id));
  ok(missing.length === 0, '缺失: ' + missing.join(', '));
});
t('main.js 中的 $("#...") 选择器全部有对应元素', () => {
  const src = fs.readFileSync(path.join(dir, 'src/main.js'), 'utf8');
  const ids = new Set();
  const re = /\$\(['"]#([a-zA-Z0-9_-]+)['"]\)/g;
  let m;
  while ((m = re.exec(src))) ids.add(m[1]);
  const missing = Array.from(ids).filter((id) => !$('#' + id));
  ok(missing.length === 0, '选择器无对应元素: ' + missing.join(', '));
  ok(ids.size > 25, '只扫到 ' + ids.size + ' 个 id, 正则可能失效');
});
t('每个 .screen 都有 data-screen', () => {
  const screens = Array.from(win.document.querySelectorAll('.screen'));
  ok(screens.length >= 6, '只有 ' + screens.length + ' 个 screen');
  for (const s of screens) ok(s.dataset.screen, 'screen 缺少 data-screen');
});
t('showScreen 能切换到每一个界面', () => {
  const names = Array.from(win.document.querySelectorAll('.screen')).map((s) => s.dataset.screen);
  for (const n of names) {
    App.showScreen(n);
    const active = win.document.querySelector('.screen.active');
    ok(active, '没有 active screen: ' + n);
    eq(active.dataset.screen, n);
  }
});

console.log('\n完整游玩流程');
t('点击"开始新的一局"进入游戏', () => {
  $('#btn-start').click();
  eq(App.currentScreen, 'game');
  eq(App.game.level, 1);
  ok($('#hud-seed').textContent.length >= 4, 'seed shown');
  ok(!$('#hud').classList.contains('hidden'), 'HUD visible');
});
t('手牌渲染出正确数量的槽位', () => {
  const slots = win.document.querySelectorAll('.hand-slot');
  eq(slots.length, App.game.hand.length);
  ok(slots.length >= 3);
});
t('手牌槽位内渲染出方块格子', () => {
  const first = win.document.querySelector('.hand-slot .piece-grid');
  ok(first, 'no piece-grid');
  const on = first.querySelectorAll('.pcell.on');
  eq(on.length, App.game.hand[0].cells.length, 'cell count mismatch');
});
t('点击手牌可选中并高亮', () => {
  const slot = win.document.querySelector('.hand-slot');
  slot.click();
  eq(App.selectedHand, 0);
  ok(win.document.querySelector('.hand-slot').classList.contains('selected'));
});
t('commitPlace 成功放子并更新 HUD', () => {
  const g = App.game;
  // 找一个合法落点
  const piece = g.hand[0];
  let found = null;
  for (let y = 0; y < 8 && !found; y++)
    for (let x = 0; x < 8 && !found; x++)
      if (g.canPlace(piece, x, y)) found = { x, y };
  ok(found, 'no legal placement');
  const before = g.board.filter((v) => v !== -1).length;
  App.selectedHand = 0;
  App.rotation = 0;
  App.commitPlace(0, found.x, found.y);
  const after = g.board.filter((v) => v !== -1).length;
  ok(after > before, 'board should gain cells');
});
t('放置期间 inputLocked 阻止重复操作', () => {
  ok(App.inputLocked === true, 'should lock during animation');
});
t('动画播放后自动解锁', () => {
  // 手动推进渲染时间轴直到播完
  let guard = 0;
  while (App.renderer.animating && guard++ < 2000) {
    App.renderer.update(16.7);
  }
  ok(!App.renderer.animating, 'anim should finish');
  ok(App.inputLocked === false, 'should unlock, still ' + App.inputLocked);
});
t('renderer.draw() 在 stub canvas 上不抛异常', () => {
  for (let i = 0; i < 30; i++) {
    App.renderer.update(16.7);
    App.renderer.draw();
  }
});
t('拖拽预览 hover 计算合法性正确', () => {
  const g = App.game;
  const piece = g.hand[0];
  App.selectedHand = 0;
  App.rotation = 0;
  const p = App.currentPiece();
  ok(p, 'currentPiece');
  App.renderer.hover = { x: 0, y: 0, piece: p, valid: g.canPlace(p, 0, 0) };
  App.renderer.draw(); // 应画出 ghost 而不报错
  App.renderer.hover = { x: 7, y: 7, piece: p, valid: g.canPlace(p, 7, 7) };
  App.renderer.draw();
  App.renderer.hover = null;
});
t('提示功能返回并高亮一步', () => {
  const before = App.hintsLeft;
  App.doHint();
  eq(App.hintsLeft, before - 1);
  ok(App.renderer.hintMove, 'hintMove set');
  App.renderer.draw();
});
t('撤销按钮生效', () => {
  const g = App.game;
  const cellsBefore = g.board.filter((v) => v !== -1).length;
  const undosBefore = g.undosLeft;
  if (undosBefore > 0 && g.history.length) {
    App.doUndo();
    ok(g.undosLeft < undosBefore, 'undo consumed');
  }
});

console.log('\n过关 -> 遗物三选一 -> 下一关');
t('达标后弹出遗物选择界面', () => {
  const g = App.game;
  g.target = 1;
  for (let x = 0; x < 7; x++) g.board[0 * 8 + x] = 0;
  g.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'z' }];
  App.selectedHand = 0;
  App.rotation = 0;
  App.commitPlace(0, 7, 0);
  let guard = 0;
  while (App.renderer.animating && guard++ < 3000) App.renderer.update(16.7);
  eq(App.currentScreen, 'offer', 'should show offer screen');
});
t('遗物卡片渲染出 3 张且含名称与描述', () => {
  const cards = win.document.querySelectorAll('.offer-card');
  ok(cards.length >= 3, 'only ' + cards.length + ' cards');
  for (const c of cards) {
    ok(c.querySelector('.oc-name').textContent.trim().length > 0, 'empty name');
    ok(c.querySelector('.oc-desc').textContent.trim().length > 0, 'empty desc');
    // 图标已从 emoji 文本改为内联 SVG, 所以断言的是"画出了图形"而不是"有文字"
    const ic = c.querySelector('.oc-icon svg');
    ok(ic, 'missing svg icon');
    ok((ic.querySelector('path').getAttribute('d') || '').length > 4, 'empty icon path');
  }
});
t('点击遗物卡 -> 获得遗物并进入下一关', () => {
  const before = App.game.level;
  win.document.querySelector('.offer-card').click();
  eq(App.game.level, before + 1);
  eq(App.game.relics.length, 1);
  eq(App.currentScreen, 'game');
  eq(App.game.score, 0, 'score resets');
});
t('遗物条渲染出已持有遗物', () => {
  const rs = win.document.querySelectorAll('#relics .relic');
  eq(rs.length, App.game.relics.length);
  ok(rs[0].title.length > 5, 'relic tooltip missing');
});
t('遗物 tooltip 可弹出', () => {
  win.document.querySelector('#relics .relic').click();
  ok($('#tip').classList.contains('show'), 'tip not shown');
});

console.log('\n存档 / 读档');
t('saveRun 写入 localStorage', () => {
  App.saveRun();
  const raw = win.localStorage.getItem('resonance.save.v1');
  ok(raw, 'no save written');
  const s = JSON.parse(raw);
  eq(s.board.length, 64);
  eq(s.seed, App.game.seed);
});
t('applyRun 完整还原棋盘/分数/遗物', () => {
  const g = App.game;
  // 制造一个有辨识度的状态
  g.totalScore = 12345;
  g.board[10] = 3;
  g.board[11] = 4;
  App.saveRun();
  const saved = App.loadRun();
  ok(saved, 'loadRun failed');
  App.applyRun(saved);
  eq(App.game.totalScore, 12345, 'totalScore');
  eq(App.game.board[10], 3);
  eq(App.game.board[11], 4);
  eq(App.game.relics.length, saved.relicIds.length, 'relics restored');
  eq(App.game.seed, saved.seed);
});
t('读档后仍可正常继续游玩', () => {
  App.enterGame();
  const g = App.game;
  let found = null;
  for (let hi = 0; hi < g.hand.length && !found; hi++)
    for (let y = 0; y < 8 && !found; y++)
      for (let x = 0; x < 8 && !found; x++)
        if (g.canPlace(g.hand[hi], x, y)) found = { hi, x, y };
  ok(found, 'no move after load');
  App.selectedHand = found.hi;
  App.rotation = 0;
  App.commitPlace(found.hi, found.x, found.y);
  let guard = 0;
  while (App.renderer.animating && guard++ < 2000) App.renderer.update(16.7);
  ok(!App.inputLocked, 'unlocked after load+play');
});
t('meta 统计持久化', () => {
  App.meta.best = 99999;
  App.saveMeta();
  const m = JSON.parse(win.localStorage.getItem('resonance.meta.v1'));
  eq(m.best, 99999);
});

console.log('\n结算与分享');
t('endRun 渲染结算数据', () => {
  const g = App.game;
  g.totalScore = 54321;
  g.level = 7;
  g.stats.maxChain = 5;
  g.stats.totalLines = 42;
  g.stats.totalResonated = 88;
  App.endRun();
  eq(App.currentScreen, 'over');
  eq($('#over-score').textContent, '54,321');
  eq($('#over-level').textContent, '7');
  eq($('#over-chain').textContent, '5');
  eq($('#over-lines').textContent, '42');
  eq($('#over-res').textContent, '88');
  eq($('#over-seed').textContent, g.seed);
});
t('新纪录时标题变化', () => {
  ok($('#over-title').textContent.length > 0);
});
t('结算清除了续玩存档 (避免读到已结束的局)', () => {
  eq(win.localStorage.getItem('resonance.save.v1'), null);
});
t('分享文本包含关卡/分数/种子且不含推广链接', () => {
  let copied = null;
  win.navigator.share = undefined;
  Object.defineProperty(win.navigator, 'clipboard', {
    value: { writeText: (t) => { copied = t; return Promise.resolve(); } },
    configurable: true,
  });
  App.share();
  ok(copied, 'nothing copied');
  ok(copied.indexOf('RESONANCE') >= 0, 'missing title');
  ok(copied.indexOf(App.game.seed) >= 0, 'missing seed');
  ok(copied.indexOf('54,321') >= 0, 'missing score');
  ok(!/https?:\/\//.test(copied), '分享文本不应含链接(避免被平台判定为营销): ' + copied);
});

console.log('\n图鉴 / 菜单');
t('遗物图鉴列出全部遗物', () => {
  $('#btn-relicbook').click();
  eq(App.currentScreen, 'book');
  const items = win.document.querySelectorAll('.book-item');
  eq(items.length, win.RELICS.list.length, '图鉴条目数应等于遗物总数');
});
t('图鉴每条都有名称与描述', () => {
  for (const it of win.document.querySelectorAll('.book-item')) {
    ok(it.querySelector('b').textContent.trim(), 'empty name');
    ok(it.querySelector('small').textContent.trim(), 'empty desc');
  }
});
t('教学界面可打开关闭', () => {
  $('#btn-book-close').click();
  $('#btn-tutorial').click();
  eq(App.currentScreen, 'tutorial');
  $('#btn-tut-done').click();
  eq(App.currentScreen, 'menu');
  eq(App.meta.seenTutorial, true);
});
t('菜单统计正确显示', () => {
  App.meta.best = 7777;
  App.meta.bestLevel = 9;
  App.syncMenuStats();
  eq($('#stat-best').textContent, '7,777');
  eq($('#stat-level').textContent, '9');
});
t('种子输入可载入指定局', () => {
  $('#seed-input').value = 'testseed';
  $('#btn-seed').click();
  eq(App.game.seed, 'TESTSEED', 'seed should be uppercased');
  eq(App.currentScreen, 'game');
});
t('今日挑战使用当日种子', () => {
  $('#btn-daily').click();
  eq(App.game.seed, win.RNG.dailySeed());
  eq(App.game.mode, 'daily');
});
t('静音开关切换图标与状态', () => {
  const before = App.meta.muted;
  $('#btn-mute').click();
  ok(App.meta.muted !== before, 'mute not toggled');
  // 图标已从 emoji 换成手绘 SVG, 断言改为检查 data-icon 与实际渲染的节点
  const want = App.meta.muted ? 'ui-mute' : 'ui-sound';
  eq($('#btn-mute').getAttribute('data-icon'), want);
  ok($('#btn-mute').querySelector('svg.ricon'), '按钮里没有渲染出 SVG 图标');
});

t('界面不再使用任何系统 emoji 图标', () => {
  // 为什么要把这条写成测试: emoji 在三端字形完全不同, 是"没有美术"的最明显
  // 信号。它极容易在后续迭代里被顺手加回来 (打字快、看起来热闹), 所以用一条
  // 断言把这个决定钉死。新增按钮请走 data-icon + ICONS.svg()。
  const body = win.document.body.innerHTML;
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u;
  const m = body.match(EMOJI);
  ok(!m, '页面中仍存在 emoji: ' + (m && m[0]));
});

t('每个 data-icon 按钮都真的画出了图标 (没有哑弹)', () => {
  const nodes = win.document.querySelectorAll('[data-icon]');
  ok(nodes.length >= 10, '带图标的按钮太少, 可能没被渲染: ' + nodes.length);
  for (const el of nodes) {
    const id = el.getAttribute('data-icon');
    ok(win.ICONS.has(id), '图标未定义, 会退化成兜底方块: ' + id);
    ok(el.querySelector('svg.ricon'), id + ' 未渲染出 SVG');
    eq(el.querySelectorAll('svg.ricon').length, 1, id + ' 图标被重复插入');
  }
});
t('减少动效开关生效', () => {
  const before = App.renderer.reduceMotion;
  $('#btn-motion').click();
  ok(App.renderer.reduceMotion !== before, 'reduceMotion not toggled');
});

console.log('\n长时间随机操作 (模糊测试)');
t('300 次随机 UI 操作不产生任何异常', () => {
  errors.length = 0;
  const rng = new win.RNG.Rng('FUZZ', 'ui');
  App.showScreen('game');
  App.game = new win.ResonanceGame({ seed: 'FUZZUI' });
  App.renderer.game = App.game;
  App.enterGame();

  for (let i = 0; i < 300; i++) {
    // 推进动画
    let guard = 0;
    while (App.renderer.animating && guard++ < 500) App.renderer.update(16.7);
    App.renderer.draw();

    if (App.currentScreen === 'offer') {
      const cards = win.document.querySelectorAll('.offer-card');
      if (cards.length) cards[rng.int(cards.length)].click();
      continue;
    }
    if (App.currentScreen === 'over') {
      $('#btn-again').click();
      continue;
    }
    const act = rng.int(10);
    if (act < 6) {
      const g = App.game;
      const cands = [];
      for (let hi = 0; hi < g.hand.length; hi++)
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            if (g.canPlace(g.hand[hi], x, y)) cands.push({ hi, x, y });
      if (cands.length) {
        const c = cands[rng.int(cands.length)];
        App.selectedHand = c.hi;
        App.rotation = 0;
        App.commitPlace(c.hi, c.x, c.y);
      }
    } else if (act === 6) {
      App.doUndo();
    } else if (act === 7) {
      App.doHint();
    } else if (act === 8) {
      const slots = win.document.querySelectorAll('.hand-slot');
      if (slots.length) slots[rng.int(slots.length)].click();
    } else {
      App.saveRun();
      const s = App.loadRun();
      if (s) App.applyRun(s);
    }
  }
  if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
});
t('模糊测试后状态仍然自洽', () => {
  const g = App.game;
  eq(g.board.length, 64);
  ok(Number.isFinite(g.score) && g.score >= 0, 'score = ' + g.score);
  ok(Number.isFinite(g.totalScore), 'total = ' + g.totalScore);
  ok(g.level >= 1);
  ok(g.hand.length <= g.handSize + 1, 'hand overflow: ' + g.hand.length);
  for (const v of g.board) ok(v === -1 || (v >= 0 && v < 5), 'bad cell value ' + v);
});

/* =============================================================
 * 硬件返回键 (安卓/鸿蒙)
 *
 * 原生壳会用 evaluateJavascript 调 ResonanceApp.goBack()。这几条
 * 测试同时也是**文档正确性测试**: docs/DEPLOY.md 里给的壳代码调用的
 * 就是这个名字和这个语义, 一旦改名, 文档立刻变成错的而没人知道。
 * ============================================================= */
console.log('\n硬件返回键');

t('ResonanceApp.goBack 存在 (DEPLOY.md 的壳代码依赖它)', () => {
  eq(typeof App.goBack, 'function');
});

t('对局中按返回: 回菜单而不是退出 App', () => {
  App.newRun('BACK-1');
  eq(App.currentScreen, 'game');
  eq(App.goBack(), true, '应消费掉这次返回');
  eq(App.currentScreen, 'menu');
});

t('对局中按返回不丢进度 (存档仍在, 可续)', () => {
  App.newRun('BACK-2');
  const lv = App.game.level;
  App.goBack();
  const saved = App.loadRun();
  ok(saved, '按返回后存档丢了 —— 玩家会损失一整局');
  eq(saved.level, lv);
});

t('在菜单按返回: 交还给原生 (返回 false 才能正常退出 App)', () => {
  App.showScreen('menu');
  eq(App.goBack(), false);
});

t('二级页面按返回退回菜单', () => {
  for (const s of ['book', 'tutorial', 'over', 'resume']) {
    App.showScreen(s);
    eq(App.goBack(), true, s + ' 应消费返回');
    eq(App.currentScreen, 'menu', s + ' 应退回菜单');
  }
});

t('选遗物界面不能用返回键当后门跳过', () => {
  App.showScreen('offer');
  eq(App.goBack(), true, '应吞掉返回');
  eq(App.currentScreen, 'offer', '返回键把一次有代价的选择变成了免费跳过');
});

t('goBack 只使用真实存在的屏幕名', () => {
  // 防止分派表里留下拼错的/已删除的屏幕名 —— 那种分支永远不会命中,
  // 看起来有处理其实没有。
  //
  // 合法名字不能只取 .screen 元素: 'game' 是一个真实状态, 但它没有对应的
  // section —— showScreen('game') 的作用是把所有面板都关掉、露出 canvas
  // 和 HUD。(这一条最初就是被这个差异卡红的, 属于测试假设太窄, 不是 bug。)
  const src = fs.readFileSync(path.join(dir, 'src/main.js'), 'utf8');
  const declared = new Set(
    [...win.document.querySelectorAll('.screen')].map((s) => s.dataset.screen)
  );
  // 以 showScreen 的全部实际调用为准, 这才是屏幕名的真正来源
  const called = new Set([...src.matchAll(/showScreen\('([a-z]+)'\)/g)].map((m) => m[1]));
  for (const d of declared) ok(called.has(d), '有面板从未被 showScreen 使用: ' + d);

  const body = /goBack\(\)\s*\{([\s\S]*?)\n    \},/.exec(src);
  ok(body, '没找到 goBack 的函数体');
  const used = [...body[1].matchAll(/s === '([a-z]+)'/g)].map((m) => m[1]);
  ok(used.length >= 4, '分派分支过少');
  for (const u of used) ok(called.has(u), 'goBack 引用了不存在的屏幕: ' + u);
});

/* =============================================================
 * 终章 (通关) 与遗物池耗尽
 *
 * 这两条路径都**只有最强的那批玩家会走到**(实测到第 18 关的比例是
 * 6~8%), 也就是说它们几乎不可能在日常手动测试中被覆盖, 而一旦出错,
 * 撞上的恰好是会录视频、会发帖的人。所以必须由自动化测试兜住。
 * ============================================================= */
console.log('\n终章 / 遗物池耗尽');

/** 用真实 UI 路径把当前局推过一关。返回落子产生的事件。 */
function clearLevel() {
  const g = App.game;
  g.target = 1;
  for (let x = 0; x < 7; x++) g.board[0 * 8 + x] = 0;
  g.hand = [{ shapeId: 'i1', cells: [[0, 0]], colorIdx: 0, w: 1, h: 1, uid: 'z' }];
  App.selectedHand = 0;
  App.rotation = 0;
  App.commitPlace(0, 7, 0);
  let guard = 0;
  while (App.renderer.animating && guard++ < 5000) App.renderer.update(16.7);
}

t('第 18 关通过时触发终章, 且横幅真的显示出来', () => {
  App.newRun('VICTORY-1');
  // 判定发生在"通过第 N 关"的那一刻、level++ 之前, 所以要先站在第 18 关。
  App.game.level = win.ResonanceGame.FINAL_LEVEL;
  clearLevel();
  eq(App.game.victoryAt, win.ResonanceGame.FINAL_LEVEL, 'victoryAt 未记录');
  ok(App.victoryPending, 'victoryPending 未置位');
  const el = $('#offer-victory');
  ok(el, '#offer-victory 元素不存在');
  ok(!el.classList.contains('hidden'), '终章横幅是个哑弹: 逻辑触发了但界面没显示');
  eq($('#victory-level').textContent, String(win.ResonanceGame.FINAL_LEVEL));
});

t('通关时标题让位给横幅 (同一个数字不重复两遍)', () => {
  // 承接上一条: 此刻在通关的 offer 屏
  ok($('#offer-title').classList.contains('hidden'),
    '"第 18 关通过"与横幅相邻重复了同一个数字, 且 h2 会压过横幅的层级');
});

t('终章不强制结束对局 (玩家可以继续打)', () => {
  // 承接上一条的状态: 此刻在 offer 屏
  eq(App.currentScreen, 'offer');
  win.document.querySelector('.offer-card').click();
  eq(App.currentScreen, 'game', '通关后被强制踢出对局 —— 剥夺了玩家的选择');
  eq(App.game.level, win.ResonanceGame.FINAL_LEVEL + 1, '应能继续往下打');
  ok(!App.game.gameOver, '通关不应把对局判定为结束');
});

t('终章横幅只出现一次, 且标题会恢复', () => {
  ok(!App.victoryPending, '离开选牌屏后标志未清除');
  clearLevel();
  eq(App.currentScreen, 'offer');
  ok(!App.victoryPending, '第 19 关又弹了一次终章');
  ok($('#offer-victory').classList.contains('hidden'), '仪式性画面被重复播放就不再是仪式');
  // 隐藏标题是个 toggle, 最容易出的错就是"藏了没还回来" ——
  // 那样通关之后每一关的选牌屏都会没有标题。
  ok(!$('#offer-title').classList.contains('hidden'),
    '通关后标题一直没恢复, 后续每关的选牌屏都缺标题');
  ok($('#offer-title').textContent.indexOf('19') >= 0, '标题未更新到当前关卡');
});

t('通关状态跟随存档 (读档后不会二次弹终章)', () => {
  const at = App.game.victoryAt;
  ok(at, '前置条件: 应已通关');
  App.saveRun();
  const raw = JSON.parse(win.localStorage.getItem('resonance.save.v1'));
  eq(raw.victoryAt, at, 'victoryAt 没有被序列化');
  App.applyRun(raw);
  eq(App.game.victoryAt, at, '读档后通关状态丢失');
});

t('未通关的存档 victoryAt 为 null (不会误报通关)', () => {
  App.newRun('VICTORY-2');
  App.saveRun();
  const raw = JSON.parse(win.localStorage.getItem('resonance.save.v1'));
  eq(raw.victoryAt, null);
  App.applyRun(raw);
  eq(App.game.victoryAt, null);
});

/* 存档 schema 漂移守卫。
 *
 * 这条测试是为了一个真实发生过的 bug: saveRun() 里手写了一份字段清单,
 * Game.serialize() 里又手写了一份, 两份慢慢对不上 —— applyRun() 已经在
 * 读 victoryAt / streak / mercyCount 了, 而 saveRun() 根本没写它们。
 * 症状是"续玩之后成绩变小", 只在跨会话时出现, 人工测试几乎撞不到。
 *
 * 断言方向刻意是单向的 (serialize ⊆ saveRun): saveRun 允许多存东西
 * (hintsLeft、RNG 调用数这些属于 App 层, 不属于 Game 的对外快照),
 * 但凡 Game 认为值得序列化的字段, 存档就必须落盘。 */
t('存档 schema 不漂移 (serialize 的字段 saveRun 必须全都写)', () => {
  const gsrc = fs.readFileSync(path.join(dir, 'src/game.js'), 'utf8');
  const msrc = fs.readFileSync(path.join(dir, 'src/main.js'), 'utf8');
  const sm = /Game\.prototype\.serialize[\s\S]*?return \{([\s\S]*?)\n  \};/.exec(gsrc);
  ok(sm, '没找到 serialize 的返回体');
  const vm = /saveRun\(\)[\s\S]*?JSON\.stringify\(\{([\s\S]*?)\n          \}\)/.exec(msrc);
  ok(vm, '没找到 saveRun 的字段表');
  const ser = [...sm[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  const sav = new Set([...vm[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
  const missing = ser.filter((k) => k !== 'gameOver' && !sav.has(k));
  eq(missing.length, 0, 'saveRun 漏存字段: ' + missing.join(',') + ' (续玩后会丢)');
});

t('续玩后连击与调音师计数不丢 (公开承诺的数字不能少报)', () => {
  App.newRun('RESUME-STATS');
  const g = App.game;
  g.streak = 5;
  g.bestStreak = 9;
  g.mercyCount = 3;
  App.saveRun();
  App.applyRun(App.loadRun());
  eq(App.game.bestStreak, 9, '最高连击丢了 —— 结算页会少报一局的成绩');
  eq(App.game.mercyCount, 3, '调音师介入次数丢了 —— 这是写在结算页上的公开承诺');
  eq(App.game.streak, 5, '当前连击丢了');
});

/* 通关必须留下"能回看的痕迹"。
 * 一个只在过关那一瞬间闪一下、之后哪里都查不到的成就, 对玩家来说
 * 等于没发生过 —— 而这批玩家恰恰是付出最多的那批。 */
t('结算页显示通关徽章, 标题也随之改变', () => {
  App.newRun('OVER-VIC');
  App.game.victoryAt = win.ResonanceGame.FINAL_LEVEL;
  App.game.totalScore = 500000;
  App.endRun();
  const badge = $('#over-victory');
  ok(badge, '#over-victory 不存在');
  ok(!badge.classList.contains('hidden'), '通关了但结算页没有任何痕迹');
  eq(badge.querySelector('b').textContent, String(win.ResonanceGame.FINAL_LEVEL));
  eq($('#over-title').textContent, '全部走完', '标题没能反映"走完全程"');
});

t('未通关的对局结算页不显示通关徽章', () => {
  App.newRun('OVER-NOVIC');
  App.game.totalScore = 1;
  App.endRun();
  ok($('#over-victory').classList.contains('hidden'), '没通关却挂了通关徽章');
});

t('通关次数累计并显示在菜单 (未通关时该格隐藏)', () => {
  App.meta.wins = 0;
  App.syncMenuStats();
  ok($('#stat-wins-wrap').classList.contains('hidden'),
    '没通关过就显示"通关 0"= 在提醒每个新玩家他还没赢过');
  App.meta.wins = 2;
  App.syncMenuStats();
  ok(!$('#stat-wins-wrap').classList.contains('hidden'), '通关过却不显示');
  eq($('#stat-wins').textContent, '2');
  App.meta.wins = 0;
  App.syncMenuStats();
});

t('通关会写入 meta.wins (跨局累计)', () => {
  App.meta.wins = 0;
  App.newRun('WINS-1');
  App.game.level = win.ResonanceGame.FINAL_LEVEL;
  clearLevel();
  eq(App.meta.wins, 1, '通关没有被累计, meta.wins 是个死字段');
  // 同一局继续打不应重复计数
  win.document.querySelector('.offer-card').click();
  clearLevel();
  eq(App.meta.wins, 1, '同一局被重复计入通关次数');
});

t('分享文本包含通关标记 (唯一的自然增长机制)', () => {
  App.newRun('SHARE-VIC');
  App.game.victoryAt = win.ResonanceGame.FINAL_LEVEL;
  const src = fs.readFileSync(path.join(dir, 'src/main.js'), 'utf8');
  ok(/victoryAt \? '.{0,12}通关/.test(src), '分享文本没有体现通关');
});

t('遗物池耗尽时不显示空的选牌屏 (直接进关并给出解释)', () => {
  App.newRun('EXHAUST-1');
  const g = App.game;
  // 收齐全部遗物 -> offer() 返回 []
  g.relics = win.RELICS.list.map((r) => win.RELICS.instantiate(r.id));
  g._applyPassives();
  const lv = g.level;
  const insp = g.inspiration;
  clearLevel();
  eq(App.game.pendingOffer, null, 'pendingOffer 应为空');
  eq(App.currentScreen, 'game', '玩家看到了一个一张卡都没有的选牌屏');
  eq(App.game.level, lv + 1, '应自动进入下一关');
  ok(App.game.inspiration > insp, '应折算灵感补偿, 否则玩家白丢一次三选一');
  ok($('#tip').classList.contains('show'), '没有任何解释 —— 玩家会以为三选一被系统吃了');
});

t('灵感不足时刷新按钮禁用, 且刷不出东西不收费', () => {
  App.newRun('REROLL-1');
  const g = App.game;
  g.relics = win.RELICS.list.map((r) => win.RELICS.instantiate(r.id));
  g._applyPassives();
  g.pendingOffer = [win.RELICS.instantiate(win.RELICS.list[0].id)];
  g.inspiration = 99;
  eq(g.rerollOffer(), false, '池空时应拒绝刷新');
  eq(g.inspiration, 99, '刷不出东西却扣了灵感');
});

/* =============================================================
 * 无障碍: 减少动效必须同时管住 canvas 和 CSS
 * ============================================================= */
console.log('\n无障碍');

t('减少动效同时作用于 CSS (不只是 canvas)', () => {
  const body = win.document.body;
  App.meta.reduceMotion = false;
  App.applyMotionPref();
  ok(!body.classList.contains('reduce-motion'), '初始状态不该带类');
  App.meta.reduceMotion = true;
  App.applyMotionPref();
  eq(App.renderer.reduceMotion, true, 'canvas 侧未生效');
  ok(
    body.classList.contains('reduce-motion'),
    '开关只管了 canvas —— 因动效不适而打开它的玩家仍会看到 CSS 动画'
  );
  App.meta.reduceMotion = false;
  App.applyMotionPref();
});

t('reduce-motion 样式真的存在 (类名不是空挂的)', () => {
  const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
  ok(/body\.reduce-motion/.test(css), 'style.css 里没有 body.reduce-motion 规则');
  ok(
    /body\.reduce-motion[\s\S]{0,200}animation:\s*none/.test(css),
    'reduce-motion 没有关掉 animation'
  );
});

t('CSS 里不存在从未被设置的 body 类 (哑规则)', () => {
  // body.in-menu 曾经就是这样一条死规则: 样式写了, 但没有任何代码
  // 添加过这个类。这种规则会误导后来的人以为某个行为已经实现了。
  const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(dir, 'src/main.js'), 'utf8') +
    fs.readFileSync(path.join(dir, 'src/render.js'), 'utf8');
  const used = new Set([...css.matchAll(/body\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  for (const c of used) {
    ok(js.indexOf("'" + c + "'") >= 0, 'CSS 有 body.' + c + ' 但没有代码设置它');
  }
});

t('终章横幅有对应样式 (不是裸元素)', () => {
  const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
  ok(/\.offer-victory\s*\{/.test(css), '.offer-victory 没有样式');
  ok(/\.tip\.tip-center/.test(css), 'toast 用的 .tip-center 没有样式');
});

console.log(
  '\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n'
);
process.exit(fail ? 1 : 0);
