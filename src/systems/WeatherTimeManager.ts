/**
 * WeatherTimeManager - the atmosphere authority.
 *
 * It owns the WASM weather/time-of-day state and translates it into everything
 * the rest of the game consumes:
 *   - a LightRig for the sprite shader (key light, ambient, up to 4 point lights)
 *   - sky, fog and composite parameters for the post chain
 *   - a gameplay wind vector the player controller pushes against
 *   - thunder scheduling (lightning flash first, clap later, distance-scaled)
 *
 * All parameter blocks are pre-allocated and mutated in place: no per-frame
 * garbage, which matters for a 60 fps WASM/WebGL build.
 */

import type { SimCore } from "../sim/SimCore";
import { W, WEATHER_STATE, WEATHER_STATE_NAME } from "../sim/layout";
import type { CompositeParams, FogParams, LightRig, SkyParams } from "../render/Pipeline";
import { PARTICLE } from "../sim/layout";

/** Full day/night cycle in seconds. Long enough to feel like weather, short
 *  enough that a good run sees dusk and the lantern-lit night. */
export const DAY_LENGTH = 210;
/** Metres of altitude per world unit of scroll (score = altitude). */
export const METRES_PER_WORLD_UNIT = 60;

interface PendingThunder {
  t: number;
  distance: number;
}

export class WeatherTimeManager {
  readonly rig: LightRig = {
    sunDir: new Float32Array(3),
    sunColor: new Float32Array(3),
    ambient: new Float32Array(3),
    fogColor: new Float32Array(3),
    fogDensity: 0,
    specular: 0.5,
    pointPos: new Float32Array(16),
    pointColor: new Float32Array(12),
    pointCount: 0,
  };

  readonly sky: SkyParams = {
    top: new Float32Array(3),
    horizon: new Float32Array(3),
    sunUv: [0.5, 0.3],
    sunColor: new Float32Array(3),
    sunRadius: 0.05,
    sunIntensity: 1,
    starAlpha: 0,
    cloudCover: 0.2,
    cloudColor: new Float32Array(3),
    time: 0,
    wind: 0,
    windDir: 0,
    flash: 0,
  };

  readonly fog: FogParams = {
    color: new Float32Array(3),
    density: 0,
    time: 0,
    scroll: 0,
    wind: 0,
    windDir: 0,
    flash: 0,
    sunColor: new Float32Array(3),
    sunDir: [0, -1],
    heightBias: 0.55,
  };

  readonly composite: CompositeParams = {
    exposure: 1,
    bloomStrength: 0.6,
    gradeLift: new Float32Array(3),
    gradeGain: new Float32Array(3),
    saturation: 1,
    vignette: 0.45,
    time: 0,
    flash: 0,
    grain: 0.03,
    aberration: 0.0006,
  };

  /** Lateral wind push in world units / s^2 applied to the balloon. */
  windForce = 0;
  /** 0..1 - how dark it is; drives the lantern and the star field. */
  nightFactor = 0;
  /** Instantaneous lightning energy 0..1. */
  flash = 0;
  /** True on the exact frame a strike begins (for the audio + shake hook). */
  strikeFrame = false;
  /** Smoothed rain "wetness" - raises specular so the world looks soaked. */
  wetness = 0;

  private pendingThunder: PendingThunder[] = [];
  private lastThunderCount = 0;
  private strikeX = 0.5;
  private time = 0;
  private burnerGlow = 0;

  constructor(private sim: SimCore) {
    this.rig.pointPos.fill(0);
    this.rig.pointColor.fill(0);
  }

  /** Boot into a calm morning for the title screen. */
  setMorning(): void {
    this.sim.setDayLength(DAY_LENGTH);
    this.sim.setDayPhase(0.03);
    this.sim.forceWeather(WEATHER_STATE.CALM);
  }

  setDayLength(sec: number): void {
    this.sim.setDayLength(sec);
  }

  forceWeather(state: number): void {
    this.sim.forceWeather(state);
  }

  cycleWeather(): string {
    const w = this.sim.weather;
    const current = Math.round(w[W.STATE]);
    const next = (current + 1) % 4;
    this.sim.forceWeather(next);
    return WEATHER_STATE_NAME[next];
  }

  get stateIndex(): number {
    return Math.round(this.sim.weather[W.STATE]);
  }

  get stateName(): string {
    return WEATHER_STATE_NAME[this.stateIndex] ?? "Calm";
  }

  get stateBlend(): number {
    return this.sim.weather[W.STATE_BLEND];
  }

  get dayPhase(): number {
    return this.sim.weather[W.TIME_OF_DAY];
  }

  /** HH:MM-ish label derived from the day phase (0.0 = 06:00 dawn). */
  get clockLabel(): string {
    const hours = (this.dayPhase * 24 + 6) % 24;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  /**
   * @param playerX/playerY balloon position for the lantern light
   * @param burner 0..1 how hard the burner is firing (extra warm light)
   */
  update(dt: number, altitude: number, scroll: number, playerX: number, playerY: number, burner: number): void {
    this.time += dt;
    this.sim.stepWeather(dt, altitude, scroll);
    const w = this.sim.weather;

    const sunElev = w[W.SUN_ELEVATION];
    const azimuth = w[W.SUN_AZIMUTH];
    const flash = w[W.LIGHTNING];
    const rain = w[W.RAIN];
    const wind = w[W.WIND];
    const windDir = w[W.WIND_DIR];
    const gust = w[W.WIND_GUST];
    const cover = w[W.CLOUD_COVER];
    const exposure = w[W.EXPOSURE];

    this.nightFactor = clamp01(0.5 - sunElev * 1.35);
    this.flash += (flash - this.flash) * Math.min(1, dt * 26); // slightly smoothed for bloom
    this.wetness += (clamp01(rain * 1.1) - this.wetness) * Math.min(1, dt * 0.6);
    this.burnerGlow += (burner - this.burnerGlow) * Math.min(1, dt * 9);

    // --- thunder bookkeeping -------------------------------------------------
    this.strikeFrame = false;
    const thunderCount = this.sim.thunderEvents();
    if (thunderCount > this.lastThunderCount) {
      const strikes = Math.min(4, Math.round(thunderCount - this.lastThunderCount));
      this.lastThunderCount = thunderCount;
      for (let i = 0; i < strikes; i++) {
        // Distance drives both the delay and how much low end survives.
        const distance = 0.15 + Math.random() * 0.85;
        this.pendingThunder.push({ t: 0.25 + distance * 2.6, distance });
      }
      this.strikeFrame = true;
      this.strikeX = clamp01(0.1 + Math.random() * 0.8);
    }
    // Timers tick here; `takeThunder()` drains the ones that came due.
    for (let i = 0; i < this.pendingThunder.length; i++) this.pendingThunder[i].t -= dt;

    // --- key light (sun by day, moon by night) -------------------------------
    const daySide = azimuth * 0.42;
    const side = sunElev >= 0 ? daySide : -daySide;
    const upness = 0.22 + Math.abs(sunElev) * 0.85;
    let dx = side * 2.1;
    let dy = -upness;
    let dz = 0.62;
    const inv = 1 / Math.hypot(dx, dy, dz);
    dx *= inv;
    dy *= inv;
    dz *= inv;
    const rig = this.rig;
    rig.sunDir[0] = dx;
    rig.sunDir[1] = dy;
    rig.sunDir[2] = dz;

    const sunI = w[W.SUN_INTENSITY];
    rig.sunColor[0] = w[W.SUN_R] * sunI;
    rig.sunColor[1] = w[W.SUN_G] * sunI;
    rig.sunColor[2] = w[W.SUN_B] * sunI;

    rig.ambient[0] = w[W.AMBIENT_R];
    rig.ambient[1] = w[W.AMBIENT_G];
    rig.ambient[2] = w[W.AMBIENT_B];

    rig.fogColor[0] = w[W.FOG_R];
    rig.fogColor[1] = w[W.FOG_G];
    rig.fogColor[2] = w[W.FOG_B];
    rig.fogDensity = w[W.FOG];
    // Rain makes everything wet and shiny; lightning blows out the highlights.
    rig.specular = 0.35 + this.wetness * 1.15 + this.flash * 0.6;

    // --- point lights --------------------------------------------------------
    let n = 0;
    // 0: the balloon's lantern. Warm, close, flickers, only matters in the dark.
    const lantern = w[W.LANTERN];
    if (lantern > 0.01) {
      const flicker = 0.86 + 0.14 * Math.sin(this.time * 11.3) * Math.sin(this.time * 4.7 + 1.3);
      const windFlicker = 1 - Math.min(0.45, wind * 0.3 + gust * 0.18);
      const intensity = lantern * 1.5 * flicker * windFlicker + this.burnerGlow * 0.55;
      this.setPoint(n++, playerX + 0.035, playerY + 0.075, 0.22, intensity, 1.0, 0.62, 0.28);
    }
    // 1: lightning channel - a huge cool light from above the frame.
    if (flash > 0.02) {
      this.setPoint(n++, this.strikeX, -0.18, 1.1, flash * 7.5, 0.78, 0.86, 1.0);
    }
    // 2: burner flame under the envelope.
    if (this.burnerGlow > 0.02) {
      this.setPoint(n++, playerX, playerY - 0.02, 0.3, this.burnerGlow * 1.5, 1.0, 0.55, 0.22);
    }
    rig.pointCount = n;

    // --- sky -----------------------------------------------------------------
    const sky = this.sky;
    sky.top[0] = w[W.SKY_TOP_R];
    sky.top[1] = w[W.SKY_TOP_G];
    sky.top[2] = w[W.SKY_TOP_B];
    sky.horizon[0] = w[W.SKY_HORIZON_R];
    sky.horizon[1] = w[W.SKY_HORIZON_G];
    sky.horizon[2] = w[W.SKY_HORIZON_B];
    sky.cloudColor[0] = w[W.CLOUD_R];
    sky.cloudColor[1] = w[W.CLOUD_G];
    sky.cloudColor[2] = w[W.CLOUD_B];
    sky.sunUv = sunElev >= 0 ? [0.5 + daySide * 0.95, clamp(0.8 - sunElev * 0.68, 0.04, 0.92)] : [0.5 - daySide * 0.95, clamp(0.8 + sunElev * 0.68, 0.04, 0.92)];
    sky.sunRadius = sunElev >= 0 ? 0.052 : 0.036;
    sky.sunIntensity = sunElev >= 0 ? clamp(sunI * 1.25, 0, 3) : clamp(sunI * 2.4, 0, 2.2);
    sky.sunColor[0] = w[W.SUN_R];
    sky.sunColor[1] = w[W.SUN_G];
    sky.sunColor[2] = w[W.SUN_B];
    sky.starAlpha = w[W.STAR_ALPHA];
    sky.cloudCover = cover;
    sky.time = this.time;
    sky.wind = wind;
    sky.windDir = windDir >= 0 ? 1 : -1;
    sky.flash = this.flash;

    // --- fog -----------------------------------------------------------------
    const fog = this.fog;
    fog.color[0] = w[W.FOG_R];
    fog.color[1] = w[W.FOG_G];
    fog.color[2] = w[W.FOG_B];
    fog.density = clamp01(w[W.FOG] * (0.55 + cover * 0.6));
    fog.time = this.time;
    fog.scroll = scroll;
    fog.wind = wind;
    fog.windDir = windDir;
    fog.flash = this.flash;
    fog.sunColor[0] = rig.sunColor[0];
    fog.sunColor[1] = rig.sunColor[1];
    fog.sunColor[2] = rig.sunColor[2];
    fog.sunDir = [dx, dy];
    fog.heightBias = 0.35 + this.nightFactor * 0.3;

    // --- composite / grade ---------------------------------------------------
    const comp = this.composite;
    comp.exposure = clamp(exposure * (1 - rain * 0.07) * (1 + this.flash * 0.25), 0.3, 2.2);
    comp.bloomStrength = 0.5 + this.nightFactor * 0.4 + this.flash * 0.7 + w[W.LANTERN] * 0.12;
    // Lift pulls shadows toward the ambient sky colour (blue night, purple dusk);
    // gain warms or cools the highlights with the key light.
    const ambR = w[W.AMBIENT_R];
    const ambG = w[W.AMBIENT_G];
    const ambB = w[W.AMBIENT_B];
    comp.gradeLift[0] = (ambR - 0.5) * 0.085;
    comp.gradeLift[1] = (ambG - 0.5) * 0.08;
    comp.gradeLift[2] = (ambB - 0.5) * 0.11;
    const sr = w[W.SUN_R];
    const sg = w[W.SUN_G];
    const sb = w[W.SUN_B];
    comp.gradeGain[0] = clamp(1 + (sr - sg) * 0.22, 0.7, 1.35);
    comp.gradeGain[1] = clamp(1 + (sg - (sr + sb) * 0.5) * 0.14, 0.75, 1.25);
    comp.gradeGain[2] = clamp(1 + (sb - sg) * 0.22, 0.7, 1.35);
    comp.saturation = clamp(1.08 - cover * 0.16 - rain * 0.14 - this.nightFactor * 0.16 + this.flash * 0.2, 0.55, 1.25);
    comp.vignette = clamp(0.34 + cover * 0.18 + w[W.STORM] * 0.24 + this.nightFactor * 0.16, 0.2, 0.95);
    comp.time = this.time;
    comp.flash = this.flash;
    comp.grain = 0.022 + this.nightFactor * 0.022 + w[W.STORM] * 0.012;
    comp.aberration = 0.0004 + this.flash * 0.004 + w[W.STORM] * 0.0004;

    // --- gameplay wind -------------------------------------------------------
    // Sustained wind + gusts push the balloon; the player fights it. Scales with
    // altitude (thinner air, but storms hit harder up here).
    this.windForce = windDir * (wind * 0.42 + gust * 0.3) * (0.6 + w[W.STORM] * 0.7);
  }

  /** Drain thunder claps that are due this frame. */
  takeThunder(): number[] | null {
    if (this.pendingThunder.length === 0) return null;
    const due: number[] = [];
    for (let i = this.pendingThunder.length - 1; i >= 0; i--) {
      if (this.pendingThunder[i].t <= 0) {
        due.push(this.pendingThunder[i].distance);
        this.pendingThunder.splice(i, 1);
      }
    }
    return due.length ? due : null;
  }

  /** Lightning channel screen position, for the bolt sprite. */
  get strikeScreenX(): number {
    return this.strikeX;
  }

  /** Ask the sim for a burst of sparks/embers at a world position. */
  emit(type: number, x: number, y: number, count: number, spread: number, speed: number, life: number, size: number): void {
    this.sim.emitBurst(x, y, count, type, spread, speed, life, size);
  }

  reset(): void {
    this.pendingThunder.length = 0;
    this.lastThunderCount = this.sim.thunderEvents();
    this.flash = 0;
    this.time = 0;
    this.windForce = 0;
    this.wetness = 0;
    this.burnerGlow = 0;
  }

  private setPoint(i: number, x: number, y: number, z: number, intensity: number, r: number, g: number, b: number): void {
    const p = this.rig.pointPos;
    const c = this.rig.pointColor;
    p[i * 4] = x;
    p[i * 4 + 1] = y;
    p[i * 4 + 2] = z;
    p[i * 4 + 3] = intensity;
    c[i * 3] = r;
    c[i * 3 + 1] = g;
    c[i * 3 + 2] = b;
  }

  /** Particle type used for the burner embers. */
  static readonly EMBER = PARTICLE.EMBER;
  static readonly SPARK = PARTICLE.SPARK;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
