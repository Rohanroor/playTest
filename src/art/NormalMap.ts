/**
 * NormalMap - turns a sprite's height field into a tangent-space normal map,
 * plus a cheap cavity/AO term that gets baked into the albedo.
 *
 * This is what makes the pixel art read as 2.5D: the balloon envelope gets a
 * real dome, rock islands get crumbling facets, and the lantern's warm point
 * light grazes every ridge as it swings.
 */

import type { PixelCanvas } from "./PixelCanvas";

export interface MaterialMaps {
  /** RGBA: albedo with AO baked in. */
  color: Uint8ClampedArray;
  /** RGBA: encoded tangent-space normal (xyz) + emissive mask (a). */
  normal: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * @param strength 0..4 - how aggressively height gradients bend the normal.
 * @param aoStrength 0..1 - how much cavity darkening is baked into the albedo.
 */
export function buildMaterial(src: PixelCanvas, strength = 1.6, aoStrength = 0.55): MaterialMaps {
  const w = src.width;
  const h = src.height;
  const count = w * h;
  const color = new Uint8ClampedArray(count * 4);
  const normal = new Uint8ClampedArray(count * 4);

  const heightAt = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    const i = cy * w + cx;
    // Transparent pixels should not dent their neighbours.
    return src.rgba[i * 4 + 3] > 24 ? src.heightMap[i] : 0;
  };

  // Pre-compute cavity (how surrounded a pixel is) for the AO bake.
  const ao = new Float32Array(count);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src.rgba[i * 4 + 3] <= 24) {
        ao[i] = 1;
        continue;
      }
      const c = heightAt(x, y);
      let sum = 0;
      for (const [ox, oy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]) {
        sum += Math.max(0, heightAt(x + ox, y + oy) - c);
      }
      ao[i] = 1 - Math.min(1, sum * 0.55);
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const alpha = src.rgba[o + 3];

      // Sobel-ish central differences.
      const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * strength;
      const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;

      normal[o] = (nx * 0.5 + 0.5) * 255;
      normal[o + 1] = (ny * 0.5 + 0.5) * 255;
      normal[o + 2] = (nz * 0.5 + 0.5) * 255;
      normal[o + 3] = src.glowMap[i] * 255;

      const aoFactor = 1 - (1 - ao[i]) * aoStrength;
      color[o] = src.rgba[o] * aoFactor;
      color[o + 1] = src.rgba[o + 1] * aoFactor;
      color[o + 2] = src.rgba[o + 2] * aoFactor;
      color[o + 3] = alpha;
    }
  }

  return { color, normal, width: w, height: h };
}
