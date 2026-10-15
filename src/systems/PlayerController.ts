/**
 * PlayerController - the weather balloon.
 *
 * The balloon is locked to a fixed screen Y ("anchor"); the world scrolls down
 * past it to create the ascent. The player controls only the horizontal axis.
 *
 * Feel targets:
 *   - analogue acceleration with air drag, so it floats rather than snaps
 *   - wind from the weather system pushes it, and gusts shove harder
 *   - the envelope banks/tilts into movement and lags behind with a pendulum
 *     sway (basket swings on a delayed spring)
 *   - invulnerability window + knockback after a hit, with a blinking read
 *   - burner output drives the flame sprite, the ember particles and a point
 *     light, and rises when the player commits to a direction
 */

import type { Camera } from "../render/Camera";
import type { SpriteBatch } from "../render/SpriteBatch";
import type { Atlas } from "../art/Atlas";
import type { SimCore } from "../sim/SimCore";
import { hostRng } from "../core/Random";
import { PARTICLE, W } from "../sim/layout";

export type PlayerPhase = "tethered" | "launching" | "flying" | "falling";

export interface PlayerInput {
  /** -1..1 combined keyboard + pointer intent. */
  axis: number;
  /** Absolute pointer target in [0,1] or null. */
  pointerTarget: number | null;
  pointerActive: boolean;
}

export class PlayerController {
  // --- tunables (world units, seconds) --------------------------------------
  static readonly ANCHOR_Y_FACTOR = 0.62; // slightly below centre
  static readonly MAX_SPEED = 0.62;
  static readonly ACCEL = 2.6;
  static readonly DRAG = 4.4;
  static readonly WIND_COUPLING = 0.55;
  static readonly EDGE_MIN = 0.045;
  static readonly EDGE_MAX = 0.955;
  static readonly HIT_RADIUS = 0.062;
  static readonly INVULN_SECONDS = 1.8;
  readonly maxLives = 3;

  // --- state ----------------------------------------------------------------
  x = 0.5;
  y = 0.5;
  vx = 0;
  vy = 0;
  /** Envelope tilt (radians), banks into the direction of travel. */
  tilt = 0;
  /** Basket pendulum angle, lags the envelope. */
  basketSwing = 0;
  private basketVel = 0;
  lives = 3;
  invuln = 0;
  /** 0..1 burner output; drives flame, embers and the flame point light. */
  burner = 0;
  phase: PlayerPhase = "tethered";
  /** Tether anchor on the ground (title screen). */
  tetherX = 0.42;
  tetherY = 0.86;
  /** Launch cinematic progress 0..1. */
  private launchT = 0;
  private launchFromY = 1.05;
  /** Hit reaction. */
  private hitKick = 0;
  private hitDir = 1;
  /** Blink timer used while invulnerable. */
  private blink = 0;
  private ropeCut = false;
  variant = 0;

  constructor(
    private atlas: Atlas,
    private sim: SimCore,
    private camera: Camera,
  ) {}

  get anchorY(): number {
    return this.camera.viewH * PlayerController.ANCHOR_Y_FACTOR;
  }

  get alive(): boolean {
    return this.lives > 0;
  }

  reset(viewH: number): void {
    this.variant = Math.floor(this.sim.random() * 3);
    this.x = 0.5;
    this.y = viewH * 0.86;
    this.vx = 0;
    this.vy = 0;
    this.tilt = 0;
    this.basketSwing = 0;
    this.basketVel = 0;
    this.lives = this.maxLives;
    this.invuln = 0;
    this.burner = 0;
    this.phase = "tethered";
    this.launchT = 0;
    this.hitKick = 0;
    this.ropeCut = false;
    this.tetherX = 0.3 + this.sim.random() * 0.4;
    this.tetherY = viewH * 0.9;
    this.x = this.tetherX;
    this.y = this.tetherY - 0.06;
  }

  /** Begin the cinematic ascent: untie, then rise to the anchor. */
  startLaunch(): void {
    if (this.phase !== "tethered") return;
    this.phase = "launching";
    this.launchT = 0;
    this.launchFromY = this.y;
    this.ropeCut = true;
    this.sim.emitBurst(this.tetherX, this.tetherY - 0.02, 22, PARTICLE.DUST, 1.2, 0.22, 0.9, 0.006);
    this.sim.emitBurst(this.x, this.y + 0.05, 16, PARTICLE.EMBER, 0.7, 0.2, 0.7, 0.006);
  }

  get ropeIsCut(): boolean {
    return this.ropeCut;
  }

  /** Where the tether rope is anchored (used to draw the rope on the title). */
  get tether(): { x: number; y: number } {
    return { x: this.tetherX, y: this.tetherY };
  }

  update(dt: number, input: PlayerInput, weather: Float32Array, active: boolean): void {
    const windForce = weather[W.WIND_DIR] * weather[W.WIND] * PlayerController.WIND_COUPLING;
    const gust = weather[W.WIND_GUST] * weather[W.WIND_DIR] * 0.25;

    // --- launch cinematic ----------------------------------------------------
    if (this.phase === "launching") {
      this.launchT = Math.min(1, this.launchT + dt / 2.5);
      // Ease-out cubic so the balloon surges then settles onto the anchor.
      const e = 1 - Math.pow(1 - this.launchT, 3);
      this.y = this.launchFromY + (this.anchorY - this.launchFromY) * e;
      this.burner = 0.35 + 0.65 * Math.sin(this.launchT * Math.PI) + (this.launchT < 0.15 ? 0.4 : 0);
      this.vx *= 0.9;
      this.x += this.vx * dt;
      // Slight lateral drift as it slips the tether.
      this.x += Math.sin(this.launchT * 5.2) * 0.02 * dt * (1 - this.launchT);
      if (this.launchT >= 1) {
        this.phase = "flying";
        this.y = this.anchorY;
        this.burner = 0.2;
      }
      this.updateVisuals(dt, 0);
      this.emitBurner(dt);
      return;
    }

    // --- tethered (title screen): idle bob ----------------------------------
    if (this.phase === "tethered") {
      this.burner = Math.max(0, this.burner - dt * 0.8);
      const t = this.camera.scrollY;
      this.y = this.tetherY - 0.06 + Math.sin(t * 1.4) * 0.006 + Math.sin(t * 0.6) * 0.004;
      this.x = this.tetherX + Math.sin(t * 0.9 + 1.1) * 0.008;
      this.tilt = Math.sin(t * 0.8) * 0.035;
      this.basketSwing = Math.sin(t * 0.8 - 0.5) * 0.05;
      return;
    }

    // --- falling (game over) -------------------------------------------------
    if (this.phase === "falling") {
      this.burner = Math.max(0, this.burner - dt * 1.4);
      this.vy += 0.28 * dt;
      this.y += this.vy * dt;
      this.vx *= 0.995;
      this.x += (this.vx + windForce * 0.4) * dt;
      this.tilt += (this.hitDir * 0.5 - this.tilt) * Math.min(1, dt * 2.2);
      this.basketSwing += (this.hitDir * 0.7 - this.basketSwing) * Math.min(1, dt * 3);
      this.x = clamp(this.x, PlayerController.EDGE_MIN, PlayerController.EDGE_MAX);
      return;
    }

    // --- flying --------------------------------------------------------------
    if (!active) {
      this.burner = Math.max(0, this.burner - dt * 2);
      this.updateVisuals(dt, 0);
      return;
    }

    // Combine rate-based keys with the absolute pointer target.
    let intent = input.axis;
    if (input.pointerActive && input.pointerTarget !== null) {
      const delta = input.pointerTarget - this.x;
      intent = clamp(delta * 5.5, -1, 1);
    }

    const accel = intent * PlayerController.ACCEL;
    this.vx += accel * dt;
    // Drag is quadratic-ish so top speed settles naturally.
    this.vx -= this.vx * PlayerController.DRAG * dt * (0.35 + Math.abs(this.vx) * 0.9);
    this.vx += (windForce + gust) * dt;

    // Hit knockback.
    if (this.hitKick > 0) {
      this.vx += this.hitDir * this.hitKick * dt * 6;
      this.hitKick = Math.max(0, this.hitKick - dt * 2.6);
    }

    this.vx = clamp(this.vx, -PlayerController.MAX_SPEED * 1.5, PlayerController.MAX_SPEED * 1.5);
    this.x += this.vx * dt;

    // Soft screen edges: the balloon bumps and slows instead of clipping.
    if (this.x < PlayerController.EDGE_MIN) {
      this.x = PlayerController.EDGE_MIN;
      this.vx = Math.max(0, this.vx) * 0.4;
    } else if (this.x > PlayerController.EDGE_MAX) {
      this.x = PlayerController.EDGE_MAX;
      this.vx = Math.min(0, this.vx) * 0.4;
    }

    // The anchor Y breathes a little with turbulence so the lock never feels
    // like a rail, but the balloon always returns to it.
    const turbulence = weather[W.WIND] * 0.5 + weather[W.STORM] * 0.5;
    const bob = Math.sin(this.camera.scrollY * 2.1) * 0.006 * (0.4 + turbulence);
    const targetY = this.anchorY + bob;
    this.y += (targetY - this.y) * Math.min(1, dt * 3.4);

    // Burner fires with intent (and hard during gusts to hold station).
    const targetBurner = Math.min(1, Math.abs(intent) * 0.55 + Math.abs(this.vx) * 0.5 + turbulence * 0.25);
    this.burner += (targetBurner - this.burner) * Math.min(1, dt * 4.5);

    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
    this.blink += dt;

    this.updateVisuals(dt, intent);
    this.emitBurner(dt);
  }

  private updateVisuals(dt: number, intent: number): void {
    // Bank into the movement, then recover.
    const targetTilt = clamp(-this.vx * 0.55 + intent * -0.06, -0.42, 0.42);
    this.tilt += (targetTilt - this.tilt) * Math.min(1, dt * 5.5);
    // Pendulum basket: spring toward the negative of the envelope's tilt.
    const spring = -this.tilt * 9.5 - this.basketSwing * 5.2;
    this.basketVel += spring * dt;
    this.basketVel *= 1 - Math.min(1, dt * 2.6);
    this.basketSwing += this.basketVel * dt;
    this.basketSwing = clamp(this.basketSwing, -0.5, 0.5);
  }

  private emitBurner(dt: number): void {
    if (this.burner < 0.25) return;
    if (hostRng.chance(dt * (10 + this.burner * 46))) {
      this.sim.emitBurst(
        this.x + hostRng.range(-0.5, 0.5) * 0.012,
        this.y + 0.02,
        1,
        PARTICLE.EMBER,
        0.4,
        0.05 + this.burner * 0.12,
        0.5 + hostRng.next() * 0.6,
        0.004 + hostRng.next() * 0.004,
      );
    }
  }

  /** Register a hit. Returns true if the player was actually damaged. */
  hit(fromX: number): boolean {
    if (this.invuln > 0 || this.phase !== "flying") return false;
    this.lives--;
    this.invuln = PlayerController.INVULN_SECONDS;
    this.hitDir = this.x < fromX ? -1 : 1;
    this.hitKick = 0.5;
    this.vx += this.hitDir * 0.34;
    this.basketVel += this.hitDir * 3.2;
    this.sim.emitBurst(this.x, this.y, 26, PARTICLE.SPARK, 1.4, 0.42, 0.55, 0.006);
    this.sim.emitBurst(this.x, this.y + 0.02, 12, PARTICLE.DUST, 1.0, 0.16, 0.9, 0.008);
    this.camera.addShake(0.022, 0.55);
    if (this.lives <= 0) {
      this.phase = "falling";
      this.vy = 0.05;
    }
    return true;
  }

  /** Visible? (blinks during invulnerability) */
  get visible(): boolean {
    if (this.invuln <= 0) return true;
    return Math.floor(this.blink * 14) % 2 === 0;
  }

  render(batch: SpriteBatch, camera: Camera, weather: Float32Array, time: number): void {
    if (!this.visible && this.phase === "flying") return;
    const [ox, oy] = camera.offsetFor(1);
    const region = this.atlas.region(`balloon_${this.variant}`);
    const density = PIXELS_PER_WORLD(camera);
    const h = (region.h * BALLOON_DENSITY) / density;
    const w = (region.w * BALLOON_DENSITY) / density;
    const x = this.x - ox;
    const y = this.y - oy;

    // Invulnerability reads as a cool shield shimmer.
    const shield = this.invuln > 0 ? 0.35 + 0.3 * Math.sin(time * 22) : 0;
    const hurt = this.phase === "falling" ? 0.5 : 0;
    const lantern = weather[W.LANTERN];

    // Envelope + basket (single authored sprite) banks with the tilt.
    batch.push(
      region,
      x,
      y,
      w,
      h,
      this.tilt * 0.65,
      1 + shield * 0.4 + hurt * 0.6,
      1 - hurt * 0.35 + shield * 0.2,
      1 - hurt * 0.3 + shield * 0.6,
      this.phase === "flying" && this.invuln > 0 ? 0.82 : 1,
      0.12 + lantern * 0.25 + shield * 0.5,
      1.25,
      0.55,
      0,
      false,
    );

    // Burner flame under the envelope.
    if (this.burner > 0.04) {
      const flame = this.atlas.region("flame");
      const fh = (flame.h * BALLOON_DENSITY * (0.5 + this.burner * 0.85)) / density;
      const fw = (flame.w * BALLOON_DENSITY * (0.6 + this.burner * 0.6)) / density;
      const flick = 0.85 + 0.15 * Math.sin(time * 31 + this.basketSwing * 4);
      batch.push(
        flame,
        x + Math.sin(this.tilt) * h * 0.16,
        y + h * 0.2 - fh * 0.22,
        fw * flick,
        fh * flick,
        this.tilt * 0.3,
        1,
        0.86,
        0.62,
        0.55 + this.burner * 0.45,
        1.0,
        0,
        0,
        0,
        false,
      );
    }

    // Warm halo: sells the lantern as a real light source in the frame.
    if (lantern > 0.02 || this.burner > 0.15) {
      const halo = this.atlas.region("halo");
      const strength = Math.max(lantern * 0.85, this.burner * 0.4);
      const size = (0.42 + strength * 0.4) * (1 + Math.sin(time * 3.1) * 0.02);
      batch.push(
        halo,
        x + 0.02,
        y + h * 0.24,
        size,
        size,
        0,
        1.0,
        0.66,
        0.34,
        strength * 0.5,
        1.2,
        0,
        0,
        0,
        false,
      );
    }
  }

  /** The tether rope + ground post, only while tied down. */
  renderTether(batch: SpriteBatch, camera: Camera): void {
    if (this.ropeCut) return;
    const [ox, oy] = camera.offsetFor(1);
    const post = this.atlas.region("post");
    const density = PIXELS_PER_WORLD(camera);
    const ph = (post.h * BALLOON_DENSITY) / density;
    const pw = (post.w * BALLOON_DENSITY) / density;
    batch.push(post, this.tetherX - ox, this.tetherY - oy, pw, ph, 0, 1, 1, 1, 1, 0, 1.1, 0.35, 0, false);

    // Rope as a chain of small quads following a catenary-ish sag.
    const soft = this.atlas.region("p_soft");
    const steps = 12;
    const ax = this.tetherX;
    const ay = this.tetherY - ph * 0.42;
    const bx = this.x;
    const by = this.y + 0.03;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const sag = Math.sin(t * Math.PI) * 0.022;
      const rx = ax + (bx - ax) * t - ox;
      const ry = ay + (by - ay) * t + sag - oy;
      batch.pushRect(soft, rx, ry, 0.004, 0.012, 0.55, 0.42, 0.3, 0.95, 0, 0, 0, 0);
    }
  }
}

/** Balloon texel density: atlas pixels -> internal pixels at scale 1. */
const BALLOON_DENSITY = 1.5;

function PIXELS_PER_WORLD(camera: Camera): number {
  return camera.pixelsPerWorldUnit;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
