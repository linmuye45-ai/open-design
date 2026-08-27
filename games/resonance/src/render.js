/* =============================================================
 * RESONANCE · render.js
 * Canvas 渲染 + 粒子系统 + 动画时间轴。
 *
 * 关键工程决策: 逻辑层(game.js)在一帧内把整条连锁算完, 返回 events;
 * 渲染层把 events 排成一条 **时间轴** 逐步回放。
 * 好处: 动画时长与游戏状态解耦, 玩家在动画期间的输入被安全排队,
 * 永远不会出现"动画没播完就点下一步导致状态错乱"的经典 bug。
 * ============================================================= */
(function (global) {
  'use strict';

  // 5 色 = 5 个音级。色彩上刻意选高饱和但明度接近的配色,
  // 保证色盲玩家也能靠"形状标记"区分(见 COLOR_GLYPH)。
/**
 * 5 种"振子"配色。取自真实 CRT/示波器磷光体与老式电子元件, 而不是
 * 通用霓虹渐变 —— 后者饱和度全部拉满、色相均匀分布, 看起来像色卡而
 * 不像实物, 是廉价感的主要来源。
 *
 * 这里刻意让亮度不均匀(琥珀最亮、靛蓝最暗), 模拟不同磷光体的实际
 * 发光效率差异; 同时每色配一个 glyph, 色盲玩家靠形状也能区分。
 *
 * glyph 全部取自 Unicode 的 Geometric Shapes 块 (U+25A0–U+25FF)。
 * 这不是巧合: 同一个块里的字符在各平台字体里要么都有、要么都没有, 不会
 * 出现"四个形状正常、第五个变豆腐块"的情况; 且它们均为文本呈现, 不会被
 * 系统当成 emoji 提升成彩色字形 —— 那会直接破坏色盲辅助的本意 (彩色
 * emoji 无法跟随方块颜色), 也与单色仪器面板的美术相抵触。
 * 早期靛色用的是 ★ (U+2605), 它在 Miscellaneous Symbols 块里, 部分平台
 * 会给它 emoji 呈现, 故改为同块的 ▬。
 */
const COLORS = [
  // P22 红磷光体 —— 偏朱, 不是粉
  { fill: '#f2503c', glow: '#ff8f72', dark: '#8f2116', glyph: '●', name: '朱' },
  // P3 琥珀 —— 老式单色终端的经典色, 全场最亮
  { fill: '#ffab1f', glow: '#ffd782', dark: '#9a5c00', glyph: '▲', name: '琥' },
  // P31 绿 —— 示波器标准色
  { fill: '#5fd35f', glow: '#adf0a0', dark: '#1f7a30', glyph: '■', name: '翠' },
  // 青 —— 冷侧, 与琥珀构成互补对比
  { fill: '#3fc9c2', glow: '#96eee7', dark: '#0e6f70', glyph: '◆', name: '青' },
  // 靛 —— 最暗, 作为视觉低音
  { fill: '#7b7bef', glow: '#b7b6ff', dark: '#3a3499', glyph: '▬', name: '靛' },
];

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function easeOutBack(t) {
    const c1 = 1.70158,
      c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
  function easeInQuad(t) {
    return t * t;
  }

  function Renderer(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.game = game;
    this.dpr = Math.min(global.devicePixelRatio || 1, 2);

    this.particles = [];
    this.floaters = []; // 飘分数字
    this.cellFx = {}; // key -> {t, type}
    this.shake = 0;
    this.flash = 0;
    this.chainGlow = 0;

    this.animQueue = [];
    this.animating = false;
    this.animT = 0;

    this.hover = null; // {x,y,piece,valid}
    this.drag = null;
    this.hintMove = null;
    this.reduceMotion = false;

    this.time = 0;
    this.resize();
  }

  /**
   * 棋盘必须是正方形, 且必须完整落在可用区内。
   *
   * 纯 CSS 做不到这件事: `width:auto; height:100%; aspect-ratio:1/1; max-width:100%`
   * 在窄屏上会被 max-width 截断宽度、却保留 100% 的高度, 结果是 300x356 的长方形;
   * 反过来 `width:100%; max-height:100%` 在矮屏上又会溢出压住手牌。
   * 两个方向的约束无法同时由 CSS 求解, 所以尺寸由 JS 独占决定 —— 量父容器,
   * 取短边, 写死 px。这样任何视口下都是精确的正方形且零溢出。
   */
  Renderer.prototype.resize = function () {
    const c = this.canvas;
    const wrap = c.parentNode;
    let avail = 0;

    if (wrap && wrap.getBoundingClientRect) {
      const wr = wrap.getBoundingClientRect();
      let w = wr.width;
      let h = wr.height;
      // 扣掉 padding, 否则棋盘会顶到容器边缘外
      if (global.getComputedStyle) {
        try {
          const cs = global.getComputedStyle(wrap);
          w -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
          h -= (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        } catch (e) { /* jsdom / 老浏览器降级 */ }
      }
      avail = Math.min(w, h);
    }
    // 容器还没布局(首帧/jsdom)时退回自身盒子
    if (!(avail > 0)) {
      const rect = c.getBoundingClientRect();
      avail = Math.min(rect.width, rect.height);
    }

    // floor 到整数 px: 避免亚像素导致的 1px 边缘毛刺
    const size = Math.max(1, Math.floor(avail));
    if (c.style) {
      c.style.width = size + 'px';
      c.style.height = size + 'px';
    }
    c.width = Math.floor(size * this.dpr);
    c.height = Math.floor(size * this.dpr);
    this.size = size;
    this.pad = size * 0.02;
    this.cell = (size - this.pad * 2) / 8;
  };

  /**
   * 更新计分台。这是全游戏最重要的反馈通道。
   *
   * 关键细节: 每次写值都强制重启一次 scale 动画。只改数字而不动画,
   * 连续两次 +8 在视觉上完全一样, 玩家会以为没生效; "弹一下"让
   * *变化本身* 可见, 而不只是变化后的值。
   *
   * 渲染层直接操作 DOM 而不经过 main.js: 计分台是逐帧演出的一部分,
   * 必须与粒子/震屏严格同帧, 绕一层会产生错拍。
   */
  Renderer.prototype.scoreboard = function (base, mult, trigger, finalScore) {
    const doc = global.document;
    if (!doc) return;
    const bEl = doc.getElementById('sb-base');
    const mEl = doc.getElementById('sb-mult');
    const rEl = doc.getElementById('sb-relic');
    if (!bEl || !mEl) return;

    // 待命态显示 "—" 而不是 "0 × 1"。归零的数字看起来像"坏了/我刚亏光了",
    // 破折号则明确传达"仪器待机中", 一个字符的差别, 观感完全不同。
    const idle = base === 0 && mult === 1 && !trigger && finalScore == null;
    const bTxt = idle ? '—' : String(Math.round(base));
    const mTxt = idle ? '—' : String(Math.round(mult * 100) / 100);
    this._sbIdle = idle;
    const bump = (el, txt, big) => {
      if (el.textContent === txt && !big) return;
      el.textContent = txt;
      if (this.reduceMotion) return;
      // 移除 -> 强制回流 -> 重新加, 否则同一 class 连续两次不会重播动画
      el.classList.remove('bump', 'big');
      void el.offsetWidth;
      el.classList.add(big ? 'big' : 'bump');
      setTimeout(() => el.classList.remove('bump', 'big'), big ? 500 : 110);
    };
    bump(bEl, bTxt, false);
    bump(mEl, mTxt, !!(trigger && trigger.kind === 'mult'));

    const sb = doc.getElementById('scoreboard');
    if (sb) sb.classList.toggle('idle', idle);

    if (rEl) {
      if (trigger) {
        rEl.innerHTML =
          (global.ICONS ? global.ICONS.svg(trigger.id, 13) : '') +
          ' <b>' + trigger.name + '</b> ' +
          '<span style="color:' +
          (trigger.kind === 'mult' ? '#fe5f55' : '#009dff') +
          '">' + trigger.label + '</span>';
        rEl.classList.add('show');
      } else if (finalScore == null) {
        rEl.classList.remove('show');
      }
    }
  };

  /** 让遗物条上第 idx 件遗物物理地弹一下, 指明"是它生效了" */
  Renderer.prototype.pulseRelic = function (idx) {
    const doc = global.document;
    if (!doc || this.reduceMotion) return;
    const el = doc.querySelector('#relics .relic[data-relic="' + idx + '"]');
    if (!el) return;
    el.classList.remove('fired');
    void el.offsetWidth;
    el.classList.add('fired');
    setTimeout(() => el.classList.remove('fired'), 420);
  };

  Renderer.prototype.cellRect = function (x, y) {
    const s = this.cell;
    return { x: this.pad + x * s, y: this.pad + y * s, s };
  };

  /** 屏幕坐标 -> 格子坐标 */
  Renderer.prototype.toCell = function (px, py) {
    const x = Math.floor((px - this.pad) / this.cell);
    const y = Math.floor((py - this.pad) / this.cell);
    return { x, y };
  };

  /* ---------- 粒子 ---------- */
  Renderer.prototype.burst = function (x, y, colorIdx, power) {
    if (this.reduceMotion) return;
    const r = this.cellRect(x, y);
    const cx = r.x + r.s / 2,
      cy = r.y + r.s / 2;
    const n = Math.floor((power || 1) * 9);
    const col = COLORS[colorIdx] || COLORS[0];
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const sp = (0.6 + Math.random() * 2.4) * (this.cell * 0.06);
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - this.cell * 0.02,
        life: 1,
        decay: 0.016 + Math.random() * 0.02,
        size: this.cell * (0.06 + Math.random() * 0.12),
        color: Math.random() < 0.35 ? col.glow : col.fill,
        spin: (Math.random() - 0.5) * 0.3,
        rot: Math.random() * Math.PI,
      });
    }
    if (this.particles.length > 1400) this.particles.splice(0, this.particles.length - 1400);
  };

  Renderer.prototype.floater = function (x, y, text, color, big) {
    const r = this.cellRect(x, y);
    this.floaters.push({
      x: r.x + r.s / 2,
      y: r.y + r.s / 2,
      text,
      color: color || '#fff',
      life: 1,
      big: !!big,
    });
  };

  /* ---------- 动画时间轴 ---------- */
  /**
   * 把逻辑事件流编译成动画步骤。
   * 每步有 duration; 渲染层顺序播放, 播完才允许下一次输入。
   */
  Renderer.prototype.playEvents = function (events, onDone) {
    const q = [];
    const self = this;

    q.push({
      dur: 90,
      start() {
        for (const c of events.placed) {
          self.cellFx[c.y * 8 + c.x] = { t: 0, type: 'pop' };
        }
        global.Audio2.place(events.placed.length ? events.placed[0].c : 0);
      },
    });

    events.steps.forEach((step, si) => {
      q.push({
        dur: 230,
        start() {
          // 行/列高亮 + 碎裂
          step.lineCells.forEach((c, i) => {
            self.cellFx[c.y * 8 + c.x] = { t: 0, type: 'clear', delay: i * 0.012 };
            self.burst(c.x, c.y, c.c, 1);
          });
          const pan = ((step.rows[0] || 0) / 8) * 2 - 1;
          global.Audio2.clear(si, step.lineCells.length ? step.lineCells[0].c : 0, pan);
          self.shake = Math.min(1, 0.28 + step.lines * 0.14 + si * 0.06);
          self.flash = 0.35 + si * 0.07;
          self.chainGlow = Math.min(1, (si + 1) / 6);
        },
      });

      if (step.resonatedCells.length) {
        q.push({
          dur: 200,
          start() {
            step.resonatedCells.forEach((c, i) => {
              self.cellFx[c.y * 8 + c.x] = {
                t: 0,
                type: 'resonate',
                delay: i * 0.03,
              };
              self.burst(c.x, c.y, c.c, 1.5);
            });
            global.Audio2.resonate(step.resonatedCells.length, si);
            self.shake = Math.min(1, self.shake + step.resonatedCells.length * 0.05);
          },
        });
      }

      /* ---- 计分演出: 基础分先亮, 然后遗物逐个介入 ---- */
      q.push({
        dur: 130,
        start() {
          self.scoreboard(step.baseStart, step.multStart, null);
        },
      });

      // 每件真正生效的遗物单独占一帧: 图标弹跳 + 数字跳变 + 音高上行。
      // 这一步是"用动画替代说明书" —— 玩家看到 泛音列×1.5 紧接着
      // 纯五度×3, 自己就推理出了乘区叠乘的价值, 无需任何文字教学。
      (step.triggers || []).forEach((t, ti) => {
        q.push({
          dur: t.kind === 'mult' ? 210 : 155,
          start() {
            self.scoreboard(t.base, t.mult, t);
            self.pulseRelic(t.idx);
            if (t.kind === 'mult') {
              global.Audio2.multTrigger(ti);
              self.shake = Math.min(1, self.shake + 0.16);
              self.flash = Math.max(self.flash, 0.22);
            } else {
              global.Audio2.chipTrigger(ti);
            }
          },
        });
      });

      q.push({
        dur: 170,
        start() {
          const cx = step.lineCells.length ? step.lineCells[0].x : 4;
          const cy = step.rows.length ? step.rows[0] : step.lineCells[0].y;
          const label =
            '+' + step.score + (step.chain > 0 ? '  ×' + step.chain + '连锁' : '');
          self.floater(cx, cy, label, '#fff', step.chain > 1 || step.lines > 1);
          self.scoreboard(step.base, step.mult, null, step.score);
          if (step.sameColor) {
            self.floater(cx, Math.max(0, cy - 1), '同色共鸣!', '#ffd382', true);
            global.Audio2.relic();
          }
        },
      });
    });

    if (events.rescued) {
      q.push({
        dur: 200,
        start() {
          self.floater(4, 7, '第二口气!', '#a5f3c4', true);
          global.Audio2.relic();
        },
      });
    }

    this.animQueue = q;
    this.animating = true;
    this.animT = 0;
    this._onAnimDone = onDone;
    this._stepStarted = false;
  };

  Renderer.prototype._updateAnim = function (dt) {
    if (!this.animating) return;
    const step = this.animQueue[0];
    if (!step) {
      this.animating = false;
      const cb = this._onAnimDone;
      this._onAnimDone = null;
      if (cb) cb();
      return;
    }
    if (!this._stepStarted) {
      this._stepStarted = true;
      if (step.start) step.start();
    }
    this.animT += dt;
    const dur = this.reduceMotion ? step.dur * 0.35 : step.dur;
    if (this.animT >= dur) {
      this.animQueue.shift();
      this.animT = 0;
      this._stepStarted = false;
    }
  };

  /* ---------- 主循环 ---------- */
  Renderer.prototype.update = function (dt) {
    this.time += dt;
    this._updateAnim(dt);

    const f = dt / 16.67;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * f;
      p.y += p.vy * f;
      p.vy += this.cell * 0.006 * f;
      p.vx *= 0.985;
      p.rot += p.spin * f;
      p.life -= p.decay * f;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const fl = this.floaters[i];
      fl.y -= this.cell * 0.014 * f;
      fl.life -= 0.014 * f;
      if (fl.life <= 0) this.floaters.splice(i, 1);
    }
    for (const k in this.cellFx) {
      const fx = this.cellFx[k];
      fx.t += 0.055 * f;
      if (fx.t >= 1.4) delete this.cellFx[k];
    }
    this.shake *= Math.pow(0.86, f);
    this.flash *= Math.pow(0.88, f);
    this.chainGlow *= Math.pow(0.97, f);
  };

  Renderer.prototype.draw = function () {
    const ctx = this.ctx;
    const g = this.game;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.size, this.size);

    // 抖动
    if (this.shake > 0.01) {
      const s = this.shake * this.cell * 0.16;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    this._drawBoardBg(ctx);
    this._drawCells(ctx);
    this._drawGhost(ctx);
    this._drawHint(ctx);
    this._drawParticles(ctx);
    this._drawFloaters(ctx);

    if (this.flash > 0.01) {
      ctx.fillStyle = 'rgba(255,255,255,' + this.flash * 0.16 + ')';
      ctx.fillRect(0, 0, this.size, this.size);
    }

    this._drawScanlines(ctx);
    ctx.restore();
  };

  /**
   * 扫描线覆盖层。画在最上面(含粒子之上), 因为在真实 CRT 上, 阴罩
   * 遮挡的是所有发光物, 不分前后 —— 只盖背景会立刻露出"这是滤镜"的马脚。
   *
   * 之所以按 dpr 决定行距: 高分屏上 2px 周期会细到看不见, 反而只是
   * 让画面变暗; 低分屏上又会产生摩尔纹。跟着物理像素走才稳定。
   */
  Renderer.prototype._drawScanlines = function (ctx) {
    if (this.reduceMotion) return;
    const S = this.size;
    const step = this.dpr >= 2 ? 2 : 3;
    ctx.save();
    ctx.globalAlpha = 0.055;
    ctx.fillStyle = '#000';
    for (let y = 0; y < S; y += step) {
      ctx.fillRect(0, y, S, step * 0.5);
    }
    ctx.restore();
  };

  Renderer.prototype._roundRect = function (ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  };

  /**
   * 棋盘 = 示波器荧光屏。
   *
   * 不用"深色圆角 + 棋盘格斑马纹"那套默认写法, 因为斑马纹会与方块
   * 争夺注意力, 且毫无叙事。这里画的是仪器屏幕: 玻璃暗绿底、坐标
   * 刻度网格、中轴线、边缘晕影(模拟阴罩遮挡)。网格同时是功能性的 ——
   * 它让玩家不必逐格数就能判断对齐, 落子精度显著提升。
   */
  Renderer.prototype._drawBoardBg = function (ctx) {
    const pad = this.pad,
      s = this.cell;
    const S = this.size;

    // --- 屏幕玻璃 ---
    this._roundRect(ctx, pad * 0.3, pad * 0.3, S - pad * 0.6, S - pad * 0.6, s * 0.18);
    ctx.save();
    ctx.clip();

    const grd = ctx.createRadialGradient(S * 0.5, S * 0.42, 0, S * 0.5, S * 0.5, S * 0.72);
    grd.addColorStop(0, '#14211c');
    grd.addColorStop(1, '#080c0b');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, S, S);

    // --- 坐标网格 (每格一条细线, 中轴加粗) ---
    ctx.lineWidth = Math.max(0.5, S * 0.0015);
    for (let i = 0; i <= 8; i++) {
      const mid = i === 4;
      ctx.strokeStyle = mid
        ? 'rgba(120, 220, 190, 0.14)'
        : 'rgba(120, 220, 190, 0.065)';
      const p = pad + i * s;
      ctx.beginPath();
      ctx.moveTo(p, pad);
      ctx.lineTo(p, S - pad);
      ctx.moveTo(pad, p);
      ctx.lineTo(S - pad, p);
      ctx.stroke();
    }

    // --- 每格中心的细小十字刻度 (仪器感的来源) ---
    ctx.strokeStyle = 'rgba(120, 220, 190, 0.10)';
    const tick = s * 0.07;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const cx = pad + x * s + s / 2;
        const cy = pad + y * s + s / 2;
        ctx.beginPath();
        ctx.moveTo(cx - tick, cy);
        ctx.lineTo(cx + tick, cy);
        ctx.moveTo(cx, cy - tick);
        ctx.lineTo(cx, cy + tick);
        ctx.stroke();
      }
    }

    // --- 边缘晕影: 模拟阴罩与玻璃厚度, 把视线压向中心 ---
    const vig = ctx.createRadialGradient(S * 0.5, S * 0.5, S * 0.3, S * 0.5, S * 0.5, S * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, S, S);

    ctx.restore();

    // --- 屏框: 内暗外亮, 做出"玻璃嵌在金属里"的层次 ---
    this._roundRect(ctx, pad * 0.3, pad * 0.3, S - pad * 0.6, S - pad * 0.6, s * 0.18);
    ctx.strokeStyle = 'rgba(255, 240, 205, 0.10)';
    ctx.lineWidth = Math.max(1, S * 0.004);
    ctx.stroke();

    // 连锁时屏框整体过载泛光 —— 用琥珀色, 和计分台的倍率红区分开
    if (this.chainGlow > 0.02) {
      ctx.save();
      ctx.shadowColor = 'rgba(255, 176, 46, 0.9)';
      ctx.shadowBlur = 10 + this.chainGlow * 26;
      ctx.strokeStyle = 'rgba(255, 190, 90,' + this.chainGlow * 0.75 + ')';
      ctx.lineWidth = 1.5 + this.chainGlow * 3.5;
      ctx.stroke();
      ctx.restore();
    }
  };

  Renderer.prototype._drawBlock = function (ctx, px, py, s, colorIdx, scale, alpha, glyph) {
    const col = COLORS[colorIdx] || COLORS[0];
    const inset = s * 0.055;
    const w = (s - inset * 2) * (scale == null ? 1 : scale);
    const off = (s - inset * 2 - w) / 2;
    const x = px + inset + off,
      y = py + inset + off;

    ctx.globalAlpha = alpha == null ? 1 : alpha;

    // 阴影
    ctx.save();
    ctx.shadowColor = col.fill;
    ctx.shadowBlur = s * 0.28;
    this._roundRect(ctx, x, y, w, w, s * 0.17);
    const grd = ctx.createLinearGradient(x, y, x, y + w);
    grd.addColorStop(0, col.glow);
    grd.addColorStop(0.45, col.fill);
    grd.addColorStop(1, col.dark);
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.restore();

    // 高光
    this._roundRect(ctx, x + w * 0.12, y + w * 0.1, w * 0.76, w * 0.3, s * 0.1);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fill();

    // 色盲辅助符号
    if (glyph !== false && w > s * 0.4) {
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.font = 'bold ' + Math.floor(w * 0.36) + 'px system-ui,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(col.glyph, x + w / 2, y + w * 0.62);
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawCells = function (ctx) {
    const g = this.game,
      s = this.cell;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const v = g.board[y * 8 + x];
        const fx = this.cellFx[y * 8 + x];
        if (v === -1 && !fx) continue;
        const r = this.cellRect(x, y);

        if (fx) {
          const t = Math.max(0, fx.t - (fx.delay || 0));
          if (fx.type === 'pop') {
            const k = Math.min(1, t / 0.5);
            this._drawBlock(ctx, r.x, r.y, s, v, 0.6 + easeOutBack(k) * 0.4, 1);
            continue;
          }
          if (fx.type === 'clear' || fx.type === 'resonate') {
            const k = Math.min(1, t / 0.6);
            if (k < 1) {
              const sc = 1 + easeOutCubic(k) * (fx.type === 'resonate' ? 0.7 : 0.45);
              this._drawBlock(ctx, r.x, r.y, s, v === -1 ? 0 : v, sc, 1 - k);
            }
            continue;
          }
        }
        if (v !== -1) this._drawBlock(ctx, r.x, r.y, s, v, 1, 1);
      }
    }
  };

  /** 拖拽预览: 合法则显示落点轮廓 + 预测消除的行列 */
  Renderer.prototype._drawGhost = function (ctx) {
    const h = this.hover;
    if (!h || !h.piece) return;
    const g = this.game,
      s = this.cell;

    if (h.valid) {
      // 预测: 放下后哪些行列会满 -> 提前高亮, 这是"看得懂"的关键
      const saved = g.board.slice();
      for (const [dx, dy] of h.piece.cells) {
        const x = h.x + dx,
          y = h.y + dy;
        if (x >= 0 && y >= 0 && x < 8 && y < 8) g.board[y * 8 + x] = h.piece.colorIdx;
      }
      const full = g._findFullLines();
      g.board = saved;

      const pulse = 0.35 + Math.sin(this.time / 140) * 0.15;
      ctx.fillStyle = 'rgba(255,255,255,' + pulse * 0.5 + ')';
      for (const y of full.rows) {
        const r = this.cellRect(0, y);
        this._roundRect(ctx, r.x, r.y, s * 8, s, s * 0.2);
        ctx.fill();
      }
      for (const x of full.cols) {
        const r = this.cellRect(x, 0);
        this._roundRect(ctx, r.x, r.y, s, s * 8, s * 0.2);
        ctx.fill();
      }
    }

    for (const [dx, dy] of h.piece.cells) {
      const x = h.x + dx,
        y = h.y + dy;
      if (x < 0 || y < 0 || x >= 8 || y >= 8) continue;
      const r = this.cellRect(x, y);
      if (h.valid) {
        this._drawBlock(ctx, r.x, r.y, s, h.piece.colorIdx, 0.9, 0.5);
      } else {
        const inset = s * 0.055;
        this._roundRect(ctx, r.x + inset, r.y + inset, s - inset * 2, s - inset * 2, s * 0.17);
        ctx.fillStyle = 'rgba(255,80,80,0.22)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,80,80,0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  };

  Renderer.prototype._drawHint = function (ctx) {
    if (!this.hintMove) return;
    const g = this.game,
      s = this.cell;
    const piece = g.hand[this.hintMove.hi];
    if (!piece) return;
    let cells = piece.cells;
    for (let i = 0; i < (this.hintMove.rot || 0); i++)
      cells = global.ResonanceGame.rotateCells(cells);
    const pulse = 0.4 + Math.sin(this.time / 200) * 0.3;
    for (const [dx, dy] of cells) {
      const r = this.cellRect(this.hintMove.x + dx, this.hintMove.y + dy);
      const inset = s * 0.055;
      this._roundRect(ctx, r.x + inset, r.y + inset, s - inset * 2, s - inset * 2, s * 0.17);
      ctx.strokeStyle = 'rgba(255,255,255,' + pulse + ')';
      ctx.lineWidth = 3;
      ctx.setLineDash([s * 0.14, s * 0.1]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  };

  Renderer.prototype._drawParticles = function (ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      const sz = p.size * (0.4 + p.life * 0.6);
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._drawFloaters = function (ctx) {
    for (const f of this.floaters) {
      const a = Math.min(1, f.life * 1.6);
      ctx.globalAlpha = a;
      const fs = this.cell * (f.big ? 0.46 : 0.34);
      ctx.font = '900 ' + fs + 'px system-ui,-apple-system,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = fs * 0.18;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  };

  Renderer.COLORS = COLORS;
  global.ResonanceRenderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
