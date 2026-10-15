/**
 * Audio - fully procedural WebAudio soundscape (no sample files).
 *
 * Beds: wind (filtered brown noise), rain (filtered white noise), an ambient
 * drone whose pitch follows the day/night cycle.
 * One-shots: thunder, burner whoosh, impact, UI blip, milestone chime.
 *
 * Everything is created lazily on the first user gesture (browser autoplay
 * policy) and every parameter is driven from the WASM weather state, so the
 * mix responds to the same numbers the renderer does.
 */

import { Storage } from "./Storage";
import { W } from "../sim/layout";

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;
  private droneOscs: OscillatorNode[] = [];
  private droneFilter: BiquadFilterNode | null = null;
  private whiteNoise: AudioBuffer | null = null;
  private brownNoise: AudioBuffer | null = null;
  muted: boolean;
  ready = false;
  private lastThunder = 0;

  constructor() {
    this.muted = Storage.getMuted();
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (this.ready) {
      if (this.ctx?.state === "suspended") await this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.85;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 22;
      comp.ratio.value = 8;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      master.connect(comp).connect(ctx.destination);
      this.master = master;

      this.whiteNoise = this.makeNoise(ctx, 2.2, false);
      this.brownNoise = this.makeNoise(ctx, 2.6, true);

      this.buildWind(ctx, master);
      this.buildRain(ctx, master);
      this.buildDrone(ctx, master);

      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      this.ready = true;
    } catch {
      // Audio is a nice-to-have; never let it break the game.
      this.ready = false;
    }
  }

  private makeNoise(ctx: AudioContext, seconds: number, brown: boolean): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.2;
      } else {
        data[i] = white * 0.7;
      }
    }
    return buf;
  }

  private loopingSource(ctx: AudioContext, buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start();
    return src;
  }

  private buildWind(ctx: AudioContext, master: GainNode): void {
    if (!this.brownNoise) return;
    const src = this.loopingSource(ctx, this.brownNoise, 0.85);
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    src.connect(filter).connect(gain).connect(master);
    this.windFilter = filter;
    this.windGain = gain;
  }

  private buildRain(ctx: AudioContext, master: GainNode): void {
    if (!this.whiteNoise) return;
    const src = this.loopingSource(ctx, this.whiteNoise, 1.0);
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 7200;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    src.connect(hp).connect(lp).connect(gain).connect(master);
    this.rainFilter = lp;
    this.rainGain = gain;
  }

  private buildDrone(ctx: AudioContext, master: GainNode): void {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    filter.connect(gain).connect(master);
    this.droneFilter = filter;
    this.droneGain = gain;

    for (const [freq, type, detune] of [
      [55, "sine", 0],
      [82.4, "triangle", -6],
      [110, "sine", 7],
    ] as [number, OscillatorType, number][]) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = 0.34;
      osc.connect(g).connect(filter);
      osc.start();
      this.droneOscs.push(osc);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    Storage.setMuted(muted);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.08);
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Called once per frame with the live weather struct. */
  update(weather: Float32Array, timeScale = 1): void {
    if (!this.ready || !this.ctx) return;
    const t = this.ctx.currentTime;
    const wind = weather[W.WIND];
    const gust = weather[W.WIND_GUST];
    const rain = weather[W.RAIN];
    const storm = weather[W.STORM];
    const tod = weather[W.TIME_OF_DAY];

    if (this.windGain) {
      const target = 0.0001 + Math.min(0.5, wind * 0.34 + gust * 0.16 + storm * 0.06) * timeScale;
      this.windGain.gain.setTargetAtTime(target, t, 0.35);
    }
    if (this.windFilter) {
      this.windFilter.frequency.setTargetAtTime(260 + wind * 620 + gust * 320, t, 0.4);
    }
    if (this.rainGain) {
      this.rainGain.gain.setTargetAtTime(0.0001 + rain * 0.26 * timeScale, t, 0.5);
    }
    if (this.rainFilter) {
      this.rainFilter.frequency.setTargetAtTime(4200 + rain * 5200, t, 0.6);
    }
    if (this.droneGain) {
      // Night gets a slightly louder, lower drone - the world feels bigger.
      const night = Math.max(0, Math.min(1, 0.5 - weather[W.SUN_ELEVATION] * 1.35));
      this.droneGain.gain.setTargetAtTime((0.035 + night * 0.05 + storm * 0.02) * timeScale, t, 1.2);
    }
    if (this.droneFilter) {
      this.droneFilter.frequency.setTargetAtTime(320 + Math.sin(tod * Math.PI * 2) * 260, t, 1.5);
    }
    for (let i = 0; i < this.droneOscs.length; i++) {
      const base = [55, 82.4, 110][i] ?? 55;
      const night = Math.max(0, Math.min(1, 0.5 - weather[W.SUN_ELEVATION] * 1.35));
      this.droneOscs[i].frequency.setTargetAtTime(base * (1 - night * 0.11), t, 2.0);
    }
  }

  /** One-shot: thunder clap whose distance scales the delay, level and body. */
  thunder(distance01 = 0.4): void {
    if (!this.ready || !this.ctx || !this.brownNoise || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (now - this.lastThunder < 0.18) return;
    this.lastThunder = now;
    const delay = distance01 * 1.6;

    const src = ctx.createBufferSource();
    src.buffer = this.brownNoise;
    src.playbackRate.value = 0.55 + Math.random() * 0.2;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    const peak = 320 - distance01 * 180;
    lp.frequency.setValueAtTime(Math.max(90, peak * 3), now + delay);
    lp.frequency.exponentialRampToValueAtTime(Math.max(60, peak), now + delay + 1.6);
    const g = ctx.createGain();
    const level = 0.85 * (1 - distance01 * 0.65);
    g.gain.setValueAtTime(0.0001, now + delay);
    g.gain.exponentialRampToValueAtTime(level, now + delay + 0.09);
    g.gain.exponentialRampToValueAtTime(0.28 * level, now + delay + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 2.9);
    src.connect(lp).connect(g).connect(this.master);
    src.start(now + delay);
    src.stop(now + delay + 3.1);

    // Sub-body thump
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(70, now + delay);
    osc.frequency.exponentialRampToValueAtTime(28, now + delay + 1.4);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, now + delay);
    og.gain.exponentialRampToValueAtTime(0.5 * level, now + delay + 0.07);
    og.gain.exponentialRampToValueAtTime(0.0001, now + delay + 2.0);
    osc.connect(og).connect(this.master);
    osc.start(now + delay);
    osc.stop(now + delay + 2.1);
  }

  /** Propane burner whoosh - the balloon's voice when the player commits. */
  burner(intensity = 1): void {
    if (!this.ready || !this.ctx || !this.whiteNoise || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.whiteNoise;
    src.playbackRate.value = 0.7 + Math.random() * 0.2;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(500, now);
    bp.frequency.exponentialRampToValueAtTime(1500, now + 0.16);
    bp.frequency.exponentialRampToValueAtTime(420, now + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.16 * intensity, now + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
    src.connect(bp).connect(g).connect(this.master);
    src.start(now);
    src.stop(now + 0.6);
  }

  impact(): void {
    if (!this.ready || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(58, now + 0.34);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.3, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1800;
    osc.connect(lp).connect(g).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.45);

    if (this.whiteNoise) {
      const src = ctx.createBufferSource();
      src.buffer = this.whiteNoise;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.22, now);
      ng.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
      const nf = ctx.createBiquadFilter();
      nf.type = "bandpass";
      nf.frequency.value = 900;
      src.connect(nf).connect(ng).connect(this.master);
      src.start(now);
      src.stop(now + 0.3);
    }
  }

  blip(freq = 660, dur = 0.09, level = 0.12): void {
    if (!this.ready || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, now);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(level, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g).connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  chime(): void {
    this.blip(523.25, 0.5, 0.09);
    window.setTimeout(() => this.blip(659.25, 0.5, 0.08), 90);
    window.setTimeout(() => this.blip(783.99, 0.7, 0.07), 190);
  }

  /** Rope snapping + envelope opening, scored over the launch cinematic. */
  launch(): void {
    this.blip(180, 0.14, 0.16);
    window.setTimeout(() => this.burner(1.4), 130);
    window.setTimeout(() => this.burner(1.1), 620);
    window.setTimeout(() => this.chime(), 1100);
  }

  gameOver(): void {
    this.blip(392, 0.22, 0.12);
    window.setTimeout(() => this.blip(311.13, 0.26, 0.11), 170);
    window.setTimeout(() => this.blip(233.08, 0.6, 0.1), 360);
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === "running") void this.ctx.suspend().catch(() => {});
  }

  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }
}
