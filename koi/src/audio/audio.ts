/**
 * =============================================================================
 *  锦鲤牌阵 · 动态音效引擎 (audio.ts)
 * -----------------------------------------------------------------------------
 *  使用 WebAudio API 合成占位音效与随局势变化的氛围音，无需外部音频资源。
 *  正式版可替换为国风乐器采样（古筝/木鱼/编钟/锣鼓）。
 *
 *  - 状态机：calm(平局) → heat(连击升温) → boss(紧张) → burst(爆分高潮)
 *  - 一键静音（setMuted）。测试/无 AudioContext 环境自动降级为静默。
 * =============================================================================
 */

export type Mood = "calm" | "heat" | "boss" | "burst";

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private mood: Mood = "calm";
  private started = false;

  /** 需在用户手势后调用（浏览器策略要求） */
  init(): void {
    if (this.started) return;
    try {
      const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      this.started = true;
    } catch {
      /* 无音频环境：静默降级 */
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMood(mood: Mood): void {
    this.mood = mood;
  }

  getMood(): Mood {
    return this.mood;
  }

  /** 基础提示音合成 */
  private beep(freq: number, dur: number, type: OscillatorType = "sine", vol = 0.3): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // ---- 语义化音效（供 UI 调用） ----
  select(): void { this.beep(660, 0.08, "triangle", 0.15); }
  deselect(): void { this.beep(440, 0.06, "triangle", 0.12); }

  /** 出牌爆分：音阶随得分等级爬升 */
  play(scoreTier: number): void {
    const base = 523.25; // C5
    const steps = [0, 4, 7, 12, 16, 19];
    const n = Math.min(scoreTier, steps.length - 1);
    for (let i = 0; i <= n; i++) {
      const f = base * Math.pow(2, steps[i] / 12);
      setTimeout(() => this.beep(f, 0.14, "sawtooth", 0.16), i * 55);
    }
    if (scoreTier >= 3) this.setMood("burst");
  }

  discard(): void { this.beep(300, 0.1, "sine", 0.12); }
  buy(): void { this.beep(880, 0.1, "triangle", 0.18); this.beep(1174, 0.12, "triangle", 0.14); }
  clearLevel(): void {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.beep(f, 0.18, "triangle", 0.2), i * 90));
  }
  bossAppear(): void {
    this.setMood("boss");
    [220, 185, 165].forEach((f, i) => setTimeout(() => this.beep(f, 0.3, "sawtooth", 0.22), i * 120));
  }
  win(): void {
    [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => this.beep(f, 0.25, "triangle", 0.22), i * 120));
  }
  lose(): void {
    [392, 349, 294, 220].forEach((f, i) => setTimeout(() => this.beep(f, 0.3, "sine", 0.2), i * 130));
  }
}

export const audio = new AudioEngine();
