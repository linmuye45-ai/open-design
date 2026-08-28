/* 视觉验证: 用真实 Chromium 截取各界面, 并捕获控制台错误 */
'use strict';
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const outDir = path.join(__dirname, 'shots');
  require('fs').mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const errs = [];

  async function shot(name, viewport, fn) {
    const ctx = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      hasTouch: viewport.width < 500,
      isMobile: viewport.width < 500,
    });
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(name + ' :: ' + m.text());
    });
    page.on('pageerror', (e) => errs.push(name + ' :: PAGEERROR ' + e.message));
    await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(700);
    if (fn) await fn(page);
    await page.screenshot({ path: path.join(outDir, name + '.png') });
    await ctx.close();
    console.log('  shot: ' + name);
  }

  const MOBILE = { width: 390, height: 844 };
  const DESKTOP = { width: 1280, height: 900 };

  // 1. 教学页(首次进入)
  await shot('01-tutorial-mobile', MOBILE);

  // 2. 主菜单
  await shot('02-menu-mobile', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.waitForTimeout(400);
  });

  // 3. 游戏中(手机) — 放几个方块制造画面
  await shot('03-game-mobile', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      // 铺一些方块让棋盘不空
      const colors = [0,1,2,3,4,0,1,2];
      for (let i = 0; i < 26; i++) {
        const x = i % 8, y = 4 + Math.floor(i / 8);
        if (y < 8) g.board[y*8+x] = colors[(x+y) % 5];
      }
      g.score = Math.floor(g.target * 0.62);
      g.totalScore = 4820;
      g.stats.maxChain = 4;
      g.relics = ['tuning_fork','sustain_pedal','harmonic_series','golden_ratio']
        .map(id => window.RELICS.instantiate(id));
      g._applyPassives();
      A.renderAll();
    });
    await p.waitForTimeout(400);
  });

  // 4. 游戏中 + 拖拽预览(显示落点与预测消除行)
  await shot('04-drag-preview', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      for (let x = 0; x < 7; x++) g.board[7*8+x] = 2;
      for (let x = 0; x < 5; x++) g.board[6*8+x] = 2;
      g.board[5*8+1] = 2; g.board[5*8+2] = 2;
      g.hand[0] = {shapeId:'i1',cells:[[0,0]],colorIdx:2,w:1,h:1,uid:'demo'};
      A.selectedHand = 0; A.rotation = 0;
      A.renderAll();
      const piece = A.currentPiece();
      A.renderer.hover = { x: 7, y: 7, piece, valid: g.canPlace(piece, 7, 7) };
      A.renderer.draw();
    });
    await p.waitForTimeout(300);
  });

  // 5. 连锁爆炸瞬间(粒子)
  await shot('05-chain-burst', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      for (let x = 0; x < 7; x++) g.board[7*8+x] = 2;
      for (let x = 0; x < 6; x++) g.board[6*8+x] = 2;
      g.board[5*8+2] = 2; g.board[5*8+3] = 2; g.board[5*8+4] = 2;
      g.hand[0] = {shapeId:'i1',cells:[[0,0]],colorIdx:2,w:1,h:1,uid:'d'};
      A.selectedHand = 0; A.rotation = 0;
      A.commitPlace(0, 7, 7);
    });
    // 推进到粒子最盛的时刻
    await p.waitForTimeout(360);
  });

  // 6. 遗物三选一
  await shot('06-offer', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      g.level = 4; g.totalScore = 9640;
      g.pendingOffer = ['harmonic_series','golden_ratio','sustain_pedal']
        .map(id => window.RELICS.instantiate(id));
      g.inspiration = 6;
      A.renderOffer();
      A.showScreen('offer');
    });
    await p.waitForTimeout(400);
  });

  // 6b. 终章 (通关) —— 一局最多出现一次的画面, 必须有视觉回归覆盖,
  //     否则它出错时唯一的发现者是打到第 18 关的玩家。
  await shot('06b-victory', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      g.level = window.ResonanceGame.FINAL_LEVEL;
      g.totalScore = 486120;
      g.victoryAt = g.level;
      A.victoryPending = true;
      g.pendingOffer = ['the_maestro', 'grand_piano', 'sympathetic']
        .map((id) => window.RELICS.instantiate(id));
      g.inspiration = 11;
      A.renderOffer();
      A.showScreen('offer');
    });
    // 等高光扫过动画走完 (1.15s + 0.12s 延迟), 截到静止后的最终形态
    await p.waitForTimeout(1500);
  });

  // 7. 结算
  await shot('07-gameover', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      g.totalScore = 128450; g.level = 12;
      g.stats.maxChain = 7; g.stats.totalLines = 96; g.stats.totalResonated = 214;
      g.relics = ['tuning_fork','sustain_pedal','harmonic_series','golden_ratio',
                  'grand_piano','sympathetic','the_maestro']
        .map(id => window.RELICS.instantiate(id));
      A.endRun();
    });
    await p.waitForTimeout(400);
  });

  // 7b. 通关过的结算页 (徽章 + "全部走完" 标题)。与 07 分开截, 因为
  //     "通关"和"没通关"是结算页的两种不同形态, 都需要视觉回归。
  await shot('07b-gameover-victory', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      g.totalScore = 512830; g.level = 19;
      g.stats.maxChain = 9; g.stats.totalLines = 168; g.stats.totalResonated = 502;
      g.bestStreak = 14; g.mercyCount = 2;
      g.victoryAt = window.ResonanceGame.FINAL_LEVEL;
      g.relics = ['tuning_fork','sustain_pedal','harmonic_series','golden_ratio',
                  'grand_piano','sympathetic','the_maestro']
        .map(id => window.RELICS.instantiate(id));
      A.endRun();
    });
    await p.waitForTimeout(400);
  });

  // 7c. 通关过之后的主菜单 (通关次数格出现)
  await shot('07c-menu-victory', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.waitForTimeout(200);
    await p.evaluate(() => {
      const A = window.ResonanceApp;
      A.meta.best = 512830; A.meta.bestLevel = 19; A.meta.runs = 137;
      A.meta.wins = 2;
      A.syncMenuStats();
    });
    await p.waitForTimeout(300);
  });

  // 8. 遗物图鉴
  await shot('08-relicbook', MOBILE, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-relicbook');
    await p.waitForTimeout(400);
  });

  // 9. 桌面端
  await shot('09-game-desktop', DESKTOP, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      for (let i = 0; i < 22; i++) {
        const x = i % 8, y = 5 + Math.floor(i / 8);
        if (y < 8) g.board[y*8+x] = (x*3+y) % 5;
      }
      g.score = Math.floor(g.target*0.45);
      g.relics = ['metronome','echo_chamber','crescendo'].map(id=>window.RELICS.instantiate(id));
      g._applyPassives(); A.renderAll();
    });
    await p.waitForTimeout(400);
  });

  // 10. 小屏极限 (iPhone SE)
  await shot('10-small-320', { width: 320, height: 568 }, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      for (let i = 0; i < 18; i++) { const x=i%8,y=6+Math.floor(i/8); if(y<8) g.board[y*8+x]=(x+y)%5; }
      g.relics = ['tuning_fork','wide_bow'].map(id=>window.RELICS.instantiate(id));
      g._applyPassives(); A.renderAll();
    });
    await p.waitForTimeout(300);
  });

  // 11. 极限矮屏 (横屏 / 老设备)
  await shot('11-short-660x480', { width: 660, height: 480 }, async (p) => {
    await p.click('#btn-tut-done');
    await p.click('#btn-start');
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      const A = window.ResonanceApp, g = A.game;
      for (let i = 0; i < 14; i++) { const x=i%8,y=7-Math.floor(i/8); if(y>=0) g.board[y*8+x]=(x+y)%5; }
      A.renderAll();
    });
    await p.waitForTimeout(300);
  });

  /* ---------- 布局断言: 用真实几何验证不重叠、不出屏 ---------- */
  console.log('\n布局校验:');
  const layoutIssues = [];
  const SIZES = [
    { name: '320x568 (iPhone SE1)', w: 320, h: 568 },
    { name: '360x640 (Android 主流)', w: 360, h: 640 },
    { name: '390x844 (iPhone 14)', w: 390, h: 844 },
    { name: '430x932 (iPhone Pro Max)', w: 430, h: 932 },
    { name: '768x1024 (iPad)', w: 768, h: 1024 },
    { name: '1280x900 (桌面)', w: 1280, h: 900 },
    { name: '660x480 (横屏矮屏)', w: 660, h: 480 },
  ];
  for (const s of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => layoutIssues.push(s.name + ' PAGEERROR ' + e.message));
    await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(500);
    await page.click('#btn-tut-done');
    await page.click('#btn-start');
    await page.waitForTimeout(600);

    const m = await page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
      };
      return {
        vh: window.innerHeight, vw: window.innerWidth,
        board: r('#board'), hand: r('#hand'),
        tools: r('.hand-tools'), hud: r('#hud'),
        seed: r('.seed-line'),
        docScrollH: document.documentElement.scrollHeight,
      };
    });

    const tol = 1.5;
    if (!m.board || m.board.h < 40) layoutIssues.push(s.name + ': 棋盘尺寸异常 ' + JSON.stringify(m.board));
    // 棋盘必须是正方形
    if (m.board && Math.abs(m.board.w - m.board.h) > 2)
      layoutIssues.push(s.name + ': 棋盘非正方形 ' + m.board.w.toFixed(1) + 'x' + m.board.h.toFixed(1));
    // 棋盘与手牌不得重叠
    if (m.board && m.hand && m.board.bottom > m.hand.top + tol)
      layoutIssues.push(s.name + ': 棋盘与手牌重叠 ' + m.board.bottom.toFixed(1) + ' > ' + m.hand.top.toFixed(1));
    // HUD 与棋盘不得重叠
    if (m.hud && m.board && m.hud.bottom > m.board.top + tol)
      layoutIssues.push(s.name + ': HUD 与棋盘重叠');
    // 所有内容必须在视口内
    const last = m.seed && m.seed.h > 0 ? m.seed : m.tools;
    if (last && last.bottom > m.vh + tol)
      layoutIssues.push(s.name + ': 底部内容溢出屏幕 ' + last.bottom.toFixed(1) + ' > ' + m.vh);
    if (m.board && m.board.top < -tol) layoutIssues.push(s.name + ': 棋盘顶部被裁切');
    // 不应出现页面级滚动
    if (m.docScrollH > m.vh + 4)
      layoutIssues.push(s.name + ': 出现页面滚动 ' + m.docScrollH + ' > ' + m.vh);

    console.log('  ' + (layoutIssues.some(i => i.startsWith(s.name)) ? '✗' : '✓') +
      ' ' + s.name + '  棋盘 ' + (m.board ? m.board.w.toFixed(0) + 'px' : 'n/a'));
    await ctx.close();
  }

  await browser.close();

  if (layoutIssues.length) {
    console.log('\n\x1b[31m布局问题:\x1b[0m\n  ' + layoutIssues.join('\n  '));
  } else {
    console.log('\n\x1b[32m所有尺寸布局正确 ✓\x1b[0m');
  }
  console.log('控制台错误: ' + (errs.length ? '\n  ' + errs.join('\n  ') : '无 ✓'));
  process.exit(errs.length || layoutIssues.length ? 1 : 0);
})();
