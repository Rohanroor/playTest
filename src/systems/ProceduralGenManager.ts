/**
 * ProceduralGenManager - chunk streaming for obstacles and near decor.
 *
 * The world is a stream of fixed-height chunks authored by the WASM core. This
 * manager keeps ~2 chunks of content queued above the top of the screen, fills
 * object pools from each manifest, integrates motion and recycles everything
 * that leaves the bottom. Nothing is allocated after boot.
 *
 * Far scenery (mountains, ridges, stars) is handed to the ParallaxManager,
 * which scrolls those bands at their own slower rate; mid and near decor live
 * in the pool below and scroll with their manifest parallax factor.
 */

import type { SimCore } from "../sim/SimCore";
import { D, DECOR, O, OBSTACLE, W } from "../sim/layout";
import { OBSTACLE_SPRITES, DECOR_SPRITES } from "../art/Sprites";
import { PIXEL_DENSITY, type ParallaxManager } from "./ParallaxManager";
import type { Obstacle } from "../entities/Pools";
import { ObstaclePool } from "../entities/Pools";
import type { Camera } from "../render/Camera";
import type { SpriteBatch } from "../render/SpriteBatch";
import type { Atlas } from "../art/Atlas";

/** How many chunks of content stay queued above the visible screen. */
const LOOKAHEAD_CHUNKS = 2;
/** Parallax factors at or above this stay in the pooled decor stream. */
const NEAR_PARALLAX_CUTOFF = 0.3;

export class ProceduralGenManager {
  readonly obstacles = new ObstaclePool(140);
  private chunkIndex = 0;
  /** Screen-space y of the top edge of the highest queued content. */
  private contentTopY = 0;
  difficulty = 0;
  /** Total chunks streamed since reset - a leak/health signal for the HUD. */
  chunksStreamed = 0;
  droppedSpawns = 0;
  /** Pixels per world unit, so sprite sizes follow the pixel grid. */
  private pixelsPerWorldUnit = 480;
  private chunkHeight = 1;
  private time = 0;

  constructor(
    private sim: SimCore,
    private parallax: ParallaxManager,
    private atlas: Atlas,
  ) {
    this.chunkHeight = sim.chunkHeight;
  }

  setMetrics(pixelsPerWorldUnit: number): void {
    this.pixelsPerWorldUnit = pixelsPerWorldUnit;
  }

  reset(): void {
    this.obstacles.releaseAll();
    this.chunkIndex = 0;
    this.contentTopY = 0;
    this.difficulty = 0;
    this.chunksStreamed = 0;
    this.droppedSpawns = 0;
    this.time = 0;
  }

  /**
   * @param dt           fixed sim delta
   * @param scrollDelta  world units scrolled this step
   * @param altitude     metres, drives the difficulty curve
   */
  update(dt: number, scrollDelta: number, altitude: number, viewH: number): void {
    this.time += dt;
    this.difficulty = Math.min(1, Math.max(0, altitude / 3000));
    this.contentTopY += scrollDelta;

    const limit = -this.chunkHeight * LOOKAHEAD_CHUNKS;
    let guard = 0;
    while (this.contentTopY > limit && guard < 8) {
      guard++;
      const chunkTop = this.contentTopY - this.chunkHeight;
      this.spawnChunk(chunkTop);
      this.contentTopY = chunkTop;
      this.chunksStreamed++;
    }

    this.updateObstacles(dt, scrollDelta, viewH);
    this.updateDecor(dt, scrollDelta, viewH);
  }

  private spawnChunk(chunkTop: number): void {
    this.sim.generateChunk(this.chunkIndex, this.difficulty);
    const obstacles = this.sim.obstacles;
    const os = this.sim.obstacleStride;
    const n = this.sim.obstacleCount;

    for (let i = 0; i < n; i++) {
      const b = i * os;
      const type = obstacles[b + O.TYPE];
      const variant = obstacles[b + O.VARIANT];
      const item = this.obstacles.obtain();
      if (!item) {
        this.droppedSpawns++;
        break;
      }
      const sprites = OBSTACLE_SPRITES[type] ?? OBSTACLE_SPRITES[OBSTACLE.SPIKE_CLUSTER];
      item.type = type;
      item.variant = variant % sprites.length;
      item.sprite = sprites[item.variant];
      item.w = Math.max(0.02, obstacles[b + O.W]);
      item.h = Math.max(0.02, obstacles[b + O.H]);
      item.baseX = obstacles[b + O.X];
      item.x = item.baseX;
      item.y = chunkTop + obstacles[b + O.Y] * this.chunkHeight;
      item.vx = obstacles[b + O.DRIFT];
      item.vy = 0;
      item.speedMul = obstacles[b + O.SPEED];
      item.rot = obstacles[b + O.ROT];
      // Barrels and debris tumble; rocks stay put.
      item.spin =
        type === OBSTACLE.STORM_BARREL || type === OBSTACLE.DEBRIS_PLANK
          ? (this.sim.random() - 0.5) * 1.5
          : type === OBSTACLE.ICE_SHARD
            ? (this.sim.random() - 0.5) * 0.5
            : 0;
      item.swayAmp = obstacles[b + O.SWAY];
      item.swayPhase = obstacles[b + O.PHASE];
      item.swaySpeed = 1.1 + this.sim.random() * 0.9;
      item.value = obstacles[b + O.VALUE];
      // Forgiving hitbox: ~72% of the smaller axis, so near-misses feel fair.
      item.radius = Math.min(item.w, item.h) * 0.36;
      item.hitFlash = 0;
      item.armTime = 0.2;
    }

    // --- decor ---------------------------------------------------------------
    const decor = this.sim.decor;
    const ds = this.sim.decorStride;
    const dn = this.sim.decorCount;
    for (let i = 0; i < dn; i++) {
      const b = i * ds;
      const type = decor[b + D.TYPE];
      const parallaxFactor = decor[b + D.PARALLAX];
      const variant = decor[b + D.VARIANT];
      const scale = decor[b + D.SCALE];
      const tint = decor[b + D.TINT];
      const x = decor[b + D.X];

      if (parallaxFactor < NEAR_PARALLAX_CUTOFF) {
        // Far scenery belongs to a scrolling band, not the chunk stream.
        this.parallax.offer(type, variant, scale, tint, x);
        continue;
      }

      const item = this.parallax.decor.obtain();
      if (!item) {
        this.droppedSpawns++;
        break;
      }
      const sprites = DECOR_SPRITES[type] ?? DECOR_SPRITES[DECOR.CLOUD];
      item.type = type;
      item.variant = variant % sprites.length;
      item.sprite = sprites[item.variant];
      const region = this.atlas.region(item.sprite);
      item.scale = (region.h * PIXEL_DENSITY * Math.max(0.2, scale)) / this.pixelsPerWorldUnit;
      item.x = x;
      item.y = chunkTop + decor[b + D.Y] * this.chunkHeight;
      item.parallax = parallaxFactor;
      item.phase = decor[b + D.PHASE];
      item.tint = tint;
      item.spin = decor[b + D.SPIN];
      item.layer = decor[b + D.LAYER];
      item.flip = this.sim.random() < 0.5;
      item.alpha = 1;
      // Birds drift across the frame with the wind.
      item.vx = type === DECOR.BIRD ? (this.sim.random() - 0.5) * 0.16 + decor[b + D.SPIN] * 0.2 : 0;
      item.anim = this.sim.random() * 6.28;
    }
  }

  private updateObstacles(dt: number, scrollDelta: number, viewH: number): void {
    const wind = this.sim.weather[W.WIND];
    const pool = this.obstacles;
    for (let i = 0; i < pool.items.length; i++) {
      const o: Obstacle = pool.items[i];
      if (!o.active) continue;
      const dy = scrollDelta * o.speedMul;
      o.y += dy;
      o.baseX += o.vx * dt + wind * 0.012 * dt * o.speedMul;
      o.x = o.baseX + Math.sin(this.time * o.swaySpeed + o.swayPhase) * o.swayAmp;
      o.rot += o.spin * dt;
      if (o.hitFlash > 0) o.hitFlash = Math.max(0, o.hitFlash - dt * 3.4);
      if (o.armTime > 0) o.armTime -= dt;
      if (o.y - o.h * 0.5 > viewH + 0.35 || o.x < -0.6 || o.x > 1.6) pool.release(o);
    }
  }

  private updateDecor(dt: number, scrollDelta: number, viewH: number): void {
    const pool = this.parallax.decor;
    const windDir = this.sim.weather[W.WIND_DIR];
    for (let i = 0; i < pool.items.length; i++) {
      const d = pool.items[i];
      if (!d.active) continue;
      d.y += scrollDelta * d.parallax;
      if (d.vx !== 0) {
        d.x += (d.vx + windDir * 0.02 * d.parallax) * dt;
        if (d.x < -0.35) d.x = 1.3;
        else if (d.x > 1.35) d.x = -0.3;
      }
      d.anim += dt;
      const margin = 0.5 + d.scale;
      if (d.y - margin > viewH + 0.2) pool.release(d);
    }
  }

  /** Obstacles are drawn between the mid and foreground decor layers. */
  renderObstacles(batch: SpriteBatch, camera: Camera, flash: number): void {
    const [ox, oy] = camera.offsetFor(1);
    const pool = this.obstacles;
    for (let i = 0; i < pool.items.length; i++) {
      const o = pool.items[i];
      if (!o.active) continue;
      const region = this.atlas.region(o.sprite);
      const aspect = region.w / Math.max(1, region.h);
      const h = o.h;
      const w = o.w;
      // Keep the sprite's own aspect ratio; use the manifest box for the smaller
      // axis so collisions match what the player sees.
      const drawH = aspect >= 1 ? w / aspect : h;
      const drawW = drawH * aspect;
      const hot = o.hitFlash;
      const emissive =
        o.type === OBSTACLE.DRIFT_MINE ? 0.35 + Math.sin(this.time * 4 + o.swayPhase) * 0.22 + flash * 0.6 : flash * 0.4;
      batch.push(
        region,
        o.x - ox,
        o.y - oy,
        Math.max(drawW, w),
        Math.max(drawH, h),
        o.rot,
        1 + hot * 2.2,
        1 + hot * 1.6,
        1 + hot * 1.2,
        1,
        Math.max(0, emissive),
        o.type === OBSTACLE.ICE_SHARD ? 1.5 : 1.15,
        o.type === OBSTACLE.ICE_SHARD || o.type === OBSTACLE.DRIFT_MINE ? 0.85 : 0.4,
        0.04,
        false,
      );
    }
  }

  /** Debug overlay: draw the guaranteed-safe corridor for the live chunks. */
  renderCorridor(batch: SpriteBatch, camera: Camera, alpha: number): void {
    if (alpha <= 0.01) return;
    const region = this.atlas.region("p_soft");
    const half = this.sim.corridorHalfWidth();
    const steps = 16;
    const top = -this.chunkHeight * LOOKAHEAD_CHUNKS;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const y = top + t * this.chunkHeight * LOOKAHEAD_CHUNKS;
      const cx = this.sim.corridorCenter(t * LOOKAHEAD_CHUNKS - Math.floor(t * LOOKAHEAD_CHUNKS));
      batch.pushRect(region, cx - camera.leanX, y - camera.shakeY, half * 2, 0.05, 0.25, 1.0, 0.55, alpha * 0.22, 0.7, 0, 0, 0);
    }
  }

  get liveObstacles(): number {
    return this.obstacles.activeCount;
  }
}
