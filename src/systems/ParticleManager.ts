/**
 * ParticleManager - draws the WASM particle pool as one instanced batch.
 *
 * The simulation owns position, velocity, lifetime and size (in world units);
 * this system only decides *how* each type reads on screen:
 *
 *   rain         stretched along its velocity, picks up lightning
 *   mist         big soft puffs in the fog colour, depth-parallaxed
 *   wind streak  aligned to the wind vector, only visible when it blows
 *   dust         tiny motes on the play plane
 *   glow mote    additive, cool, night ambience
 *   spark/ember  additive bursts from impacts and the burner
 *
 * `P_SIZE` is the particle's world-space width; the height follows the sprite's
 * own aspect ratio, so every particle shares the atlas' texel density.
 */

import type { Atlas } from "../art/Atlas";
import type { Camera } from "../render/Camera";
import type { SpriteBatch } from "../render/SpriteBatch";
import type { SimCore } from "../sim/SimCore";
import { P, PARTICLE, W } from "../sim/layout";
import { PARTICLE_SPRITES } from "../art/Sprites";

/** Per-type rendering recipe. */
interface Recipe {
  /** Multiplier on the world-space width from the sim. */
  gain: number;
  /** Stretch along velocity (rain, streaks). */
  stretch: number;
  /** >= 1 switches the instance to additive blending. */
  emissive: number;
  /** Colour source. */
  tint: "rain" | "fog" | "streak" | "dust" | "mote" | "spark" | "ember";
  /** Rotation follows the velocity vector. */
  align: "none" | "long" | "wide";
  normal: number;
}

const RECIPES: Record<number, Recipe> = {
  [PARTICLE.RAIN]: { gain: 1.15, stretch: 2.4, emissive: 0.15, tint: "rain", align: "long", normal: 0.25 },
  [PARTICLE.MIST]: { gain: 1.0, stretch: 0, emissive: 0.05, tint: "fog", align: "none", normal: 0.1 },
  [PARTICLE.WIND_STREAK]: { gain: 1.0, stretch: 1.6, emissive: 0.1, tint: "streak", align: "wide", normal: 0.05 },
  [PARTICLE.SPARK]: { gain: 1.5, stretch: 1.1, emissive: 2.6, tint: "spark", align: "none", normal: 0 },
  [PARTICLE.EMBER]: { gain: 1.3, stretch: 0.6, emissive: 2.0, tint: "ember", align: "none", normal: 0 },
  [PARTICLE.DUST]: { gain: 1.0, stretch: 0, emissive: 0.12, tint: "dust", align: "none", normal: 0.1 },
  [PARTICLE.GLOW_MOTE]: { gain: 1.25, stretch: 0, emissive: 1.7, tint: "mote", align: "none", normal: 0 },
};

export class ParticleManager {
  /** Instances submitted last frame - a HUD health signal. */
  drawn = 0;
  /** Particles the sim reports as live. */
  live = 0;

  constructor(
    private atlas: Atlas,
    private sim: SimCore,
  ) {}

  render(batch: SpriteBatch, camera: Camera, weather: Float32Array, time: number): void {
    const count = this.sim.particleCount;
    this.live = count;
    if (count === 0) {
      this.drawn = 0;
      return;
    }
    const buf = this.sim.particles;
    const stride = this.sim.particleStride;
    const flash = weather[W.LIGHTNING];
    const fogR = weather[W.FOG_R];
    const fogG = weather[W.FOG_G];
    const fogB = weather[W.FOG_B];
    const cloudR = weather[W.CLOUD_R];
    const cloudG = weather[W.CLOUD_G];
    const cloudB = weather[W.CLOUD_B];
    const night = Math.max(0, Math.min(1, 0.5 - weather[W.SUN_ELEVATION] * 1.35));

    let drawn = 0;
    for (let i = 0; i < count; i++) {
      const b = i * stride;
      const type = buf[b + P.TYPE];
      const recipe = RECIPES[type];
      if (!recipe) continue;
      const alpha = buf[b + P.ALPHA];
      if (alpha <= 0.012) continue;

      const depth = buf[b + P.DEPTH];
      const [ox, oy] = camera.offsetFor(Math.min(1.6, depth));
      const x = buf[b + P.X] - ox * depth * 0.35;
      const y = buf[b + P.Y] - oy * depth * 0.35;

      // Cull anything outside the frame (the sim recycles with a margin).
      if (y < -0.4 || y > camera.viewH + 0.4 || x < -0.4 || x > camera.viewW + 0.4) continue;

      const spriteName = PARTICLE_SPRITES[type] ?? "p_soft";
      const region = this.atlas.region(spriteName);
      const aspect = region.h / Math.max(1, region.w);
      // P_SIZE is already in world units; the height follows the sprite aspect.
      const w = buf[b + P.SIZE] * recipe.gain;
      let h = w * aspect;

      const vx = buf[b + P.VX];
      const vy = buf[b + P.VY];
      let rot = buf[b + P.ROT];
      if (recipe.stretch > 0) {
        const speed = Math.hypot(vx, vy);
        h *= 1 + Math.min(3.2, speed * recipe.stretch);
        if (recipe.align === "long") rot = Math.atan2(vy, vx) - Math.PI * 0.5;
        else if (recipe.align === "wide") rot = Math.atan2(vy, vx);
      }

      let r = 1;
      let g = 1;
      let bl = 1;
      let emissive = recipe.emissive;
      switch (recipe.tint) {
        case "rain": {
          const lift = 0.45 + flash * 1.5;
          r = cloudR * 0.55 + lift;
          g = cloudG * 0.6 + lift;
          bl = cloudB * 0.7 + lift * 1.15;
          emissive = 0.1 + flash * 1.6;
          break;
        }
        case "fog":
          r = fogR * 1.05;
          g = fogG * 1.05;
          bl = fogB * 1.1;
          break;
        case "streak":
          r = cloudR * 0.7 + 0.35 + flash;
          g = cloudG * 0.7 + 0.38 + flash;
          bl = cloudB * 0.7 + 0.45 + flash * 1.2;
          break;
        case "dust":
          r = 0.85 + flash * 0.6;
          g = 0.78 + flash * 0.6;
          bl = 0.66 + flash * 0.7;
          break;
        case "mote":
          r = 0.55 + night * 0.25;
          g = 0.75 + night * 0.2;
          bl = 1.0;
          break;
        case "spark":
          r = 1.0;
          g = 0.92;
          bl = 0.7;
          break;
        case "ember":
          r = 1.0;
          g = 0.52 + 0.2 * Math.sin(time * 9 + buf[b + P.SEED]);
          bl = 0.22;
          break;
      }

      // Depth fade: near particles read stronger than distant ones.
      const depthFade = 0.55 + Math.min(1, depth) * 0.45;
      batch.push(
        region,
        x,
        y,
        Math.max(0.0015, w),
        Math.max(0.0015, h),
        rot,
        r,
        g,
        bl,
        Math.min(1, alpha * depthFade),
        emissive,
        recipe.normal,
        recipe.tint === "rain" ? 0.9 : 0.1,
        Math.min(0.6, depth * 0.12),
        false,
      );
      drawn++;
    }
    this.drawn = drawn;
  }
}
