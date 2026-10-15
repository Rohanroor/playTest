/**
 * Game - the flow state machine and the frame loop.
 *
 *   title ──(space / tap)──▶ launch ──(balloon reaches its anchor)──▶ play
 *     ▲                          cinematic: UI fades out, rope snaps,          │
 *     │                          balloon rises on an ease-out cubic,          │ 3rd hit
 *     │                          then the parallax starts scrolling           ▼
 *     └──────────(escape)──────── gameover ◀──────────────────────────────────┘
 *                                     └──(R)──▶ relaunch straight into a run
 *
 * The simulation runs at a fixed 60 Hz; rendering is decoupled and interpolates
 * with the accumulator alpha, so the game plays identically at 30 or 240 fps.
 */

import { Atlas } from "../art/Atlas";
import { Font, buildFontAtlas } from "../art/Font";
import { DECOR_SPRITES, buildSprites } from "../art/Sprites";
import { Audio } from "../core/Audio";
import { hostRng, seedHostRng } from "../core/Random";
import { Input } from "../core/Input";
import { Storage } from "../core/Storage";
import { SIM_DT, Time } from "../core/Time";
import { Camera } from "../render/Camera";
import { Pipeline } from "../render/Pipeline";
import { SimCore } from "../sim/SimCore";
import { DECOR, PARTICLE, W } from "../sim/layout";
import type { SpriteBatch } from "../render/SpriteBatch";
import { CollisionSystem } from "../systems/CollisionSystem";
import { ParallaxManager, PIXEL_DENSITY } from "../systems/ParallaxManager";
import { ParticleManager } from "../systems/ParticleManager";
import { PlayerController } from "../systems/PlayerController";
import { ProceduralGenManager } from "../systems/ProceduralGenManager";
import { UIManager } from "../systems/UIManager";
import { METRES_PER_WORLD_UNIT, WeatherTimeManager } from "../systems/WeatherTimeManager";

export type Mode = "title" | "launch" | "play" | "paused" | "gameover";

export interface GameOptions {
  seed?: number;
  hud?: boolean;
  weather?: number;
  onProgress?: (progress: number, message: string) => void;
}

/** World units per second at the start of a run and at maximum difficulty. */
const SCROLL_BASE = 0.17;
const SCROLL_MAX = 0.44;
/** Altitude (metres) at which difficulty saturates. */
const DIFFICULTY_CEILING = 3000;
/** Seconds the wreck falls before the game-over card appears. */
const DEATH_LINGER = 0.9;

export class Game {
  readonly sim: SimCore;
  readonly atlas: Atlas;
  readonly font: Font;
  readonly camera: Camera;
  readonly pipeline: Pipeline;
  readonly weather: WeatherTimeManager;
  readonly parallax: ParallaxManager;
  readonly gen: ProceduralGenManager;
  readonly player: PlayerController;
  readonly collision: CollisionSystem;
  readonly ui: UIManager;
  readonly particles: ParticleManager;
  readonly input = new Input();
  readonly audio = new Audio();
  readonly time = new Time();

  mode: Mode = "title";
  altitude = 0;
  difficulty = 0;
  scrollSpeed = 0;
  private scrollTarget = 0;
  private groundY = 0;
  private seed: number;
  private raf = 0;
  private running = false;
  private needsResize = true;
  private hudEl: HTMLElement | null;
  private hudVisible: boolean;
  private hudTimer = 0;
  private onResize: () => void;
  private onVisibility: () => void;
  private milestone = 0;
  /** Opening weather override (?weather=storm); applied after the pre-roll. */
  private forcedWeather?: number;
  /** Seconds of real time left in the hit slow-motion window. */
  private slowmo = 0;
  private runTime = 0;
  /** Time spent falling with no lives left (see DEATH_LINGER). */
  private deathTimer = 0;

  private constructor(canvas: HTMLCanvasElement, sim: SimCore, atlas: Atlas, font: Font, opts: GameOptions) {
    this.sim = sim;
    this.atlas = atlas;
    this.font = font;
    this.seed = opts.seed ?? (Date.now() & 0x7fffffff);
    this.hudEl = document.getElementById("hud");
    this.hudVisible = Boolean(opts.hud);
    if (this.hudEl && this.hudVisible) this.hudEl.classList.add("on");

    this.camera = new Camera(300);
    this.pipeline = new Pipeline(canvas);
    this.weather = new WeatherTimeManager(sim);
    this.parallax = new ParallaxManager(atlas, sim);
    this.gen = new ProceduralGenManager(sim, this.parallax, atlas);
    this.player = new PlayerController(atlas, sim, this.camera);
    this.collision = new CollisionSystem();
    this.ui = new UIManager(atlas, font, this.camera);
    this.particles = new ParticleManager(atlas, sim);

    this.onResize = () => {
      this.needsResize = true;
    };
    this.onVisibility = () => {
      if (document.hidden) {
        this.audio.suspend();
        if (this.mode === "play") this.setMode("paused");
      } else {
        this.audio.resume();
        this.time.begin(performance.now());
      }
    };
    window.addEventListener("resize", this.onResize);
    window.addEventListener("orientationchange", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.forcedWeather = opts.weather;
  }

  /** Boot: load the core, paint the art, warm the renderer, compose the title. */
  static async create(canvas: HTMLCanvasElement, opts: GameOptions = {}): Promise<Game> {
    const step = opts.onProgress ?? (() => {});
    step(0.08, "Compiling the simulation core…");
    const seed = opts.seed ?? (Date.now() & 0x7fffffff);
    // One seed drives both streams: the core's world/fx generators and the
    // host's cosmetic dice. A seeded run is therefore bit-reproducible.
    seedHostRng(seed);
    const sim = await SimCore.load();
    sim.init(seed);

    step(0.34, "Painting the world…");
    const atlas = new Atlas(1024);
    buildSprites(atlas);
    buildFontAtlas(atlas);
    const data = atlas.bake();

    step(0.62, "Warming the renderer…");
    const game = new Game(canvas, sim, atlas, new Font(atlas.region("font"), data.size, Font.chars), opts);
    game.pipeline.setAtlas(data.color, data.material, data.size);
    game.resize(true);

    step(0.84, "Filling the envelope…");
    game.composeTitle();
    // Pre-roll the atmosphere so the title screen opens on a settled morning.
    for (let i = 0; i < 240; i++) {
      game.weather.update(SIM_DT, 0, 0, game.player.x, game.player.y, 0);
    }
    game.weather.reset();
    // Applied last: reset() returns the atmosphere to the calm morning default,
    // so a forced opening state (?weather=storm) has to be re-asserted here.
    if (typeof game.forcedWeather === "number") game.weather.forceWeather(game.forcedWeather);

    step(1, "Ready");
    return game;
  }

  // --- lifecycle ------------------------------------------------------------
  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.attach(this.pipeline.gl2.canvas);
    this.time.begin(performance.now());
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("orientationchange", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.input.detachAll();
    this.pipeline.dispose();
  }

  toggleHud(force?: boolean): boolean {
    this.hudVisible = force ?? !this.hudVisible;
    this.hudEl?.classList.toggle("on", this.hudVisible);
    if (!this.hudVisible && this.hudEl) this.hudEl.textContent = "";
    return this.hudVisible;
  }

  // --- scene composition ----------------------------------------------------
  private composeTitle(): void {
    this.mode = "title";
    this.altitude = 0;
    this.difficulty = 0;
    this.scrollSpeed = 0;
    this.scrollTarget = 0;
    this.milestone = 0;
    this.camera.reset();
    this.resize(true);
    this.sim.reset(this.seed);
    this.weather.setMorning();
    this.weather.reset();
    this.player.reset(this.camera.viewH);
    this.gen.reset();
    this.parallax.reset(this.camera.viewH);
    this.parallax.setMetrics(this.camera.pixelsPerWorldUnit);
    this.gen.setMetrics(this.camera.pixelsPerWorldUnit);
    this.sim.resetParticles();
    this.collision.reset();
    this.groundY = this.camera.viewH * 0.88;
    this.ui.maxLives = this.player.maxLives;
    this.ui.reset("title", Storage.getHighScore());
    this.ui.alpha = 1;
    this.spawnTitleScenery();
  }

  /** A hand-authored sky for the title screen: calm, readable, alive. */
  private spawnTitleScenery(): void {
    const viewH = this.camera.viewH;
    const ppu = this.camera.pixelsPerWorldUnit;
    const add = (type: number, variant: number, x: number, y: number, scale: number, parallax: number, layer: number, vx = 0) => {
      const item = this.parallax.decor.obtain();
      if (!item) return;
      const sprites = DECOR_SPRITES[type];
      item.type = type;
      item.variant = variant % sprites.length;
      item.sprite = sprites[item.variant];
      const region = this.atlas.region(item.sprite);
      item.scale = (region.h * PIXEL_DENSITY * scale) / ppu;
      item.x = x;
      item.y = y;
      item.parallax = parallax;
      item.phase = this.sim.fxRandom() * 6.283;
      item.tint = variant % 3;
      item.spin = 0;
      item.layer = layer;
      item.flip = this.sim.fxRandom() < 0.5;
      item.alpha = 1;
      item.vx = vx;
      item.anim = this.sim.fxRandom() * 6.28;
    };

    // Mid clouds, low and slow.
    add(DECOR.CLOUD, 0, 0.18, viewH * 0.24, 1.15, 0.42, 1);
    add(DECOR.CLOUD, 2, 0.72, viewH * 0.16, 0.9, 0.46, 1);
    add(DECOR.CLOUD, 1, 0.44, viewH * 0.42, 1.35, 0.4, 1);
    // A distant islet and a ruin for scale and story.
    add(DECOR.FLOAT_ISLET, 0, 0.86, viewH * 0.55, 0.8, 0.6, 1);
    add(DECOR.RUIN, 0, 0.1, viewH * 0.62, 0.75, 0.66, 1);
    // Two bird flocks crossing the frame.
    for (let f = 0; f < 2; f++) {
      const bx = 0.2 + f * 0.45;
      const by = viewH * (0.3 + f * 0.12);
      for (let b = 0; b < 5; b++) {
        add(
          DECOR.BIRD,
          b % 3,
          bx + (this.sim.fxRandom() - 0.5) * 0.16,
          by + (this.sim.fxRandom() - 0.5) * 0.08,
          0.62,
          1.7,
          2,
          (this.sim.fxRandom() - 0.5) * 0.05 + 0.03,
        );
      }
    }
  }

  private startRun(fromTitle: boolean): void {
    this.deathTimer = 0;
    if (fromTitle) {
      this.altitude = 0;
      this.difficulty = 0;
      this.scrollSpeed = 0;
      this.scrollTarget = 0;
      this.milestone = 0;
      this.runTime = 0;
      this.slowmo = 0;
      this.time.reset();
      this.camera.scrollY = 0;
      this.gen.reset();
      this.parallax.decor.releaseAll();
      this.collision.reset();
      this.player.reset(this.camera.viewH);
      this.player.startLaunch();
      this.ui.reset("launch", Storage.getHighScore());
      this.ui.lives = this.player.lives;
      this.audio.launch();
    } else {
      this.player.startLaunch();
    }
    this.setMode("launch");
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.ui.setMode(mode === "paused" ? "paused" : mode);
    if (mode === "gameover") {
      this.ui.score = Math.floor(this.altitude);
      const isBest = Storage.submitScore(Math.floor(this.altitude));
      Storage.submitTime(this.runTime);
      if (isBest) this.ui.onNewBest();
      this.ui.best = Storage.getHighScore();
      this.audio.gameOver();
      this.camera.addShake(0.03, 0.9);
    }
    if (mode === "play") {
      this.ui.lives = this.player.lives;
      this.ui.score = Math.floor(this.altitude);
    }
  }

  // --- frame ----------------------------------------------------------------
  private frame = (ts: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;

    const steps = this.time.tick(ts);
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) this.simulate(SIM_DT);
    const t1 = performance.now();
    this.render();
    this.time.simMs += ((t1 - t0) - this.time.simMs) * 0.1;
    this.time.renderMs += ((performance.now() - t1) - this.time.renderMs) * 0.1;
    this.input.endFrame();
    this.updateHud(t1 - t0);
  };

  private handleInput(): void {
    const start = this.input.justPressed("start");
    const restart = this.input.justPressed("restart");
    const pause = this.input.justPressed("pause");
    const hud = this.input.justPressed("hud");
    const mute = this.input.justPressed("mute");
    const cycle = this.input.justPressed("debugWeather");

    if (hud) this.toggleHud();
    if (mute) this.audio.toggleMute();
    if (cycle) this.weather.cycleWeather();

    if (start || restart) void this.audio.unlock();

    switch (this.mode) {
      case "title":
        if (start || restart) this.startRun(true);
        break;
      case "launch":
        // No skipping: the ascent is the moment the game asks you to look up.
        break;
      case "play":
        if (pause) this.setMode("paused");
        else if (restart) this.startRun(true);
        break;
      case "paused":
        if (pause || start) this.setMode("play");
        else if (restart) this.startRun(true);
        break;
      case "gameover":
        if (restart || start) this.startRun(true);
        else if (pause) this.composeTitle();
        break;
    }
  }

  private simulate(dt: number): void {
    this.handleInput();
    // Paused means paused: no system advances, the last frame stays on screen.
    if (this.mode === "paused") return;

    const playing = this.mode === "play";

    // --- scroll / altitude ---------------------------------------------------
    this.difficulty = Math.min(1, Math.max(0, this.altitude / DIFFICULTY_CEILING));
    if (playing) {
      this.scrollTarget = SCROLL_BASE + this.difficulty * (SCROLL_MAX - SCROLL_BASE);
    } else if (this.mode === "gameover") {
      this.scrollTarget = 0;
    } else {
      this.scrollTarget = 0;
    }
    this.scrollSpeed += (this.scrollTarget - this.scrollSpeed) * Math.min(1, dt * (playing ? 0.55 : 1.6));
    const scrollDelta = this.scrollSpeed * dt;
    this.camera.scrollY += scrollDelta;
    this.altitude += scrollDelta * METRES_PER_WORLD_UNIT;

    // --- systems -------------------------------------------------------------
    this.weather.update(dt, this.altitude, this.camera.scrollY, this.player.x, this.player.y, this.player.burner);

    const thunder = this.weather.takeThunder();
    if (thunder) for (const d of thunder) this.audio.thunder(d);
    if (this.weather.strikeFrame) {
      this.camera.addShake(0.006 + this.weather.flash * 0.008, 0.35);
      this.sim.emitBurst(this.weather.strikeScreenX, -0.05, 10, PARTICLE.SPARK, 1.6, 0.3, 0.5, 0.005);
    }

    // Camera lean follows the balloon and the wind (parallax-correct per band).
    this.camera.setLean((this.player.x - 0.5) * 0.05 + this.weather.windForce * 0.02);
    this.camera.update(dt);

    if (playing || this.mode === "launch" || this.mode === "gameover") {
      this.gen.update(dt, scrollDelta, this.altitude, this.camera.viewH);
      this.parallax.update(dt, scrollDelta, this.camera.viewH);
    } else {
      // Title: static landscape, but the authored scenery still lives.
      this.gen.updateDecorOnly(dt, 0, this.camera.viewH);
    }

    const axis = this.input.enabled ? this.input.keyAxis : 0;
    this.player.update(
      dt,
      {
        axis,
        pointerTarget: this.input.pointerTarget,
        pointerActive: this.input.pointerActive,
      },
      this.sim.weather,
      playing,
    );

    if (playing) {
      const hit = this.collision.update(this.player, this.gen.obstacles);
      if (hit) {
        const damaged = this.player.hit(hit.x);
        if (damaged) {
          this.audio.impact();
          this.ui.lives = this.player.lives;
          this.ui.onLifeLost();
          this.slowmo = 0.32; // brief cinematic slow-mo on taking a hit
        }
      }
      // The run ends whenever the balloon is out of lives, however it got
      // there - not only from a collision this frame. The short linger lets the
      // wreck tumble on screen before the game-over card fades in.
      if (!this.player.alive) {
        this.deathTimer += dt;
        if (this.deathTimer >= DEATH_LINGER) this.setMode("gameover");
      } else if (this.deathTimer !== 0) {
        this.deathTimer = 0;
      }
      // Grazing feedback: a quiet tick when something passes very close.
      if (this.collision.closestApproach < 0.012 && this.collision.closestApproach > -0.5) {
        if (hostRng.chance(dt * 6)) this.audio.blip(1180, 0.05, 0.035);
      }
      this.ui.score = Math.floor(this.altitude);
      const nextMilestone = Math.floor(this.altitude / 500) * 500;
      if (nextMilestone > this.milestone && nextMilestone > 0) {
        this.milestone = nextMilestone;
        this.audio.chime();
      }
    }
    if (this.slowmo > 0) {
      this.slowmo = Math.max(0, this.slowmo - dt);
      this.time.approachScale(this.slowmo > 0 ? 0.32 : 1, dt, 9);
    } else {
      this.time.approachScale(1, dt, 2.4);
    }
    if (playing) this.runTime += dt;

    // Particles live in screen space; hand the sim the current scroll + lean.
    this.sim.stepParticles(dt, this.camera.viewW, this.camera.viewH, this.scrollSpeed, this.camera.leanX);
    this.audio.update(this.sim.weather, this.time.scale);

    // --- flow transitions ----------------------------------------------------
    if (this.mode === "launch" && this.player.phase === "flying") {
      this.setMode("play");
      this.audio.burner(0.7);
    }

    // UI fade: dissolve out for the cinematic, back in for the run.
    const targetAlpha = this.mode === "launch" ? 0 : 1;
    this.ui.alpha += (targetAlpha - this.ui.alpha) * Math.min(1, dt * (this.mode === "launch" ? 4.5 : 2.2));
    this.ui.update(dt);
  }

  // --- render ---------------------------------------------------------------
  private resize(force = false): void {
    const canvas = this.pipeline.gl2.canvas;
    const cssW = canvas.clientWidth || window.innerWidth;
    const cssH = canvas.clientHeight || window.innerHeight;
    const changed = this.camera.resize(cssW, cssH, window.devicePixelRatio);
    if (changed || force) {
      this.pipeline.resize(this.camera);
      this.parallax.setMetrics(this.camera.pixelsPerWorldUnit);
      this.gen.setMetrics(this.camera.pixelsPerWorldUnit);
      this.groundY = this.camera.viewH * 0.88;
    }
    this.needsResize = false;
  }

  private render(): void {
    if (this.needsResize) this.resize();
    const camera = this.camera;
    const pipeline = this.pipeline;
    const weather = this.sim.weather;
    const flash = this.weather.flash;
    const time = this.time.now;

    pipeline.beginScene();
    pipeline.drawSky(this.weather.sky);

    // --- opaque world, back to front ----------------------------------------
    pipeline.beginSprites(camera, this.weather.rig);
    const batch = pipeline.batch;

    const cloudTint: [number, number, number] = [weather[W.CLOUD_R], weather[W.CLOUD_G], weather[W.CLOUD_B]];
    this.parallax.renderBands(batch, camera, weather, 1, 1, 1);
    this.parallax.renderDecor(batch, camera, [0, 1], weather, cloudTint, time);

    if (this.mode === "title" || this.mode === "launch" || (this.mode === "play" && camera.scrollY < 0.6)) {
      this.renderGround(batch, camera, weather);
    }
    if (this.mode === "gameover" && camera.scrollY < 1.2) this.renderGround(batch, camera, weather);

    this.gen.renderObstacles(batch, camera, flash);
    this.player.renderTether(batch, camera);
    this.player.render(batch, camera, weather, time);
    this.renderLightning(batch, camera, time);
    pipeline.drawSprites();

    // --- volumetric fog over the play plane ---------------------------------
    pipeline.drawFog(this.weather.fog);

    // --- near decor, weather particles and UI stay in front of the haze ------
    pipeline.beginSprites(camera, this.weather.rig);
    this.parallax.renderDecor(batch, camera, [2, 3], weather, cloudTint, time);
    this.particles.render(batch, camera, weather, time);
    this.ui.render(batch, this.weather, time);
    pipeline.drawSprites();

    // --- post ----------------------------------------------------------------
    pipeline.bloom(pipeline.hdr ? 0.92 : 0.58, 0.42);
    pipeline.composite(camera, this.weather.composite);
  }

  /** The tethered field: ground band, tufts, post and the traveler. */
  private renderGround(batch: SpriteBatch, camera: Camera, weather: Float32Array): void {
    const region = this.atlas.region("ground");
    const ppu = camera.pixelsPerWorldUnit;
    const tiles = 3;
    const tileW = (camera.viewW * 1.02) / tiles;
    const tileH = (region.h * PIXEL_DENSITY * (tileW / ((region.w * PIXEL_DENSITY) / ppu))) / ppu;
    const y = this.groundY + camera.scrollY;
    if (y > camera.viewH + tileH) return;
    const night = Math.max(0, Math.min(1, 0.5 - weather[W.SUN_ELEVATION] * 1.35));
    const tint = 1 - night * 0.35;
    for (let i = 0; i < tiles; i++) {
      const x = -camera.viewW * 0.01 + tileW * (i + 0.5);
      batch.push(region, x, y + tileH * 0.5, tileW * 1.01, tileH, 0, tint, tint, tint * 1.02, 1, 0, 1.05, 0.3, 0, i % 2 === 1);
    }
    // Grass tufts along the crest.
    const tuft = this.atlas.region("tuft");
    const th = (tuft.h * PIXEL_DENSITY * 1.5) / ppu;
    for (let i = 0; i < 14; i++) {
      const x = (i / 13) * camera.viewW * 1.04 - camera.viewW * 0.02;
      const sway = Math.sin(this.time.now * 1.6 + i) * 0.06 * (0.4 + weather[W.WIND]);
      batch.push(tuft, x, y + th * 0.42, th * (tuft.w / tuft.h), th, sway, tint, tint, tint, 1, 0, 0.9, 0.2, 0, i % 3 === 0);
    }
    // The traveler, standing by the post.
    if (!this.player.ropeIsCut || camera.scrollY < 0.5) {
      const trav = this.atlas.region("traveler");
      const hh = (trav.h * PIXEL_DENSITY * 1.45) / ppu; // traveler drawn a touch larger than native
      const tx = this.player.tether.x + 0.075;
      const ty = y + hh * 0.5 - 0.004;
      batch.push(trav, tx, ty, hh * (trav.w / trav.h), hh, 0, tint, tint, tint, 1, 0.1 + night * 0.3, 1.2, 0.35, 0, false);
      // Their lantern pool of light on the grass.
      if (night > 0.05) {
        const halo = this.atlas.region("halo");
        const s = 0.16 + night * 0.1;
        batch.push(halo, tx + 0.012, ty + 0.006, s, s, 0, 1, 0.68, 0.36, night * 0.32, 1.4, 0, 0, 0, false);
      }
    }
  }

  /** The lightning channel itself: a bolt sprite plus a full-frame wash. */
  private renderLightning(batch: SpriteBatch, camera: Camera, time: number): void {
    const flash = this.weather.flash;
    if (flash < 0.12) return;
    const bolt = this.atlas.region("bolt");
    const h = camera.viewH * (0.7 + flash * 0.5);
    const w = h * (bolt.w / bolt.h);
    const x = this.weather.strikeScreenX + Math.sin(time * 37) * 0.006;
    batch.push(bolt, x, h * 0.42, w, h, 0, 0.85, 0.9, 1.0, Math.min(1, flash * 1.3), 1.6 + flash * 2.2, 0, 0, 0, Math.sin(time * 91) > 0);
    // Sky wash: a huge soft quad so the whole frame blooms on a strike.
    const soft = this.atlas.region("p_soft");
    batch.pushRect(soft, x, camera.viewH * 0.1, camera.viewW * 1.6, camera.viewH * 1.2, 0.6, 0.7, 1.0, Math.min(0.5, flash * 0.7), 1.8, 0, 0, 0);
  }

  private updateHud(simMs: number): void {
    if (!this.hudVisible || !this.hudEl) return;
    this.hudTimer += 1;
    if (this.hudTimer % 6 !== 0) return;
    const w = this.sim.weather;
    this.hudEl.textContent = [
      `fps ${this.time.fps.toFixed(0)}   sim ${simMs.toFixed(2)}ms   render ${this.time.renderMs.toFixed(2)}ms`,
      `mode ${this.mode}   scale x${this.camera.pixelScale}   internal ${this.camera.internalW}x${this.camera.internalH}   hdr ${this.pipeline.hdr}`,
      `alt ${this.altitude.toFixed(0)}m   diff ${this.difficulty.toFixed(2)}   scroll ${this.scrollSpeed.toFixed(3)}u/s   chunks ${this.gen.chunksStreamed}`,
      `weather ${this.weather.stateName} (${(this.weather.stateBlend * 100).toFixed(0)}%)   wind ${w[W.WIND].toFixed(2)}@${w[W.WIND_DIR].toFixed(2)}   rain ${w[W.RAIN].toFixed(2)}   fog ${w[W.FOG].toFixed(2)}`,
      `tod ${w[W.TIME_OF_DAY].toFixed(3)}   sun ${w[W.SUN_ELEVATION].toFixed(2)}   exp ${w[W.EXPOSURE].toFixed(2)}   lantern ${w[W.LANTERN].toFixed(2)}   flash ${this.weather.flash.toFixed(2)}`,
      `obstacles ${this.gen.liveObstacles}/${this.gen.obstacles.capacity}   decor ${this.parallax.liveDecor()}/${this.parallax.decor.capacity}   particles ${this.particles.live}/${this.sim.particleCapacity}`,
      `draws ${this.pipeline.batch.drawCalls}   instances ${this.pipeline.batch.drawnInstances}   dropped ${this.gen.droppedSpawns + this.parallax.droppedSpawns}   wasm ${(this.sim.wasmBytes / 1024).toFixed(0)}kb`,
    ].join("\n");
  }
}
