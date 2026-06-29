/* =====================================================================
 * 锦鲤棋牌 · 音频引擎 (audio.js)
 * 使用 Web Audio API 程序化生成中式五声音阶背景音乐 + 出牌/胜负音效，
 * 无需任何外部音频文件。音乐会随牌局紧张度（tension 0..1）动态变化。
 * ===================================================================== */
(function (global) {
  'use strict';

  let ctx = null;
  let masterGain = null;
  let musicGain = null, sfxGain = null;
  let musicTimer = null;
  let tension = 0;       // 0 平静 .. 1 紧张
  let enabled = true;
  let musicOn = true;

  // 中国五声音阶（宫商角徵羽）的频率（C 调）
  const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

  function init() {
    if (ctx) return;
    const AC = global.AudioContext || global.webkitAudioContext;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.9;
    masterGain.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.28;
    musicGain.connect(masterGain);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.6;
    sfxGain.connect(masterGain);
  }

  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

  /* ---- 音效合成 ---- */
  function tone(freq, dur, type, gainVal, when, target) {
    if (!ctx || !enabled) return;
    const t0 = when || ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gainVal || 0.3, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(target || sfxGain);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  // 出牌音效：清脆"啪"
  function playCard() {
    init();
    tone(880, 0.08, 'triangle', 0.4);
    tone(1320, 0.06, 'sine', 0.2, ctx.currentTime + 0.02);
  }
  // 过牌
  function pass() { init(); tone(300, 0.12, 'sine', 0.2); }
  // 炸弹：低频爆裂 + 噪声
  function bomb() {
    init();
    const t0 = ctx.currentTime;
    tone(80, 0.5, 'sawtooth', 0.5, t0);
    tone(120, 0.4, 'square', 0.3, t0 + 0.02);
    // 噪声爆裂
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain(); g.gain.value = 0.4;
    src.connect(g); g.connect(sfxGain); src.start(t0);
  }
  // 王炸：更夸张
  function rocket() {
    init();
    bomb();
    const t0 = ctx.currentTime;
    [0, 0.1, 0.2, 0.3].forEach((d, i) => tone(523 + i * 130, 0.15, 'triangle', 0.4, t0 + d));
  }
  // 叫地主
  function callLandlord() {
    init();
    const t0 = ctx.currentTime;
    [392, 523, 659].forEach((f, i) => tone(f, 0.2, 'triangle', 0.35, t0 + i * 0.1));
  }
  // 胜利旋律
  function win() {
    init();
    const t0 = ctx.currentTime;
    [523, 587, 659, 784, 1046].forEach((f, i) => tone(f, 0.3, 'triangle', 0.4, t0 + i * 0.12));
  }
  // 失败
  function lose() {
    init();
    const t0 = ctx.currentTime;
    [392, 349, 294, 261].forEach((f, i) => tone(f, 0.35, 'sine', 0.35, t0 + i * 0.15));
  }
  // 选牌
  function select() { init(); tone(660, 0.05, 'sine', 0.2); }
  // 提示/警告（剩1张报“单”）
  function alertTone() { init(); tone(740, 0.15, 'square', 0.3); }

  /* ---- 背景音乐：随 tension 变化的循环琶音 ---- */
  function startMusic() {
    init();
    if (musicTimer || !musicOn) return;
    let step = 0;
    const schedule = () => {
      if (!musicOn || !enabled) return;
      // tension 越高，节奏越快、音越高、加入低音鼓点
      const interval = 600 - tension * 320;     // ms
      const octave = tension > 0.6 ? 1.5 : 1;
      const idx = (step * 2 + (Math.random() < 0.3 ? 1 : 0)) % PENTATONIC.length;
      const freq = PENTATONIC[idx] * octave;
      tone(freq, 0.5, 'sine', 0.18 + tension * 0.1, ctx.currentTime, musicGain);
      // 低音衬底
      if (step % 2 === 0) tone(PENTATONIC[idx] / 2, 0.7, 'triangle', 0.12, ctx.currentTime, musicGain);
      // 紧张时加鼓点
      if (tension > 0.5 && step % 2 === 1) {
        tone(70, 0.12, 'square', 0.25, ctx.currentTime, musicGain);
      }
      step++;
      musicTimer = setTimeout(schedule, interval);
    };
    schedule();
  }
  function stopMusic() { if (musicTimer) { clearTimeout(musicTimer); musicTimer = null; } }

  function setTension(v) { tension = Math.max(0, Math.min(1, v)); }
  function setEnabled(v) { enabled = v; if (!v) stopMusic(); }
  function setMusicOn(v) { musicOn = v; if (!v) stopMusic(); else startMusic(); }
  function isEnabled() { return enabled; }
  function isMusicOn() { return musicOn; }

  global.Sound = {
    init, resume, playCard, pass, bomb, rocket, callLandlord, win, lose,
    select, alertTone, startMusic, stopMusic, setTension, setEnabled, setMusicOn,
    isEnabled, isMusicOn
  };
})(typeof window !== 'undefined' ? window : globalThis);
