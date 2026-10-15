/**
 * Atlas - packs every generated sprite into two GPU textures:
 *
 *   color  : RGBA albedo (AO baked in), NEAREST filtered for crisp pixels
 *   material: RGBA encoded tangent-space normal + emissive mask in alpha
 *
 * Shelf packing with 1px gutters prevents neighbour bleeding when the atlas is
 * sampled with mipmaps off. Regions are addressed by name in UV space, so the
 * renderer can batch hundreds of different sprites in a single draw call.
 */

import { buildMaterial } from "./NormalMap";
import type { PixelCanvas } from "./PixelCanvas";

export interface AtlasRegion {
  name: string;
  /** UV rect (v measured from the top of the atlas). */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Pixel size of the sprite in the atlas. */
  w: number;
  h: number;
  x: number;
  y: number;
  /** Native pixel density: how many atlas pixels = 1 world unit at scale 1. */
  pivotX: number;
  pivotY: number;
}

export interface AtlasData {
  size: number;
  color: Uint8ClampedArray;
  material: Uint8ClampedArray;
}

export class Atlas {
  private size: number;
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private regions = new Map<string, AtlasRegion>();
  private sources: { name: string; src: PixelCanvas; strength: number; ao: number; pivot: [number, number] }[] = [];

  constructor(size = 1024) {
    this.size = size;
  }

  /** Queue a sprite. `pivot` is normalised (0.5, 0.5 = centred). */
  add(
    name: string,
    src: PixelCanvas,
    opts: { strength?: number; ao?: number; pivot?: [number, number] } = {},
  ): void {
    if (this.regions.has(name) || this.sources.some((s) => s.name === name)) {
      throw new Error(`Atlas: duplicate sprite "${name}"`);
    }
    this.sources.push({
      name,
      src,
      strength: opts.strength ?? 1.6,
      ao: opts.ao ?? 0.55,
      pivot: opts.pivot ?? [0.5, 0.5],
    });
  }

  has(name: string): boolean {
    return this.regions.has(name);
  }

  region(name: string): AtlasRegion {
    const r = this.regions.get(name);
    if (!r) throw new Error(`Atlas: unknown sprite "${name}"`);
    return r;
  }

  get names(): string[] {
    return [...this.regions.keys()];
  }

  /** Pack everything and produce the two texture payloads. */
  bake(): AtlasData {
    this.regions.clear();
    this.shelfX = 1;
    this.shelfY = 1;
    this.shelfH = 0;

    // Tallest first keeps shelves tight.
    const ordered = [...this.sources].sort((a, b) => b.src.height - a.src.height);

    let overflow = false;
    for (const item of ordered) {
      const w = item.src.width;
      const h = item.src.height;
      if (this.shelfX + w + 1 > this.size) {
        this.shelfX = 1;
        this.shelfY += this.shelfH + 1;
        this.shelfH = 0;
      }
      if (this.shelfY + h + 1 > this.size) {
        overflow = true;
        break;
      }
      this.regions.set(item.name, {
        name: item.name,
        x: this.shelfX,
        y: this.shelfY,
        w,
        h,
        u0: this.shelfX / this.size,
        v0: this.shelfY / this.size,
        u1: (this.shelfX + w) / this.size,
        v1: (this.shelfY + h) / this.size,
        pivotX: item.pivot[0],
        pivotY: item.pivot[1],
      });
      this.shelfX += w + 1;
      this.shelfH = Math.max(this.shelfH, h);
    }

    if (overflow) {
      if (this.size >= 4096) {
        const missing = ordered.filter((o) => !this.regions.has(o.name)).map((o) => o.name);
        throw new Error(`Atlas overflow at ${this.size}px; could not fit: ${missing.join(", ")}`);
      }
      this.size *= 2;
      return this.bake();
    }

    const color = new Uint8ClampedArray(this.size * this.size * 4);
    const material = new Uint8ClampedArray(this.size * this.size * 4);

    for (const item of ordered) {
      const region = this.regions.get(item.name);
      if (!region) continue;
      const maps = buildMaterial(item.src, item.strength, item.ao);
      for (let y = 0; y < maps.height; y++) {
        const dstRow = ((region.y + y) * this.size + region.x) * 4;
        const srcRow = y * maps.width * 4;
        color.set(maps.color.subarray(srcRow, srcRow + maps.width * 4), dstRow);
        material.set(maps.normal.subarray(srcRow, srcRow + maps.width * 4), dstRow);
      }
    }

    return { size: this.size, color, material };
  }

  /** Total atlas texels actually used - handy for the HUD and CI reporting. */
  usage(data: AtlasData): number {
    let used = 0;
    for (const r of this.regions.values()) used += r.w * r.h;
    return used / (data.size * data.size);
  }
}
