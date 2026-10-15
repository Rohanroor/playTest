/**
 * ParallaxManager - the depth stack.
 *
 * Extreme depth is the whole visual pitch, so the world is split into bands
 * that scroll at genuinely different rates:
 *
 *   band            parallax   content
 *   starfield       0.02       star clusters, only visible at night
 *   far mountains   0.07       silhouetted ranges, heavily hazed
 *   haze clouds     0.13       soft high cloud banks
 *   forest ridge    0.23       conifer ridgelines
 *   (chunk decor)   0.35-2.2   mid clouds, islets, ruins, canopies, birds,
 *                              foreground clouds - managed by ProceduralGen
 *
 * Far bands use a fixed slot count and recycle off-screen items back above the
 * top edge, so they scroll forever with bounded memory and no seams. Their
 * parameters come from the WASM core (`offer`) whenever a chunk emits far
 * decor, which keeps the generator as the single author of the world.
 */

import { DecorPool, type Decor } from "../entities/Pools";
import type { Camera } from "../render/Camera";
import type { SpriteBatch } from "../render/SpriteBatch";
import type { Atlas } from "../art/Atlas";
import type { SimCore } from "../sim/SimCore";
import { DECOR, W } from "../sim/layout";
import { DECOR_SPRITES } from "../art/Sprites";

interface BandSlot {
  sprite: string;
  x: number;
  y: number;
  scale: number;
  tint: number;
  flip: boolean;
  alpha: number;
}

interface Band {
  name: string;
  parallax: number;
  /** Aerial perspective 0..1 - how much fog the layer sits inside. */
  haze: number;
  normalStrength: number;
  spacing: number;
  margin: number;
  slots: BandSlot[];
  /** Queue of variants offered by the chunk generator. */
  queue: { type: number; variant: number; scale: number; tint: number; x: number }[];
}

const BAND_DEFS: Omit<Band, "slots" | "queue">[] = [
  { name: "stars", parallax: 0.02, haze: 0.05, normalStrength: 0, spacing: 0.55, margin: 0.4 },
  { name: "mountains", parallax: 0.07, haze: 0.82, normalStrength: 0.35, spacing: 0.42, margin: 0.5 },
  { name: "hazeClouds", parallax: 0.13, haze: 0.62, normalStrength: 0.2, spacing: 0.5, margin: 0.5 },
  { name: "ridge", parallax: 0.23, haze: 0.45, normalStrength: 0.55, spacing: 0.46, margin: 0.5 },
];

/** Decor type -> band name. */
const TYPE_TO_BAND: Record<number, string> = {
  [DECOR.STARFIELD]: "stars",
  [DECOR.MOUNTAIN_FAR]: "mountains",
  [DECOR.ROCK_SPIRE]: "mountains",
  [DECOR.RIDGE_FOREST]: "ridge",
};

export class ParallaxManager {
  private bands = new Map<string, Band>();
  /** Live chunk decor (mid + near layers). */
  readonly decor: DecorPool;
  /** Dropped-spawn counter, surfaced on the HUD as a health signal. */
  droppedSpawns = 0;
  /** Internal pixels per world unit (from the Camera); set on resize. */
  pixelsPerWorldUnit = 480;

  constructor(
    private atlas: Atlas,
    private sim: SimCore,
    decorCapacity = 240,
  ) {
    this.decor = new DecorPool(decorCapacity);
    for (const def of BAND_DEFS) {
      const slots: BandSlot[] = [];
      const count = def.name === "stars" ? 4 : def.name === "mountains" ? 6 : 5;
      for (let i = 0; i < count; i++) {
        slots.push({ sprite: "", x: 0, y: 0, scale: 1, tint: 0, flip: false, alpha: 1 });
      }
      this.bands.set(def.name, { ...def, slots, queue: [] });
    }
  }

  reset(viewH: number): void {
    this.decor.releaseAll();
    this.droppedSpawns = 0;
    for (const band of this.bands.values()) {
      band.queue.length = 0;
      band.slots.forEach((slot, i) => {
        this.respawn(band, slot, i, viewH, true);
      });
    }
  }

  /** Accept far-decor descriptors from the chunk generator. */
  offer(type: number, variant: number, scale: number, tint: number, x: number): void {
    const bandName = TYPE_TO_BAND[type];
    if (!bandName) return;
    const band = this.bands.get(bandName);
    if (!band) return;
    if (band.queue.length > 24) band.queue.shift();
    band.queue.push({ type, variant, scale, tint, x });
  }

  private pickSprite(band: Band, type?: number, variant?: number): string {
    let t = DECOR.MOUNTAIN_FAR;
    if (band.name === "stars") t = DECOR.STARFIELD;
    else if (band.name === "mountains") t = type === DECOR.ROCK_SPIRE ? DECOR.ROCK_SPIRE : DECOR.MOUNTAIN_FAR;
    else if (band.name === "hazeClouds") t = DECOR.CLOUD;
    else if (band.name === "ridge") t = DECOR.RIDGE_FOREST;
    const list = DECOR_SPRITES[t] ?? DECOR_SPRITES[DECOR.CLOUD];
    const idx = (variant ?? Math.floor(this.sim.random() * list.length)) % list.length;
    return list[idx];
  }

  private respawn(band: Band, slot: BandSlot, index: number, viewH: number, initial = false): void {
    const offered = band.queue.shift();
    slot.sprite = this.pickSprite(band, offered?.type, offered?.variant);
    const region = this.atlas.region(slot.sprite);
    // Distribute slots evenly with jitter so the band never looks tiled.
    const spread = band.spacing * band.slots.length;
    slot.y = initial
      ? -viewH * 0.2 + (index / band.slots.length) * spread - spread * 0.5 + this.sim.random() * band.spacing * 0.4
      : -band.margin - this.sim.random() * band.spacing * 0.7;
    slot.x = offered ? clamp01(offered.x) : this.sim.random() * 1.3 - 0.15;
    const baseScale = offered ? offered.scale : 0.8 + this.sim.random() * 1.1;
    // Convert atlas pixels into world units at a constant pixel density, so
    // every sprite in the game shares one texel size.
    slot.scale = (region.h * PIXEL_DENSITY * baseScale) / this.pixelsPerWorldUnit;
    slot.tint = offered ? offered.tint : Math.floor(this.sim.random() * 3);
    slot.flip = this.sim.random() < 0.5;
    slot.alpha = 1;
  }

  /** Called by the game on resize so sprite sizing tracks the pixel grid. */
  setMetrics(pixelsPerWorldUnit: number): void {
    this.pixelsPerWorldUnit = pixelsPerWorldUnit;
  }

  /** Move every band and recycle anything that has left the bottom. */
  update(dt: number, scrollDelta: number, viewH: number): void {
    for (const band of this.bands.values()) {
      const dy = scrollDelta * band.parallax;
      for (let i = 0; i < band.slots.length; i++) {
        const slot = band.slots[i];
        slot.y += dy;
        if (slot.y - slot.scale > viewH + band.margin) this.respawn(band, slot, i, viewH);
        else if (slot.y < -4) slot.y += band.spacing * band.slots.length;
      }
    }
    void dt;
  }

  /** Draw one band group. `far` draws stars/mountains/ridge, `near` the rest. */
  renderBands(
    batch: SpriteBatch,
    camera: Camera,
    weather: Float32Array,
    tintR: number,
    tintG: number,
    tintB: number,
  ): void {
    for (const band of this.bands.values()) {
      const starBand = band.name === "stars";
      const alpha = starBand ? weather[W.STAR_ALPHA] : 1;
      if (alpha <= 0.01) continue;
      const [ox, oy] = camera.offsetFor(band.parallax);
      // Far layers take the sky's colour: atmospheric perspective, not just fog.
      const haze = band.haze * weather[W.FOG];
      const mixR = 1 - haze * 0.75;
      const mixG = 1 - haze * 0.72;
      const mixB = 1 - haze * 0.6;
      for (const slot of band.slots) {
        const region = this.atlas.region(slot.sprite);
        const aspect = region.w / Math.max(1, region.h);
        const h = slot.scale;
        const w = h * aspect;
        const dark = starBand ? 1 : 0.55 + 0.45 * (1 - haze);
        batch.push(
          region,
          slot.x - ox,
          slot.y - oy,
          w,
          h,
          0,
          tintR * mixR * dark,
          tintG * mixG * dark,
          tintB * mixB * dark,
          alpha * slot.alpha,
          starBand ? 1 : 0.05,
          band.normalStrength,
          0.05,
          haze,
          slot.flip,
        );
      }
    }
  }

  /** Draw chunk decor for the requested layers (0 = mid .. 3 = foreground). */
  renderDecor(
    batch: SpriteBatch,
    camera: Camera,
    layers: number[],
    weather: Float32Array,
    cloudTint: [number, number, number],
    time: number,
  ): void {
    const fog = weather[W.FOG];
    const cover = weather[W.CLOUD_COVER];
    const night = clamp01(0.5 - weather[W.SUN_ELEVATION] * 1.35);
    this.decor.each((d: Decor) => {
      if (layers.indexOf(d.layer) < 0) return;
      const region = this.atlas.region(d.sprite);
      const [ox, oy] = camera.offsetFor(d.parallax);
      const aspect = region.w / Math.max(1, region.h);
      const h = d.scale;
      const w = h * aspect;
      let alpha = d.alpha;
      let r = 1;
      let g = 1;
      let b = 1;
      let emissive = 0;
      let normalStrength = 0.8;
      let aerial = 0;

      if (d.type === DECOR.CLOUD || d.type === DECOR.FOREGROUND_CLOUD) {
        r = cloudTint[0];
        g = cloudTint[1];
        b = cloudTint[2];
        alpha *= 0.55 + cover * 0.55;
        normalStrength = 0.35;
        aerial = d.type === DECOR.CLOUD ? 0.3 + fog * 0.4 : 0.05;
      } else if (d.type === DECOR.BIRD) {
        const flap = Math.sin(time * 11 + d.phase);
        const frame = flap > 0.45 ? 0 : flap < -0.45 ? 2 : 1;
        d.sprite = DECOR_SPRITES[DECOR.BIRD][frame];
        r = 0.55 + night * -0.25;
        g = 0.56 + night * -0.26;
        b = 0.62 + night * -0.2;
        normalStrength = 0.5;
        aerial = 0.1;
      } else if (d.type === DECOR.STARFIELD) {
        alpha *= weather[W.STAR_ALPHA];
        emissive = 1;
      } else if (d.type === DECOR.RUIN) {
        emissive = 0.25 + night * 0.85;
        aerial = 0.25 + fog * 0.3;
      } else if (d.type === DECOR.FLOAT_ISLET || d.type === DECOR.TREE_CANOPY) {
        aerial = 0.18 + fog * 0.35;
        normalStrength = 1.1;
      }

      if (alpha <= 0.01) return;
      batch.push(
        region,
        d.x - ox,
        d.y - oy,
        w,
        h,
        d.spin * Math.sin(time * 0.6 + d.phase) * 0.06,
        r,
        g,
        b,
        alpha,
        emissive,
        normalStrength,
        0.2,
        aerial,
        d.flip,
      );
    });
  }

  liveDecor(): number {
    return this.decor.activeCount;
  }

  bandQueueDepth(): number {
    let n = 0;
    for (const b of this.bands.values()) n += b.queue.length;
    return n;
  }
}

/**
 * How many internal pixels one atlas pixel should occupy at scale 1. Chosen so
 * the balloon (80 atlas px tall) reads at ~20% of a 300px-tall internal frame.
 */
export const PIXEL_DENSITY = 1.45;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
