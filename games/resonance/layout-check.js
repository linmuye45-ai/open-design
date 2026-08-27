/* 布局校验: 用真实几何数据验证各尺寸下不重叠、不溢出、不滚动。
   资源友好: 只开一个浏览器 + 一个页面, 逐次改 viewport。 */
'use strict';
const { chromium } = require('playwright');

const SIZES = [
  { name: '320x568 iPhoneSE1', w: 320, h: 568 },
  { name: '360x640 Android  ', w: 360, h: 640 },
  { name: '390x844 iPhone14 ', w: 390, h: 844 },
  { name: '430x932 ProMax   ', w: 430, h: 932 },
  { name: '768x1024 iPad    ', w: 768, h: 1024 },
  { name: '1280x900 Desktop ', w: 1280, h: 900 },
  { name: '660x480 Landscape', w: 660, h: 480 },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const issues = [];
  page.on('pageerror', (e) => issues.push('PAGEERROR ' + e.message));

  for (const s of SIZES) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.goto('http://localhost:8080/index.html', { waitUntil: 'load' });
    await page.waitForTimeout(350);
    // 跳过教学 -> 开局
    await page.evaluate(() => {
      localStorage.clear();
      const A = window.ResonanceApp;
      A.meta.seenTutorial = true;
      A.newRun('LAYOUT', 'endless');
      // 铺一些方块 + 遗物, 逼近真实最拥挤状态
      const g = A.game;
      for (let i = 0; i < 20; i++) { const x = i % 8, y = 7 - Math.floor(i / 8); if (y >= 0) g.board[y * 8 + x] = (x + y) % 5; }
      g.relics = ['tuning_fork','sustain_pedal','harmonic_series','golden_ratio','grand_piano','wide_bow']
        .map((id) => window.RELICS.instantiate(id));
      g._applyPassives();
      A.renderAll();
    });
    await page.waitForTimeout(350);

    const m = await page.evaluate(() => {
      const r = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
      };
      return {
        vh: window.innerHeight, vw: window.innerWidth,
        board: r('#board'), hand: r('#hand'), hud: r('#hud'),
        tools: r('.hand-tools'), seed: r('.seed-line'),
        docScrollH: document.documentElement.scrollHeight,
        handSlots: document.querySelectorAll('.hand-slot').length,
      };
    });

    const tol = 1.5;
    const bad = [];
    if (!m.board || m.board.h < 40) bad.push('棋盘尺寸异常');
    if (m.board && Math.abs(m.board.w - m.board.h) > 2)
      bad.push('棋盘非正方形 ' + m.board.w.toFixed(0) + 'x' + m.board.h.toFixed(0));
    if (m.board && m.hand && m.board.bottom > m.hand.top + tol)
      bad.push('棋盘压住手牌(' + (m.board.bottom - m.hand.top).toFixed(1) + 'px)');
    if (m.hud && m.board && m.hud.bottom > m.board.top + tol) bad.push('HUD压住棋盘');
    const last = m.seed && m.seed.h > 0 ? m.seed : m.tools;
    if (last && last.bottom > m.vh + tol)
      bad.push('底部溢出(' + (last.bottom - m.vh).toFixed(1) + 'px)');
    if (m.board && m.board.top < -tol) bad.push('棋盘顶部被裁');
    if (m.docScrollH > m.vh + 4) bad.push('页面可滚动 ' + m.docScrollH + '>' + m.vh);
    if (m.handSlots < 3) bad.push('手牌槽位只有 ' + m.handSlots);

    if (bad.length) issues.push(s.name + ': ' + bad.join(', '));
    console.log('  ' + (bad.length ? '\x1b[31m✗\x1b[0m' : '\x1b[32m✓\x1b[0m') + ' ' + s.name +
      '  棋盘 ' + (m.board ? m.board.w.toFixed(0) + 'px' : 'n/a') +
      '  手牌槽 ' + m.handSlots);
  }

  await browser.close();
  if (issues.length) {
    console.log('\n\x1b[31m布局问题:\x1b[0m\n  ' + issues.join('\n  '));
    process.exit(1);
  }
  console.log('\n\x1b[32m全部尺寸布局正确 ✓\x1b[0m');
  process.exit(0);
})();
