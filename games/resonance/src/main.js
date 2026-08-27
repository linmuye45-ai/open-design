/* =============================================================
 * RESONANCE · main.js
 * 应用层: 输入(鼠标/触摸/键盘) + UI 状态机 + 存档 + 分享。
 * ============================================================= */
(function (global) {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
  const LS_KEY = 'resonance.save.v1';
  const LS_META = 'resonance.meta.v1';

  const App = {
    game: null,
    renderer: null,
    inputLocked: false,
    selectedHand: -1,
    rotation: 0,
    hintsLeft: 3,
    meta: { best: 0, bestLevel: 0, runs: 0, dailyDone: {}, dailyBest: {}, muted: false, reduceMotion: false, seenTutorial: false },

    init() {
      this.loadMeta();
      this.canvas = $('#board');
      this.game = new global.ResonanceGame({ seed: global.RNG.randomSeed() });
      this.renderer = new global.ResonanceRenderer(this.canvas, this.game);
      this.applyMotionPref();
      global.Audio2.setMuted(this.meta.muted);

      this.bindUI();
      this.bindBoardInput();
      this.bindKeys();

      global.addEventListener('resize', () => {
        this.renderer.resize();
        this.fitDensity();
        this.renderHand();
      });

      // 恢复存档
      const saved = this.loadRun();
      if (saved) this.showResume(saved);
      else if (!this.meta.seenTutorial) this.showScreen('tutorial');
      else this.showScreen('menu');

      this.syncMenuStats();
      this.loop();
    },

    /* ---------- 存档 ---------- */
    loadMeta() {
      try {
        const m = JSON.parse(global.Platform.getItem(LS_META) || '{}');
        Object.assign(this.meta, m);
      } catch (e) {}
    },
    saveMeta() {
      try {
        global.Platform.setItem(LS_META, JSON.stringify(this.meta));
      } catch (e) {}
    },
    saveRun() {
      if (!this.game || this.game.gameOver) {
        global.Platform.removeItem(LS_KEY);
        return;
      }
      try {
        global.Platform.setItem(
          LS_KEY,
          JSON.stringify({
            seed: this.game.seed,
            mode: this.game.mode,
            level: this.game.level,
            score: this.game.score,
            totalScore: this.game.totalScore,
            target: this.game.target,
            board: this.game.board,
            hand: this.game.hand,
            relicIds: this.game.relics.map((r) => r.id),
            relicStates: this.game.relics.map((r) => r.state || null),
            inspiration: this.game.inspiration,
            undosLeft: this.game.undosLeft,
            discardsLeft: this.game.discardsLeft,
            rescueLeft: this.game.rescueLeft,
            stats: this.game.stats,
            hintsLeft: this.hintsLeft,
            pieceCalls: this.game.rngPieces.calls,
            relicCalls: this.game.rngRelics.calls,
            /* 下面这四个字段以前是漏的 —— 而 applyRun() 早就在读 victoryAt 了,
             * 也就是说存档写入方和读取方各写了一遍 schema, 然后对不上。
             * 后果都是"续玩之后数字变小":
             *   streak/bestStreak -> 结算页的"最高连击"会被砍掉, 而连击是
             *     本作教玩家理解构筑质量的主要反馈, 砍掉它等于抹掉一局的成绩;
             *   mercyCount        -> 调音师介入次数是写在结算页上的**公开承诺**,
             *     少报比不报更糟: 玩家一旦对不上账, 丢掉的是整个信任;
             *   victoryAt         -> 已通关的玩家读档后会被二次弹终章。
             * 三者都只在"存过档再回来"时出现, 所以人工测试极难撞到。
             * 下方 t('存档 schema ...') 那条测试就是为了防止再次漏字段。 */
            streak: this.game.streak,
            bestStreak: this.game.bestStreak,
            mercyCount: this.game.mercyCount,
            victoryAt: this.game.victoryAt,
          })
        );
      } catch (e) {}
    },
    loadRun() {
      try {
        const s = JSON.parse(global.Platform.getItem(LS_KEY) || 'null');
        if (s && s.board && s.board.length === 64) return s;
      } catch (e) {}
      return null;
    },
    applyRun(s) {
      const g = new global.ResonanceGame({ seed: s.seed, mode: s.mode });
      // 重放 RNG 调用次数, 保证后续序列与存档前一致
      for (let i = 0; i < (s.pieceCalls || 0); i++) g.rngPieces.float();
      for (let i = 0; i < (s.relicCalls || 0); i++) g.rngRelics.float();
      g.relics = (s.relicIds || []).map((id, i) => {
        const r = global.RELICS.instantiate(id);
        if (r && s.relicStates && s.relicStates[i]) r.state = s.relicStates[i];
        return r;
      }).filter(Boolean);
      g._applyPassives();
      g.board = s.board.slice();
      g.hand = s.hand || [];
      g.level = s.level;
      g.score = s.score;
      g.totalScore = s.totalScore;
      g.target = s.target;
      g.inspiration = s.inspiration || 0;
      g.undosLeft = s.undosLeft || 0;
      g.discardsLeft = s.discardsLeft || 0;
      g.rescueLeft = s.rescueLeft || 0;
      g.stats = s.stats || g.stats;
      g.streak = s.streak || 0;
      g.bestStreak = s.bestStreak || 0;
      // 调音师介入次数是公开写在结算页上的数字。读档时不还原就等于少报,
      // 而"可自己查证"正是本作唯一的护城河 —— 少报一次就全毁了。
      g.mercyCount = s.mercyCount || 0;
      // 通关状态必须跟着存档走: 少了这一行, 已通关的玩家读档后再过一关
      // 会被第二次弹终章 —— 一个只有最强玩家才会遇到的尴尬。
      g.victoryAt = s.victoryAt == null ? null : s.victoryAt;
      g.history = [];
      g.pendingOffer = null;
      this.game = g;
      this.renderer.game = g;
      this.hintsLeft = s.hintsLeft == null ? 3 : s.hintsLeft;
    },

    /**
     * 把"减少动效"这个设置真正落到两处渲染管线上。
     *
     * 在加这个函数之前, 这个开关只写进了 renderer.reduceMotion —— 也就是
     * 只管住了 canvas 里的粒子和抖动。而 CSS 侧的过渡与关键帧动画
     * (面板入场、遗物弹跳、终章横幅的高光扫过) 完全不受影响。
     * 对于因为动效会晕眩/不适而打开这个开关的玩家来说, 一个"关了却还在动"
     * 的无障碍选项比没有这个选项更糟: 他会以为是自己没找对地方。
     *
     * 系统级的 prefers-reduced-motion 媒体查询已经在 style.css 里处理了,
     * 但它管不到"系统没开、玩家在游戏内单独关掉"这种情况 —— 这恰恰是
     * 大多数人的实际用法, 所以必须有这条应用内通路。
     */
    applyMotionPref() {
      const on = !!this.meta.reduceMotion;
      if (this.renderer) this.renderer.reduceMotion = on;
      const b = document.body;
      if (b) b.classList.toggle('reduce-motion', on);
    },

    /* ---------- 屏幕切换 ---------- */
    showScreen(name) {
      $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
      $('#hud').classList.toggle('hidden', name !== 'game');
      this.currentScreen = name;
    },

    /**
     * 安卓/鸿蒙的硬件返回键入口 (原生壳通过 evaluateJavascript 调用)。
     *
     * 语义: 返回 true = 游戏消费掉了这次返回; false = 由原生决定 (通常退出 App)。
     * 这个分派必须放在 UI 层而不是 platform.js —— platform.js 管的是宿主能力
     * (存储/分享/广告), 界面栈是业务概念, 混进去会让适配层依赖具体屏幕名。
     *
     * 对局中不直接退出: 玩家按错一下就丢掉一局是最容易招骂的设计之一。
     * 这里退回菜单, 而对局本身已经存档, 回来还能续。
     */
    goBack() {
      const s = this.currentScreen;
      if (s === 'game') {
        this.saveRun();
        this.showScreen('menu');
        this.syncMenuStats();
        return true;
      }
      // 二级页面统一退回菜单
      if (s === 'book' || s === 'tutorial' || s === 'over' || s === 'resume') {
        this.showScreen('menu');
        this.syncMenuStats();
        return true;
      }
      // 选遗物界面不允许用返回键跳过 —— 那是一次有代价的选择, 不该有后门
      if (s === 'offer') return true;
      return false; // 已在菜单: 交还给原生
    },

    showResume(saved) {
      this.pendingResume = saved;
      $('#resume-info').textContent =
        '第 ' + saved.level + ' 关 · 累计 ' + saved.totalScore.toLocaleString() + ' 分 · ' +
        (saved.relicIds || []).length + ' 件遗物';
      this.showScreen('resume');
    },

    /* ---------- UI 绑定 ---------- */
    bindUI() {
      const on = (sel, ev, fn) => {
        const el = $(sel);
        if (el) el.addEventListener(ev, fn);
      };

      on('#btn-start', 'click', () => this.newRun(global.RNG.randomSeed(), 'endless'));
      on('#btn-daily', 'click', () => this.startDaily());
      on('#btn-seed', 'click', () => {
        const s = ($('#seed-input').value || '').trim().toUpperCase();
        if (!s) return;
        this.newRun(s, 'endless');
      });
      on('#btn-tutorial', 'click', () => this.showScreen('tutorial'));
      on('#btn-relicbook', 'click', () => this.showRelicBook());
      on('#btn-tut-done', 'click', () => {
        this.meta.seenTutorial = true;
        this.saveMeta();
        this.showScreen('menu');
      });
      on('#btn-book-close', 'click', () => this.showScreen('menu'));
      on('#btn-resume-yes', 'click', () => {
        global.Audio2.unlock();
        this.applyRun(this.pendingResume);
        this.pendingResume = null;
        this.enterGame();
      });
      on('#btn-resume-no', 'click', () => {
        global.Platform.removeItem(LS_KEY);
        this.pendingResume = null;
        this.showScreen('menu');
      });

      on('#btn-undo', 'click', () => this.doUndo());
      on('#btn-hint', 'click', () => this.doHint());
      on('#btn-menu', 'click', () => {
        this.saveRun();
        this.showScreen('menu');
        this.syncMenuStats();
      });
      on('#btn-mute', 'click', () => {
        this.meta.muted = !this.meta.muted;
        global.Audio2.setMuted(this.meta.muted);
        this.syncToggleIcons();
        this.saveMeta();
      });
      on('#btn-motion', 'click', () => {
        this.meta.reduceMotion = !this.meta.reduceMotion;
        this.applyMotionPref();
        this.syncToggleIcons();
        this.saveMeta();
      });

      on('#btn-skip-relic', 'click', () => {
        global.Audio2.ui();
        this.game.skipRelic();
        this.afterLevelChange();
      });
      on('#btn-reroll', 'click', () => {
        if (this.game.rerollOffer()) {
          global.Audio2.ui();
          this.renderOffer();
        }
      });

      on('#btn-again', 'click', () => this.newRun(global.RNG.randomSeed(), 'endless'));
      on('#btn-retry-seed', 'click', () => this.newRun(this.game.seed, this.game.mode));
      on('#btn-share', 'click', () => this.share());
      on('#btn-over-menu', 'click', () => {
        this.showScreen('menu');
        this.syncMenuStats();
      });

      this.paintIcons();
      this.syncToggleIcons();
    },

    /**
     * 把所有带 data-icon 的按钮填上手绘 SVG。
     *
     * 为什么走 data-icon 而不是把 <svg> 直接写进 index.html:
     * mute / motion 两个开关的图标要随状态切换, 写死在 HTML 里就变成
     * 两处 SVG 字符串各自维护。统一走 ICONS.svg() 之后, 改图标只需动
     * icons.js 一个地方, index.html 也保持可读。
     */
    paintIcons() {
      const nodes = document.querySelectorAll('[data-icon]');
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i];
        if (el.querySelector('.ricon')) continue; // 已画过, 不重复插
        el.insertAdjacentHTML('afterbegin', global.ICONS.svg(el.getAttribute('data-icon'), 18));
      }
    },

    /** 重画两个随状态变化的开关图标 */
    syncToggleIcons() {
      const setIcon = (sel, iconId, off) => {
        const el = $(sel);
        if (!el) return;
        el.setAttribute('data-icon', iconId);
        const old = el.querySelector('.ricon');
        if (old) old.remove();
        el.insertAdjacentHTML('afterbegin', global.ICONS.svg(iconId, 18));
        el.classList.toggle('off', !!off);
      };
      setIcon('#btn-mute', this.meta.muted ? 'ui-mute' : 'ui-sound', this.meta.muted);
      setIcon(
        '#btn-motion',
        this.meta.reduceMotion ? 'ui-motion-off' : 'ui-motion',
        this.meta.reduceMotion
      );
    },

    syncMenuStats() {
      $('#stat-best').textContent = (this.meta.best || 0).toLocaleString();
      $('#stat-level').textContent = this.meta.bestLevel || 0;
      $('#stat-runs').textContent = this.meta.runs || 0;

      /* 通关次数。刻意做成"只有通关过才出现"的第 4 格, 而不是常驻显示
       * 一个 0 —— 常驻的 0 是在提醒每个新玩家"你还没赢过", 而这一格的
       * 意义恰恰相反: 它是给已经赢过的人的一块铭牌。
       * (同理没有做成"0/1"式的进度条: 那会把一个荣誉变成一项待办。) */
      const winEl = $('#stat-wins-wrap');
      if (winEl) {
        const w = this.meta.wins || 0;
        winEl.classList.toggle('hidden', w <= 0);
        if (w > 0) $('#stat-wins').textContent = w;
      }
      const ds = global.RNG.dailySeed();
      const done = this.meta.dailyDone && this.meta.dailyDone[ds];
      const btn = $('#btn-daily');
      if (done) {
        btn.innerHTML = '<span>今日挑战</span><small>已完成 · ' +
          (this.meta.dailyBest[ds] || 0).toLocaleString() + ' 分 (可重玩)</small>';
      } else {
        btn.innerHTML = '<span>今日挑战</span><small>全球同一种子 · 比拼真实技术</small>';
      }
      // innerHTML 重写抹掉了图标, 补回来
      this.paintIcons();
    },

    startDaily() {
      this.newRun(global.RNG.dailySeed(), 'daily');
    },

    newRun(seed, mode) {
      global.Audio2.unlock();
      this.game = new global.ResonanceGame({ seed, mode });
      this.renderer.game = this.game;
      this.renderer.particles = [];
      this.renderer.floaters = [];
      this.renderer.cellFx = {};
      this.hintsLeft = 3;
      this.meta.runs = (this.meta.runs || 0) + 1;
      this.saveMeta();
      this.enterGame();
    },

    enterGame() {
      this.selectedHand = -1;
      this.rotation = 0;
      this.inputLocked = false;
      this.renderer.hintMove = null;
      this.renderer.resize();
      this.showScreen('game');
      this.renderAll();
      // showScreen 之后棋盘的可用区才是最终值, 再校准一次密度
      this.renderer.resize();
      this.fitDensity();
    },

    /* ---------- HUD ---------- */
    renderAll() {
      // 顺序有意义: HUD/手牌/遗物先落位, 它们决定了留给棋盘的剩余高度,
      // 之后再量一次棋盘容器。反过来做会用上一帧的旧高度算棋盘尺寸,
      // 表现为"遗物变多时棋盘慢一拍才缩小", 中间那一帧会压住手牌。
      this.renderHUD();
      this.renderHand();
      this.renderRelics();
      // 计分台归位到"待命"状态, 否则会残留上一次消除的倍率, 误导玩家
      if (this.renderer && !this.renderer.animating) {
        this.renderer.scoreboard(0, 1, null);
      }
      if (this.renderer) this.renderer.resize();
      this.fitDensity();
    },

    /* -------------------------------------------------------------
     * 自适应密度: 把剩下的竖向空间还给手牌
     *
     * 问题(实测): 棋盘是正方形, 宽度受屏宽限制, 所以在**高瘦屏**上它吃不满
     * 高度 —— iPhone 14 剩 117px, Pro Max 剩 161px, 全变成棋盘上下的空白。
     * 而同一时刻手牌方块只有 12~15px 一格, 小得需要瞄准。这是典型的
     * "布局没错、但空间分配错了": 顶级消除类手游的做法是让主操作区吃满,
     * 剩余空间优先喂给**手指要碰的东西**, 而不是留白。
     *
     * 做法: 棋盘定尺寸之后量一次真实空隙, 把它换算成手牌单元格的额外像素,
     * 通过 CSS 变量 --pcell 下发。宽屏(桌面)不参与 —— 那里空间本来就够,
     * 再放大反而失衡。
     *
     * 为什么放在 JS 而不是 CSS: 空隙大小取决于棋盘的求解结果(见 render.js
     * #resize 的注释, 那本身就是 CSS 表达不了的两向约束), CSS 拿不到这个值。
     * ----------------------------------------------------------- */
    fitDensity() {
      const wrap = $('#board-wrap');
      const canvas = this.canvas;
      if (!wrap || !canvas || !wrap.getBoundingClientRect) return;
      const wr = wrap.getBoundingClientRect();
      const br = canvas.getBoundingClientRect();
      if (!(wr.height > 0) || !(br.height > 0)) return;

      const slack = Math.max(0, wr.height - br.height);
      // 手牌一行最高 4 格, 每格 +1px 会让手牌区长高约 4px(还有 gap)。
      // 取 slack 的 1/6 是留了余量: 宁可少吃一点, 也不能把手牌顶出屏幕。
      const grow = Math.floor(Math.min(slack / 6, 9));
      const base = Math.min(15, Math.max(9, Math.round(br.width / 26)));
      const px = Math.max(9, Math.min(24, base + grow));
      document.documentElement.style.setProperty('--pcell', px + 'px');

      /* 把棋盘的实际宽度广播出去, 让 HUD / 手牌能对齐到同一条竖直基线。
       *
       * 桌面上 #app 的 max-width 是 620px, 而棋盘取的是高宽较短边, 实测只有
       * 481px —— 于是 HUD 比棋盘宽出 139px, 三者左右边缘各不对齐, 看起来像
       * 三个碰巧堆在一起的控件, 而不是一台仪器。顶级消除游戏一律把状态栏、
       * 棋盘、手牌收进同一根栏宽里。
       * 手机上棋盘本来就吃满宽度, 这个值等于容器宽, 不产生任何变化。 */
      document.documentElement.style.setProperty('--board-w', Math.round(br.width) + 'px');
      // 空隙极小的矮屏(如 640 高的安卓机)上 grow 会是 0, 此时维持原尺寸,
      // 不会因为这段逻辑而变得更挤 —— 这是它能安全全局启用的前提。
    },

    renderHUD() {
      const g = this.game;
      $('#hud-level').textContent = g.level;
      $('#hud-score').textContent = g.score.toLocaleString();
      $('#hud-target').textContent = g.target.toLocaleString();
      $('#hud-total').textContent = g.totalScore.toLocaleString();
      $('#hud-seed').textContent = g.seed;
      const pct = Math.min(100, (g.score / g.target) * 100);
      $('#progress-fill').style.width = pct + '%';
      $('#progress-fill').classList.toggle('near', pct > 75);
      $('#btn-undo').disabled = g.undosLeft <= 0 || !g.history.length;
      $('#btn-undo').querySelector('small').textContent = g.undosLeft;
      $('#btn-hint').disabled = this.hintsLeft <= 0;
      $('#btn-hint').querySelector('small').textContent = this.hintsLeft;
      $('#hud-insp').textContent = g.inspiration;
      $('#hud-chain').textContent = g.stats.maxChain;
      this.renderStreak();
    },

    /**
     * 连击条。只在真的有连击时出现 —— 常驻一个"0 连击"的空条既占高度
     * 又天天提醒玩家"你没连上", 是负反馈。
     */
    renderStreak() {
      const g = this.game;
      const row = $('#streak-row');
      if (!row) return;
      const on = g.streak > 0;
      row.classList.toggle('hidden', !on);
      if (!on) return;

      $('#streak-n').textContent = g.streak;
      // 三格进度: 满 3 格兑现 1 灵感, 兑现后归零重来
      const filled = g.streak % 3;
      const pips = $('#streak-pips');
      const want = 3;
      if (pips.children.length !== want) {
        pips.innerHTML = '';
        for (let i = 0; i < want; i++) {
          const d = document.createElement('i');
          pips.appendChild(d);
        }
      }
      for (let i = 0; i < want; i++) {
        // filled===0 说明刚好整除 —— 那一刻三格全亮(刚兑现), 而不是全灭
        const lit = filled === 0 ? true : i < filled;
        pips.children[i].className = lit ? 'on' : '';
      }
      // 宽限提示: 让玩家知道"还能空一手", 否则布局手会让人误以为已断连
      const note = $('#streak-note');
      if (note) {
        note.textContent = g.streakMiss
          ? '宽限 ' + (global.ResonanceGame.STREAK_GRACE - g.streakMiss + 1)
          : filled === 0
            ? '+1 灵感'
            : '再 ' + (3 - filled) + ' 连 +1 灵感';
        note.classList.toggle('warn', !!g.streakMiss);
      }
    },

    renderHand() {
      const wrap = $('#hand');
      wrap.innerHTML = '';
      const g = this.game;
      g.hand.forEach((piece, i) => {
        const el = document.createElement('div');
        el.className = 'hand-slot' + (this.selectedHand === i ? ' selected' : '');
        el.dataset.hand = i;
        if (!g.anyPlacement(piece) && !g.passives.rotate) el.classList.add('dead');
        // 调音师给的牌一定要标出来。竞品把同类机制藏起来, 结果玩家自己发现后
        // 认定"运气被操纵"; 明说反而变成一个体贴的设计 —— 见 game.js 的说明。
        if (piece.tuned) {
          el.classList.add('tuned');
          el.title = '调音师介入：这张牌是保证放得下的';
        }

        let cells = piece.cells;
        if (this.selectedHand === i && this.rotation && g.passives.rotate) {
          for (let r = 0; r < this.rotation % 4; r++)
            cells = global.ResonanceGame.rotateCells(cells);
        }
        const b = global.ResonanceGame.boundsOf(cells);
        const grid = document.createElement('div');
        grid.className = 'piece-grid';
        grid.style.gridTemplateColumns = 'repeat(' + b.w + ',1fr)';
        grid.style.gridTemplateRows = 'repeat(' + b.h + ',1fr)';
        const occupied = new Set(cells.map((c) => c[1] * 10 + c[0]));
        for (let y = 0; y < b.h; y++) {
          for (let x = 0; x < b.w; x++) {
            const d = document.createElement('div');
            d.className = 'pcell';
            if (occupied.has(y * 10 + x)) {
              const col = global.ResonanceRenderer.COLORS[piece.colorIdx];
              d.classList.add('on');
              d.style.background = 'linear-gradient(160deg,' + col.glow + ',' + col.fill + ' 45%,' + col.dark + ')';
              d.style.boxShadow = '0 0 10px ' + col.fill + '88';
              d.textContent = col.glyph;
            }
            grid.appendChild(d);
          }
        }
        el.appendChild(grid);

        if (g.discardsLeft > 0) {
          const dbtn = document.createElement('button');
          dbtn.className = 'discard-btn';
          dbtn.title = '丢弃这个方块';
          dbtn.textContent = '✕';
          dbtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.inputLocked) return;
            if (this.game.discard(i)) {
              global.Audio2.ui();
              this.selectedHand = -1;
              this.renderAll();
              this.saveRun();
            }
          });
          el.appendChild(dbtn);
        }
        wrap.appendChild(el);
      });

      const rotHint = $('#rotate-hint');
      if (rotHint) rotHint.classList.toggle('hidden', !g.passives.rotate);
    },

    renderRelics() {
      const wrap = $('#relics');
      wrap.innerHTML = '';
      this.game.relics.forEach((r, i) => {
        const el = document.createElement('div');
        el.className = 'relic tier' + r.tier;
        // 索引要暴露给渲染层: 计分演出时要精确弹跳"正在生效的那一件"
        el.dataset.relic = i;
        el.innerHTML = global.ICONS.svg(r.id, 18);
        const dyn = typeof r.dyn === 'function' ? r.dyn() : '';
        el.title = r.name + ' — ' + r.desc + (dyn ? ' (' + dyn + ')' : '');
        el.addEventListener('click', () => this.showTip(el, r));
        wrap.appendChild(el);
      });
      if (!this.game.relics.length) {
        wrap.innerHTML = '<div class="relic-empty">过关后可获得遗物</div>';
      }
    },

    showTip(anchor, relic) {
      const tip = $('#tip');
      const dyn = typeof relic.dyn === 'function' ? relic.dyn() : '';
      tip.innerHTML =
        '<b>' + global.ICONS.svg(relic.id, 15) + ' ' + relic.name + '</b><span>' +
        relic.desc + '</span>' +
        (dyn ? '<em>' + dyn + '</em>' : '') +
        (relic.flavor ? '<i class="tip-flavor">' + relic.flavor + '</i>' : '');
      tip.classList.add('show');
      const r = anchor.getBoundingClientRect();
      tip.style.left = Math.min(window.innerWidth - 230, Math.max(8, r.left - 90)) + 'px';
      tip.style.top = r.bottom + 8 + 'px';
      clearTimeout(this._tipT);
      this._tipT = setTimeout(() => tip.classList.remove('show'), 3200);
    },

    /**
     * 无锚点的居中提示。
     *
     * 复用 showTip 的 #tip 元素而不是新造一个浮层, 是为了它们天然互斥 ——
     * 同一个节点不可能同时是"遗物说明"和"系统提示", 也就不会出现两块气泡
     * 叠在一起的脏画面。代价是 showTip 的定位会被 .tip-center 覆盖,
     * 所以这里必须在退出时把类摘掉 (否则下一次 showTip 会被钉在屏幕中央)。
     */
    toast(msg) {
      const tip = $('#tip');
      if (!tip) return;
      tip.innerHTML = '<span>' + msg + '</span>';
      tip.style.left = '';
      tip.style.top = '';
      tip.classList.add('show', 'tip-center');
      clearTimeout(this._tipT);
      this._tipT = setTimeout(() => {
        tip.classList.remove('show', 'tip-center');
      }, 2600);
    },

    /* ---------- 棋盘输入 (鼠标 + 触摸统一) ---------- */
    bindBoardInput() {
      const c = this.canvas;
      const getPos = (e) => {
        const r = c.getBoundingClientRect();
        const t = e.touches && e.touches[0] ? e.touches[0] : e;
        return { x: t.clientX - r.left, y: t.clientY - r.top };
      };

      // 手牌选择
      $('#hand').addEventListener('click', (e) => {
        const slot = e.target.closest('.hand-slot');
        if (!slot || this.inputLocked) return;
        const i = parseInt(slot.dataset.hand, 10);
        if (this.selectedHand === i && this.game.passives.rotate) {
          this.rotation = (this.rotation + 1) % 4;
          global.Audio2.pick();
        } else {
          this.selectedHand = i;
          this.rotation = 0;
          global.Audio2.pick();
        }
        this.renderer.hintMove = null;
        this.renderHand();
      });

      // 手牌拖拽起点 (touch/pointer)
      const startDrag = (e) => {
        const slot = e.target.closest && e.target.closest('.hand-slot');
        if (!slot || this.inputLocked) return;
        const i = parseInt(slot.dataset.hand, 10);
        this.selectedHand = i;
        this.dragging = true;
        this.renderHand();
      };
      $('#hand').addEventListener('pointerdown', startDrag);

      const move = (e) => {
        if (this.inputLocked || this.selectedHand < 0) return;
        const piece = this.currentPiece();
        if (!piece) return;
        const p = getPos(e);
        // 以方块中心对齐手指, 移动端体验的关键
        const b = global.ResonanceGame.boundsOf(piece.cells);
        const cellSz = this.renderer.cell;
        const cx = p.x - ((b.w - 1) * cellSz) / 2;
        const cy = p.y - ((b.h - 1) * cellSz) / 2 - (e.touches ? cellSz * 1.2 : 0);
        const cell = this.renderer.toCell(cx + cellSz / 2, cy + cellSz / 2);
        this.renderer.hover = {
          x: cell.x,
          y: cell.y,
          piece,
          valid: this.game.canPlace(piece, cell.x, cell.y),
        };
      };

      const drop = (e) => {
        if (this.inputLocked || this.selectedHand < 0) {
          this.renderer.hover = null;
          this.dragging = false;
          return;
        }
        const h = this.renderer.hover;
        this.renderer.hover = null;
        this.dragging = false;
        if (!h) return;
        if (h.valid) this.commitPlace(this.selectedHand, h.x, h.y);
        else global.Audio2.invalid();
      };

      c.addEventListener('pointermove', move);
      c.addEventListener('pointerdown', (e) => {
        move(e);
      });
      c.addEventListener('pointerup', drop);
      c.addEventListener('pointerleave', () => {
        if (!this.dragging) this.renderer.hover = null;
      });

      // 触摸: 在整个文档上跟踪, 允许从手牌直接拖到棋盘
      document.addEventListener('pointermove', (e) => {
        if (this.dragging) {
          e.preventDefault();
          move(e);
        }
      }, { passive: false });
      document.addEventListener('pointerup', (e) => {
        if (this.dragging) drop(e);
      });

      // 防止移动端下拉刷新干扰
      c.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    },

    currentPiece() {
      const p = this.game.hand[this.selectedHand];
      if (!p) return null;
      if (!this.rotation || !this.game.passives.rotate) return p;
      let cells = p.cells;
      for (let i = 0; i < this.rotation % 4; i++)
        cells = global.ResonanceGame.rotateCells(cells);
      const b = global.ResonanceGame.boundsOf(cells);
      return Object.assign({}, p, { cells, w: b.w, h: b.h });
    },

    bindKeys() {
      document.addEventListener('keydown', (e) => {
        if (this.currentScreen !== 'game') return;
        if (e.key >= '1' && e.key <= '5') {
          const i = parseInt(e.key, 10) - 1;
          if (i < this.game.hand.length) {
            this.selectedHand = i;
            this.rotation = 0;
            global.Audio2.pick();
            this.renderHand();
          }
        }
        if (e.key === 'r' || e.key === 'R') {
          if (this.game.passives.rotate && this.selectedHand >= 0) {
            this.rotation = (this.rotation + 1) % 4;
            this.renderHand();
          }
        }
        if (e.key === 'z' || e.key === 'Z') this.doUndo();
        if (e.key === 'h' || e.key === 'H') this.doHint();
        if (e.key === 'Escape') {
          this.saveRun();
          this.showScreen('menu');
        }
      });
    },

    /* ---------- 行为 ---------- */
    commitPlace(handIndex, x, y) {
      const ev = this.game.place(handIndex, x, y, this.rotation);
      if (!ev) {
        global.Audio2.invalid();
        return;
      }
      this.selectedHand = -1;
      this.rotation = 0;
      this.inputLocked = true;
      this.renderer.hintMove = null;
      this.renderHand();
      this.renderRelics();

      this.renderer.playEvents(ev, () => {
        this.inputLocked = false;
        this.renderAll();
        this.saveRun();
        // 连击兑现: 灵感是"实打实到账的资源", 必须给一次独立的正反馈,
        // 否则玩家不会把连击和构筑质量联系起来, 计数器就白做了。
        if (ev.streakReward) {
          this.renderer.floater(4, 2, '连击 ×' + ev.streakMilestone + '  +1 灵感', '#ffd382', true);
          global.Audio2.relic();
        }
        if (ev.levelUp) {
          /* 通关事件先记下来。之所以用一个 App 层的一次性标志、而不是在
           * renderOffer() 里直接读 this.game.victoryAt:
           *   - victoryAt 一旦置上就永久为真, 那样第 19、20、21 关的选牌屏
           *     都会重复挂"终章"横幅 —— 一个仪式性的画面被说三遍就不是仪式了;
           *   - 而横幅又必须能活过"刷新选项"(reroll 会重跑 renderOffer),
           *     所以也不能在 renderOffer 里读完就清。
           * 放在 afterLevelChange() 里清除, 正好覆盖"离开这一屏"的全部出口。 */
          if (ev.victory) {
            this.victoryPending = true;
            this.meta.wins = (this.meta.wins || 0) + 1;
            this.saveMeta();
          }

          /* game.js 在遗物池耗尽时会自动进下一关并把 pendingOffer 置空
           * (见 game.js 的注释)。但那个修复只做在了逻辑层 —— 这里如果还是
           * 无条件 showScreen('offer'), 玩家依然会看到一个「第 N 关通过」
           * 却一张卡都没有的屏幕, 只能点"跳过"。逻辑层的补偿(+4 灵感)已经
           * 发过了, 此时正确的表现是直接回到棋盘, 并且告诉玩家发生了什么,
           * 否则他会觉得"我的三选一被系统吃掉了"。 */
          if (!this.game.pendingOffer) {
            global.Audio2.win();
            this.afterLevelChange();
            this.toast('遗物已全部收集 · 折算 +4 灵感');
            return;
          }

          if (ev.victory) global.Audio2.victory();
          else global.Audio2.win();
          this.renderOffer();
          this.showScreen('offer');
        } else if (ev.gameOver) {
          global.Audio2.lose();
          this.endRun();
        }
      });
      // 分数在动画中逐步更新
      this._animScoreTarget = this.game.score;
      this.renderHUD();
    },

    doUndo() {
      if (this.inputLocked) return;
      if (this.game.undo()) {
        global.Audio2.ui();
        this.selectedHand = -1;
        this.renderer.hintMove = null;
        this.renderAll();
        this.saveRun();
      }
    },

    doHint() {
      if (this.inputLocked || this.hintsLeft <= 0) return;
      const h = this.game.hint();
      if (!h) return;
      this.hintsLeft--;
      this.selectedHand = h.hi;
      this.rotation = h.rot || 0;
      this.renderer.hintMove = h;
      global.Audio2.ui();
      this.renderAll();
      setTimeout(() => {
        this.renderer.hintMove = null;
      }, 4200);
    },

    afterLevelChange() {
      // 终章横幅只在通关那一屏出现一次。这里是离开选牌屏的唯一出口
      // (选遗物 / 跳过 / 池耗尽自动进关都走这里), 所以在这清最干净。
      this.victoryPending = false;
      this.selectedHand = -1;
      this.rotation = 0;
      this.renderer.cellFx = {};
      this.showScreen('game');
      this.renderAll();
      this.saveRun();
    },

    renderOffer() {
      const wrap = $('#offer-list');
      wrap.innerHTML = '';
      const offer = this.game.pendingOffer || [];
      $('#offer-level').textContent = this.game.level;
      $('#offer-score').textContent = this.game.totalScore.toLocaleString();

      /* 终章横幅。刻意做成"横幅"而不是"弹窗":
       * 弹窗要一次点击才能继续, 那等于在玩家手感最热的时候按住他的手。
       * 通关在本作里是一个荣誉标记, 不是一道闸门 —— 他可以看一眼就继续
       * 选遗物往下打 (第 19 关起进入实质无尽), 也可以此刻收手去结算。
       * 决定权留给玩家, 这也是整个项目"不操纵玩家"这条线的一部分。 */
      const vicEl = $('#offer-victory');
      const titleEl = $('#offer-title');
      if (vicEl) {
        vicEl.classList.toggle('hidden', !this.victoryPending);
        if (this.victoryPending) {
          const n = $('#victory-level');
          if (n) n.textContent = global.ResonanceGame.FINAL_LEVEL;
        }
      }
      // 通关时让横幅独占标题位, 避免"18"在相邻两行里各说一次。
      if (titleEl) titleEl.classList.toggle('hidden', !!this.victoryPending);

      // 百分位。beatPercentile() 在 <50% 时返回 null, 这时整块隐藏 ——
      // "你高于 14% 的对局"是羞辱, 不是奖励。
      const pctEl = $('#offer-pct');
      if (pctEl) {
        const pct = global.ResonanceGame.beatPercentile(this.game.level);
        pctEl.classList.toggle('hidden', pct == null);
        if (pct != null) $('#offer-pct-n').textContent = pct + '%';
      }
      $('#btn-reroll').disabled = this.game.inspiration < 3;
      $('#btn-reroll').querySelector('small').textContent = this.game.inspiration + ' 灵感';

      offer.forEach((r, i) => {
        const el = document.createElement('button');
        el.className = 'offer-card tier' + r.tier;
        // flavor 用真实音乐史典故, 承担记忆锚点的职责 (见 relics.js 头注释)。
        // 放在 desc 之下、字号更小、颜色更暗: 想快速决策的玩家可以完全跳过它,
        // 想沉浸的玩家能读到东西 —— 两种人都不被打扰。
        el.innerHTML =
          '<div class="oc-icon">' + global.ICONS.svg(r.id, 30) + '</div>' +
          '<div class="oc-name">' + r.name + '</div>' +
          '<div class="oc-tier">' + ['常见', '稀有', '传说'][r.tier - 1] + '</div>' +
          '<div class="oc-desc">' + r.desc + '</div>' +
          (r.flavor ? '<div class="oc-flavor">' + r.flavor + '</div>' : '');
        el.addEventListener('click', () => {
          global.Audio2.select();
          this.game.takeRelic(i);
          this.afterLevelChange();
        });
        wrap.appendChild(el);
      });
    },

    endRun() {
      const g = this.game;
      const isBest = g.totalScore > (this.meta.best || 0);
      if (isBest) this.meta.best = g.totalScore;
      if (g.level > (this.meta.bestLevel || 0)) this.meta.bestLevel = g.level;
      if (g.mode === 'daily') {
        const ds = global.RNG.dailySeed();
        this.meta.dailyDone = this.meta.dailyDone || {};
        this.meta.dailyBest = this.meta.dailyBest || {};
        this.meta.dailyDone[ds] = true;
        this.meta.dailyBest[ds] = Math.max(this.meta.dailyBest[ds] || 0, g.totalScore);
      }
      this.saveMeta();
      global.Platform.removeItem(LS_KEY);

      // 不用 🏆 emoji: 详见 icons.js 头部: 字形三端不一致。
      // 新纪录的"特殊感"改用 CSS 类 (金色 + 微光) 表达, 而不是一个系统字符。
      const titleEl = $('#over-title');
      /* 通关过的这一局, 标题不能是"演出结束"或"新纪录" —— 那两个词都
       * 描述不了"走完了全程"。而且通关比刷新纪录稀有得多(实测 6~8% 的
       * 高手对局才到得了), 所以它优先级最高。 */
      titleEl.textContent = g.victoryAt ? '全部走完' : isBest ? '新纪录' : '演出结束';
      titleEl.classList.toggle('is-record', !!isBest || !!g.victoryAt);

      // 通关徽章。放在结算页, 让这次通关有一个能回看的落点。
      const vicEl = $('#over-victory');
      if (vicEl) {
        vicEl.classList.toggle('hidden', !g.victoryAt);
        const n = vicEl.querySelector('b');
        if (n) n.textContent = global.ResonanceGame.FINAL_LEVEL;
      }
      $('#over-score').textContent = g.totalScore.toLocaleString();
      $('#over-level').textContent = g.level;
      $('#over-chain').textContent = g.stats.maxChain;
      $('#over-lines').textContent = g.stats.totalLines;
      $('#over-res').textContent = g.stats.totalResonated;
      $('#over-streak').textContent = g.bestStreak;
      // 调音师介入次数公开写在结算页。这是"公开"承诺的兑现 ——
      // 一个能自己查证的数字, 比任何"我们绝不作弊"的声明都有说服力。
      const mercyEl = $('#over-mercy');
      if (mercyEl) mercyEl.textContent = g.mercyCount;
      $('#over-seed').textContent = g.seed;

      const rl = $('#over-relics');
      rl.innerHTML = '';
      g.relics.forEach((r) => {
        const d = document.createElement('div');
        d.className = 'relic tier' + r.tier;
        d.innerHTML = global.ICONS.svg(r.id, 18);
        d.title = r.name + ' — ' + r.desc;
        rl.appendChild(d);
      });

      this.showScreen('over');

      /* 结算后插屏。三件事必须按这个顺序:
       *   先 showScreen('over') 把战绩画出来, 再试插屏。
       * 因为广告关掉之后玩家看到的应该是自己的成绩, 而不是一个还在
       * 加载的空页 —— 后者会让人觉得"广告抢在了我的结果前面"。
       * 频次与屏蔽判断全在 Platform 里 (前 3 局不插、至少隔 150 秒),
       * 这里只负责告知"一局结束了"。Web 版 ads.enabled 为 false,
       * 整条链路直接 resolve, 不产生任何可见变化。 */
      global.Platform.maybeInterstitial();
    },

    /**
     * 分享。设计成 Wordle 式的"纯文本战绩" —— 不强制、不给奖励、无跳转,
     * 玩家分享是因为构筑有趣, 而不是因为被勒索。
     * 这类自愿分享的转化率虽低于强制转发, 但不会招致封号与恶评。
     */
    share() {
      const g = this.game;
      /* 构筑行原先是把每件遗物的 emoji 拼起来 (🎵⏱️🟫…)。这有两个问题:
       *   1. 分享文本会落到微信/短信/推特等各种客户端里, emoji 字形三端不同,
       *      对方看到的可能是一排黑白线框, 传达不出"我攒了个厉害的组合";
       *   2. emoji 无法搜索、无法讨论 —— 而本作希望玩家聊的正是构筑名。
       * 改为文字遗物名之后, 分享内容本身变成了社区词汇 (像"延音踏板+共鸣箱"
       * 这样的流派叫法), 这才是 Wordle 式分享真正的传播机制。 */
      const relicLine = g.relics.map((r) => r.name).join(' + ') || '（无遗物裸奔）';
      /* 通关标记进分享文本。这是本作唯一的自然增长机制: 一个稀有到
       * 6~8% 的高手对局才拿得到的标记, 被分享出去时才有可信的分量 ——
       * 如果人人都能贴"通关", 它对看到的人就没有任何信息。 */
      const text =
        'RESONANCE 共振' + (g.victoryAt ? '  ·  通关' : '') + '\n' +
        '第 ' + g.level + ' 关 · ' + g.totalScore.toLocaleString() + ' 分\n' +
        '最长连锁 ×' + g.stats.maxChain + ' · 共振 ' + g.stats.totalResonated + ' 格\n' +
        '构筑: ' + relicLine + '\n' +
        '种子: ' + g.seed + '（同种子可复现，来比比谁强）';

      const btn = $('#btn-share');
      const label = btn && btn.querySelector('span');
      const done = (msg) => {
        if (!label) return;
        const old = label.textContent;
        label.textContent = msg;
        setTimeout(() => (label.textContent = old), 1800);
      };

      // 统一走平台层: Web 用 navigator.share/clipboard, 微信拉起转发面板,
      // 原生壳弹系统分享单 —— 业务代码不需要知道自己跑在哪里。
      global.Platform.share({
        title: 'RESONANCE 共振',
        text: text,
        seed: g.seed,
      }).then((r) => {
        if (!r || !r.ok) return done('复制失败');
        // 原生分享面板已经有自己的反馈, 不必再改按钮文字
        if (r.via === 'clipboard' || r.via === 'execCommand') done('已复制战绩');
      });
    },

    showRelicBook() {
      const wrap = $('#book-list');
      wrap.innerHTML = '';
      const tiers = [[], [], []];
      global.RELICS.list.forEach((r) => tiers[r.tier - 1].push(r));
      ['常见', '稀有', '传说'].forEach((label, ti) => {
        const h = document.createElement('h3');
        h.className = 'book-tier t' + (ti + 1);
        h.textContent = label + ' (' + tiers[ti].length + ')';
        wrap.appendChild(h);
        const grid = document.createElement('div');
        grid.className = 'book-grid';
        tiers[ti].forEach((r) => {
          const el = document.createElement('div');
          el.className = 'book-item tier' + r.tier;
          el.innerHTML =
            '<span class="bi-icon">' + global.ICONS.svg(r.id, 20) + '</span>' +
            '<div><b>' + r.name + '</b><small>' + r.desc + '</small>' +
            (r.flavor ? '<i class="bi-flavor">' + r.flavor + '</i>' : '') +
            '</div>';
          grid.appendChild(el);
        });
        wrap.appendChild(grid);
      });
      this.showScreen('book');
    },

    /* ---------- 主循环 ---------- */
    loop() {
      let last = performance.now();
      const frame = (now) => {
        const dt = Math.min(50, now - last);
        last = now;
        this.renderer.update(dt);
        this.renderer.draw();
        // 分数插值显示
        const el = $('#hud-score');
        if (el && this.currentScreen === 'game') {
          const shown = parseInt(el.textContent.replace(/[^\d]/g, ''), 10) || 0;
          const tgt = this.game.score;
          if (shown !== tgt) {
            const nv = shown + Math.ceil((tgt - shown) * 0.18) || tgt;
            el.textContent = (Math.abs(nv - tgt) < 2 ? tgt : nv).toLocaleString();
            const pct = Math.min(100, (this.game.score / this.game.target) * 100);
            $('#progress-fill').style.width = pct + '%';
          }
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
  };

  /**
   * 启动。
   * 必须同时处理两种情况:
   *  1. 脚本在 DOM 解析完成前执行 -> 等 DOMContentLoaded。
   *  2. 脚本在 DOM 已就绪后才执行 (defer/async/动态注入/被打包器搬到末尾)
   *     -> DOMContentLoaded 早已触发, 再监听就永远等不到, 游戏会卡在白屏。
   * 只写第 2 种情况的兜底是很多"本地能跑、线上白屏"事故的根源。
   */
  function boot() {
    if (App._booted) return;
    App._booted = true;
    App.init();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.ResonanceApp = App;
})(typeof window !== 'undefined' ? window : globalThis);
