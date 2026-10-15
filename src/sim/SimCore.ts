/**
 * SimCore - host bindings for the WebAssembly simulation core.
 *
 * Responsibilities:
 *   - fetch + instantiate public/wasm/sim.wasm
 *   - call the AssemblyScript initialiser (mandatory before any export)
 *   - assert the memory-layout contract against src/sim/layout.ts
 *   - expose the sim buffers as live Float32Array views (zero copy) and keep
 *     them valid across linear-memory growth
 *
 * The renderer never simulates: it reads state from here. That is what keeps a
 * Bevy/Godot port realistic later - the WASM module is the whole simulation.
 */

import { LAYOUT_VERSION, W } from "./layout";

interface SimExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  _start?: () => void;
  layoutVersion: () => number;
  weatherStride: () => number;
  obstacleStride: () => number;
  decorStride: () => number;
  particleStride: () => number;
  particleCapacity: () => number;
  chunkHeight: () => number;
  weatherPtr: () => number;
  obstaclePtr: () => number;
  decorPtr: () => number;
  particlePtr: () => number;
  simInit: (seed: number) => void;
  simReset: (seed: number) => void;
  simDayLength: (sec: number) => void;
  simDayPhase: (phase: number) => void;
  simTimeOfDay: () => number;
  simElapsed: () => number;
  simForceWeather: (state: number) => void;
  simThunderEvents: () => number;
  simWeatherStep: (dt: number, altitude: number, scroll: number) => void;
  simGenerateChunk: (index: number, difficulty: number, wind: number, cover: number, storm: number) => void;
  simObstacleCount: () => number;
  simDecorCount: () => number;
  simCorridorCenter: (y: number) => number;
  simCorridorHalfWidth: () => number;
  simParticlesStep: (
    dt: number,
    viewW: number,
    viewH: number,
    wind: number,
    windDir: number,
    rain: number,
    fog: number,
    scroll: number,
    leanX: number,
    lightning: number,
    night: number,
  ) => void;
  simParticlesReset: () => void;
  simParticleCount: () => number;
  simEmitBurst: (
    x: number,
    y: number,
    count: number,
    type: number,
    spread: number,
    speed: number,
    life: number,
    size: number,
  ) => void;
  simNoise2: (x: number, y: number, seed: number) => number;
  simFbm2: (x: number, y: number, octaves: number, seed: number) => number;
  simRandom: () => number;
  simFxRandom: () => number;
}

export class SimCore {
  private exports!: SimExports;
  private bufferSize = 0;

  /** Live view over the weather/time-of-day struct. */
  weather!: Float32Array;
  /** Live view over the particle pool (particleCount * stride floats). */
  private particleViewCache!: Float32Array;
  private obstacleViewCache!: Float32Array;
  private decorViewCache!: Float32Array;

  weatherStride = 0;
  obstacleStride = 0;
  decorStride = 0;
  particleStride = 0;
  particleCapacity = 0;
  chunkHeight = 0;

  private constructor() {}

  static async load(url?: string): Promise<SimCore> {
    const core = new SimCore();
    const path = url ?? `${import.meta.env.BASE_URL ?? "./"}wasm/sim.wasm`;

    let bytes: ArrayBuffer;
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${path}`);
      bytes = await res.arrayBuffer();
    } catch (err) {
      throw new Error(
        `Could not load the WebAssembly core from "${path}". ` +
          `Run \`npm run wasm\` first. (${(err as Error).message})`,
      );
    }

    const imports: WebAssembly.Imports = {
      env: {
        abort: () => {
          throw new Error("WASM abort: the simulation core hit an unreachable state.");
        },
        seed: () => Date.now() & 0x7fffffff,
        trace: () => {},
      },
    };

    const { instance } = await WebAssembly.instantiate(bytes, imports);
    core.exports = instance.exports as unknown as SimExports;

    // AssemblyScript modules that use a runtime MUST be initialised first.
    if (typeof core.exports._initialize === "function") core.exports._initialize();
    else if (typeof core.exports._start === "function") core.exports._start();

    const version = core.exports.layoutVersion();
    if (version !== LAYOUT_VERSION) {
      throw new Error(
        `Simulation layout mismatch: binary is version ${version}, host expects ${LAYOUT_VERSION}. Rebuild with \`npm run wasm\`.`,
      );
    }

    core.weatherStride = core.exports.weatherStride();
    core.obstacleStride = core.exports.obstacleStride();
    core.decorStride = core.exports.decorStride();
    core.particleStride = core.exports.particleStride();
    core.particleCapacity = core.exports.particleCapacity();
    core.chunkHeight = core.exports.chunkHeight();

    core.refreshViews(true);
    return core;
  }

  /** (Re)bind typed views onto linear memory. Called when memory grows. */
  private refreshViews(force = false): void {
    const buf = this.exports.memory.buffer;
    if (!force && buf.byteLength === this.bufferSize) return;
    this.bufferSize = buf.byteLength;
    this.weather = new Float32Array(buf, this.exports.weatherPtr(), this.weatherStride);
    this.particleViewCache = new Float32Array(
      buf,
      this.exports.particlePtr(),
      this.particleCapacity * this.particleStride,
    );
    // Manifest views are sized to the module's maxima; counts come from the sim.
    this.obstacleViewCache = new Float32Array(buf, this.exports.obstaclePtr(), 14 * this.obstacleStride);
    this.decorViewCache = new Float32Array(buf, this.exports.decorPtr(), 30 * this.decorStride);
  }

  // --- lifecycle ------------------------------------------------------------
  init(seed: number): void {
    this.exports.simInit(seed >>> 0);
    this.refreshViews();
  }

  reset(seed: number): void {
    this.exports.simReset(seed >>> 0);
    this.refreshViews();
  }

  setDayLength(sec: number): void {
    this.exports.simDayLength(sec);
  }

  setDayPhase(phase: number): void {
    this.exports.simDayPhase(phase);
  }

  forceWeather(state: number): void {
    this.exports.simForceWeather(state);
  }

  // --- stepping -------------------------------------------------------------
  stepWeather(dt: number, altitude: number, scroll: number): void {
    this.exports.simWeatherStep(dt, altitude, scroll);
    this.refreshViews();
  }

  stepParticles(
    dt: number,
    viewW: number,
    viewH: number,
    scrollSpeed: number,
    leanX: number,
  ): void {
    const w = this.weather;
    const night = Math.max(0, Math.min(1, 0.5 - w[W.SUN_ELEVATION] * 1.35));
    this.exports.simParticlesStep(
      dt,
      viewW,
      viewH,
      w[W.WIND],
      w[W.WIND_DIR],
      w[W.RAIN],
      w[W.FOG],
      scrollSpeed,
      leanX,
      w[W.LIGHTNING],
      night,
    );
    this.refreshViews();
  }

  emitBurst(
    x: number,
    y: number,
    count: number,
    type: number,
    spread = 1,
    speed = 0.4,
    life = 0.6,
    size = 0.008,
  ): void {
    this.exports.simEmitBurst(x, y, count, type, spread, speed, life, size);
  }

  resetParticles(): void {
    this.exports.simParticlesReset();
  }

  // --- reads ----------------------------------------------------------------
  get particleCount(): number {
    return this.exports.simParticleCount();
  }

  /** Live view of the first `particleCount` particles (do not retain). */
  get particles(): Float32Array {
    this.refreshViews();
    return this.particleViewCache;
  }

  generateChunk(index: number, difficulty: number): void {
    const w = this.weather;
    this.exports.simGenerateChunk(index, difficulty, w[W.WIND], w[W.CLOUD_COVER], w[W.STORM]);
    this.refreshViews();
  }

  get obstacleCount(): number {
    return this.exports.simObstacleCount();
  }

  get decorCount(): number {
    return this.exports.simDecorCount();
  }

  /** Live view of the last generated chunk's obstacles (do not retain). */
  get obstacles(): Float32Array {
    this.refreshViews();
    return this.obstacleViewCache;
  }

  get decor(): Float32Array {
    this.refreshViews();
    return this.decorViewCache;
  }

  corridorCenter(y: number): number {
    return this.exports.simCorridorCenter(y);
  }

  corridorHalfWidth(): number {
    return this.exports.simCorridorHalfWidth();
  }

  thunderEvents(): number {
    return this.exports.simThunderEvents();
  }

  elapsed(): number {
    return this.exports.simElapsed();
  }

  /**
   * World stream: gameplay randomness. Draining this changes the level, so it
   * is reserved for chunk authoring (spin, sway, variants).
   */
  random(): number {
    return this.exports.simRandom();
  }

  /**
   * FX stream: cosmetic randomness. Safe to drain at any rate - particle churn
   * can never re-author the world, so a seed always replays the same run.
   */
  fxRandom(): number {
    return this.exports.simFxRandom();
  }

  noise2(x: number, y: number, seed = 0): number {
    return this.exports.simNoise2(x, y, seed >>> 0);
  }

  fbm2(x: number, y: number, octaves = 4, seed = 0): number {
    return this.exports.simFbm2(x, y, octaves, seed >>> 0);
  }

  get wasmBytes(): number {
    return this.bufferSize;
  }
}
