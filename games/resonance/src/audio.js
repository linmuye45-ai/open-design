/* =============================================================
 * RESONANCE · audio.js
 * Procedural音频引擎 — 纯 WebAudio，零音频文件，零加载。
 *
 * 设计核心（本作最大差异化）:
 * 5 种方块颜色 = 五声音阶(pentatonic) 的 5 个音级。
 * 五声音阶的数学性质: 任意两音同时发声都不产生小二度/增四度等
 * 刺耳音程 —— 也就是说 **玩家无论怎么乱消，听起来都是"好听的"**。
 * 于是"连锁"不再只是加分动画，而是在自动演奏一段旋律：
 *   连锁越长 -> 音阶越往上爬 -> 听觉上的"上升感"与分数上升同步。
 * 这把多巴胺从纯视觉扩展到听觉，且不会像贴片音效那样听 200 次就烦。
 *
 * 工程上: 单 AudioContext + 每音一个短生命周期 Oscillator，
 * 全部走 masterGain -> 压缩器，避免长连锁时爆音削波。
 * ============================================================= */
(function (global) {
  'use strict';

  // A minor pentatonic 上两个八度, 单位 Hz。
  // 度数: A C D E G —— 对应 5 个方块色相。
  const BASE = [220.0, 261.63, 293.66, 329.63, 392.0];

  function midiToFreq(n) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  // 五声音阶音级 (A minor pentatonic), 半音偏移
  const PENTA_STEPS = [0, 3, 5, 7, 10];
  /** 把"第 i 个音级"映射到频率, i 可以无限往上爬, 自动跨八度 */
  function pentaFreq(i, rootMidi) {
    const root = rootMidi == null ? 57 : rootMidi; // A3
    const oct = Math.floor(i / 5);
    const deg = ((i % 5) + 5) % 5;
    return midiToFreq(root + PENTA_STEPS[deg] + 12 * oct);
  }

  const Audio = {
    ctx: null,
    master: null,
    comp: null,
    reverb: null,
    enabled: true,
    muted: false,
    volume: 0.5,
    _unlocked: false,

    init() {
      if (this.ctx) return;
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) {
        this.enabled = false;
        return;
      }
      try {
        this.ctx = new AC();
      } catch (e) {
        this.enabled = false;
        return;
      }
      const ctx = this.ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.volume;

      // 软压缩: 长连锁时多音叠加不会削波爆音
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18;
      this.comp.knee.value = 24;
      this.comp.ratio.value = 6;
      this.comp.attack.value = 0.003;
      this.comp.release.value = 0.25;

      // 程序化生成的 impulse response 混响 —— 让方块有"空间感"
      this.reverb = ctx.createConvolver();
      this.reverb.buffer = this._makeIR(1.9, 2.6);
      this.wet = ctx.createGain();
      this.wet.gain.value = 0.28;

      this.master.connect(this.comp);
      this.comp.connect(ctx.destination);
      this.master.connect(this.wet);
      this.wet.connect(this.reverb);
      this.reverb.connect(this.comp);
    },

    /** 噪声衰减法合成 impulse response, 免去下载 IR 文件 */
    _makeIR(seconds, decay) {
      const ctx = this.ctx;
      const rate = ctx.sampleRate;
      const len = Math.max(1, Math.floor(rate * seconds));
      const buf = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const t = i / len;
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        }
      }
      return buf;
    },

    unlock() {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._unlocked = true;
    },

    setVolume(v) {
      this.volume = v;
      if (this.master) this.master.gain.value = this.muted ? 0 : v;
    },
    setMuted(m) {
      this.muted = !!m;
      if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    },

    _now() {
      return this.ctx.currentTime;
    },

    /** 通用单音 */
    tone(opts) {
      if (!this.enabled || this.muted) return;
      this.init();
      if (!this.ctx) return;
      const ctx = this.ctx;
      const o = Object.assign(
        {
          freq: 440,
          type: 'sine',
          dur: 0.32,
          gain: 0.22,
          attack: 0.006,
          delay: 0,
          detune: 0,
          pan: 0,
          glide: 0,
        },
        opts || {}
      );
      const t0 = this._now() + o.delay;

      const osc = ctx.createOscillator();
      osc.type = o.type;
      osc.frequency.setValueAtTime(o.freq, t0);
      if (o.glide) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, o.freq * o.glide),
          t0 + o.dur
        );
      }
      if (o.detune) osc.detune.setValueAtTime(o.detune, t0);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(o.gain, t0 + o.attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

      let node = osc;
      if (o.pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, o.pan));
        node.connect(g);
        g.connect(p);
        p.connect(this.master);
      } else {
        node.connect(g);
        g.connect(this.master);
      }

      osc.start(t0);
      osc.stop(t0 + o.dur + 0.05);
    },

    /** 噪声打击音 (用于放置方块的"哒") */
    noise(opts) {
      if (!this.enabled || this.muted) return;
      this.init();
      if (!this.ctx) return;
      const ctx = this.ctx;
      const o = Object.assign(
        { dur: 0.12, gain: 0.12, delay: 0, hp: 800, lp: 6000 },
        opts || {}
      );
      const t0 = this._now() + o.delay;
      const len = Math.floor(ctx.sampleRate * o.dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = o.hp;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lp;

      const g = ctx.createGain();
      g.gain.value = o.gain;

      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(this.master);
      src.start(t0);
    },

    /* ---------- 游戏语义音效 ---------- */

    /** 放置方块 */
    place(colorIdx) {
      const i = colorIdx == null ? 0 : colorIdx;
      this.noise({ dur: 0.09, gain: 0.09, hp: 1200, lp: 7000 });
      this.tone({
        freq: pentaFreq(i, 45),
        type: 'triangle',
        dur: 0.18,
        gain: 0.1,
      });
    },

    /** 无法放置 —— 故意做得"柔和"，不惩罚玩家的耳朵 */
    invalid() {
      this.tone({ freq: 180, type: 'sine', dur: 0.14, gain: 0.07, glide: 0.8 });
    },

    /** 拾起方块 */
    pick() {
      this.tone({ freq: 660, type: 'sine', dur: 0.07, gain: 0.05 });
    },

    /**
     * 消除一条线。
     * step = 本次连锁中的第几次消除 -> 音阶递增, 形成上升旋律。
     * colorIdx 决定和声中的色彩音。
     */
    clear(step, colorIdx, pan) {
      const s = step || 0;
      const base = 5 + s; // 从 A4 区域开始往上爬
      this.tone({
        freq: pentaFreq(base, 57),
        type: 'sine',
        dur: 0.5,
        gain: 0.2,
        pan: pan || 0,
      });
      // 五度叠音, 厚度
      this.tone({
        freq: pentaFreq(base + 2, 57),
        type: 'sine',
        dur: 0.42,
        gain: 0.11,
        delay: 0.02,
        pan: (pan || 0) * -0.6,
      });
      // 色彩音: 由颜色决定, 让"清同色行"听起来有辨识度
      if (colorIdx != null) {
        this.tone({
          freq: pentaFreq(base + 5 + colorIdx, 57),
          type: 'triangle',
          dur: 0.3,
          gain: 0.07,
          delay: 0.04,
        });
      }
      this.noise({ dur: 0.18, gain: 0.06, hp: 2000, lp: 11000 });
    },

    /** 共振链式引爆 —— 快速上行琶音, 连锁越长越亢奋 */
    resonate(count, step) {
      const n = Math.min(count || 1, 12);
      for (let i = 0; i < n; i++) {
        this.tone({
          freq: pentaFreq(8 + (step || 0) + i, 57),
          type: 'sine',
          dur: 0.26,
          gain: 0.13,
          delay: i * 0.045,
          pan: (i % 2 ? 1 : -1) * 0.35,
        });
      }
    },

    /** 遗物触发 —— 明亮的铃声, 让玩家清楚"我的构筑生效了" */
    /**
     * 基础分遗物生效: 短促的"筹码"声, 音高随触发顺序上行。
     * 上行音阶是关键 —— 耳朵能听出"还在叠加中", 形成期待感,
     * 这是 Balatro 计分阶段最有效的一招。
     */
    chipTrigger(i) {
      const n = i || 0;
      this.tone({
        freq: pentaFreq(9 + n, 57),
        type: 'triangle',
        dur: 0.13,
        gain: 0.13,
        attack: 0.002,
      });
      this.noise({ dur: 0.05, gain: 0.045, hp: 3500, lp: 12000 });
    },

    /**
     * 倍率遗物生效: 明显更"重"的声音 —— 低八度方波打底 + 上行泛音。
     * 与 chipTrigger 的音色差必须大到闭眼也能分辨, 因为乘区是构筑爆点,
     * 玩家需要在听觉上就知道"这一件才是关键"。
     */
    multTrigger(i) {
      const n = i || 0;
      this.tone({
        freq: pentaFreq(4 + n, 57),
        type: 'square',
        dur: 0.3,
        gain: 0.1,
        attack: 0.003,
      });
      this.tone({
        freq: pentaFreq(11 + n, 57),
        type: 'sawtooth',
        dur: 0.22,
        gain: 0.06,
        delay: 0.03,
      });
      this.noise({ dur: 0.1, gain: 0.05, hp: 1200, lp: 8000 });
    },

    relic() {
      this.tone({ freq: pentaFreq(12, 57), type: 'sine', dur: 0.7, gain: 0.14 });
      this.tone({
        freq: pentaFreq(15, 57),
        type: 'sine',
        dur: 0.6,
        gain: 0.09,
        delay: 0.05,
      });
      this.tone({
        freq: pentaFreq(17, 57),
        type: 'sine',
        dur: 0.5,
        gain: 0.06,
        delay: 0.1,
      });
    },

    /** 过关 —— 上行大琶音 */
    win() {
      const seq = [0, 2, 4, 5, 7, 9, 10, 12];
      seq.forEach((s, i) => {
        this.tone({
          freq: pentaFreq(s + 5, 57),
          type: 'sine',
          dur: 0.6,
          gain: 0.16,
          delay: i * 0.075,
        });
      });
    },

    /**
     * 通关 (终章) —— 全曲唯一一次"落地"的音型。
     *
     * 过关音 win() 是一条一路向上的琶音: 它故意不解决, 听觉上永远在
     * "还没到"的状态, 这正是让人一关接一关往下打的东西。
     * 通关必须和它形成对比 —— 所以这里先向上冲一层, 然后把根音、五度、
     * 八度**同时**按下并拖长 (那是一个到主和弦的终止式), 再让它在混响里
     * 自然衰减。玩了 18 关都没听过一次真正解决的和弦, 听到这一下会有
     * 明确的"结束了"的生理反应 —— 而这个反应无法用音量或时长伪造。
     *
     * 刻意不加胜利音效常见的上行滑音/闪光声: 本作的美术与音频全程是
     * 克制的, 结尾突然放烟花会破掉前 18 关攒起来的调性一致感。
     */
    victory() {
      // 冲刺: 比 win() 更高、更快, 制造"最后一击"
      [0, 2, 4, 7].forEach((s, i) => {
        this.tone({
          freq: pentaFreq(s + 10, 57),
          type: 'sine',
          dur: 0.35,
          gain: 0.12,
          delay: i * 0.062,
        });
      });
      // 终止式: 根音 + 五度 + 八度 + 高八度, 同时起, 长衰减
      const chord = [0, 3, 5, 8];
      chord.forEach((s, i) => {
        this.tone({
          freq: pentaFreq(s, 45), // 低一个八度落地, 听觉重心明显下沉
          type: 'triangle',
          dur: 2.6,
          gain: 0.13 - i * 0.02,
          delay: 0.3,
        });
      });
      // 泛音层: 极轻, 只负责让和弦"发亮"而不是变响
      chord.forEach((s, i) => {
        this.tone({
          freq: pentaFreq(s + 10, 45),
          type: 'sine',
          dur: 2.2,
          gain: 0.045 - i * 0.008,
          delay: 0.34 + i * 0.02,
        });
      });
    },

    /** 失败 —— 下行, 但用大调色彩, 不制造挫败羞辱感 */
    lose() {
      const seq = [10, 7, 5, 3, 0];
      seq.forEach((s, i) => {
        this.tone({
          freq: pentaFreq(s, 50),
          type: 'triangle',
          dur: 0.75,
          gain: 0.13,
          delay: i * 0.13,
        });
      });
    },

    /** UI 点击 */
    ui() {
      this.tone({ freq: 880, type: 'sine', dur: 0.05, gain: 0.04 });
    },

    /** 选择遗物 */
    select() {
      this.tone({ freq: pentaFreq(7, 57), type: 'sine', dur: 0.3, gain: 0.13 });
      this.tone({
        freq: pentaFreq(10, 57),
        type: 'sine',
        dur: 0.3,
        gain: 0.08,
        delay: 0.04,
      });
    },
  };

  global.Audio2 = Audio;
  global.PENTA = { pentaFreq, PENTA_STEPS, BASE };
})(typeof window !== 'undefined' ? window : globalThis);
