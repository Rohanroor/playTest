/**
 * PixelCanvas - a tiny CPU painting surface for authoring pixel art in code.
 *
 * Every sprite in the game is generated at boot from these primitives, which
 * means: no binary assets in the repo, no texture downloads, deterministic
 * output, and each sprite carries a *height field* alongside its colour. That
 * height field is turned into a tangent-space normal map (see NormalMap.ts) so
 * the pixel art reacts to the sun, the lantern and lightning.
 */

export type RGB = [number, number, number];

export function hex(value: number): RGB {
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function shade(c: RGB, amount: number): RGB {
  // amount > 1 lightens toward white, < 1 darkens
  if (amount >= 1) return mix(c, [255, 255, 255], amount - 1);
  return [c[0] * amount, c[1] * amount, c[2] * amount];
}

/** Deterministic 2D hash in [0,1) - keeps generated textures stable per boot. */
export function hash2(x: number, y: number, seed = 1): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695040;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return ((h >>> 0) % 65536) / 65536;
}

export function valueNoise(x: number, y: number, seed = 1): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, octaves = 4, seed = 1): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

export class PixelCanvas {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
  /** Height field in [0,1]; drives normal-map generation. */
  readonly heightMap: Float32Array;
  /** Emissive mask in [0,1]; lantern glass, molten cores, magic runes. */
  readonly glowMap: Float32Array;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.ceil(width));
    this.height = Math.max(1, Math.ceil(height));
    this.rgba = new Uint8ClampedArray(this.width * this.height * 4);
    this.heightMap = new Float32Array(this.width * this.height);
    this.glowMap = new Float32Array(this.width * this.height);
  }

  get index(): number {
    return this.width * this.height;
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Set one pixel. `a` is 0..255, `h` is height 0..1, `g` is emissive 0..1. */
  px(x: number, y: number, c: RGB, a = 255, h = 0.5, g = 0): void {
    if (!this.inside(x, y)) return;
    const i = (y * this.width + x) | 0;
    const o = i * 4;
    const alpha = a / 255;
    if (alpha >= 1) {
      this.rgba[o] = c[0];
      this.rgba[o + 1] = c[1];
      this.rgba[o + 2] = c[2];
      this.rgba[o + 3] = 255;
      this.heightMap[i] = h;
      this.glowMap[i] = g;
      return;
    }
    // Source-over blend so soft edges accumulate correctly.
    const dst = this.rgba[o + 3] / 255;
    const out = alpha + dst * (1 - alpha);
    if (out <= 0) return;
    for (let k = 0; k < 3; k++) {
      this.rgba[o + k] = (c[k] * alpha + this.rgba[o + k] * dst * (1 - alpha)) / out;
    }
    this.rgba[o + 3] = out * 255;
    this.heightMap[i] = h * alpha + this.heightMap[i] * dst * (1 - alpha);
    this.glowMap[i] = Math.max(this.glowMap[i], g * alpha);
  }

  rect(x: number, y: number, w: number, h: number, c: RGB, alpha = 255, height = 0.5, glow = 0): void {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.floor(x + w);
    const y1 = Math.floor(y + h);
    for (let j = y0; j < y1; j++) {
      for (let i = x0; i < x1; i++) this.px(i, j, c, alpha, height, glow);
    }
  }

  /** Axis-aligned rectangle outline. */
  strokeRect(x: number, y: number, w: number, h: number, c: RGB, alpha = 255, height = 0.6): void {
    this.rect(x, y, w, 1, c, alpha, height);
    this.rect(x, y + h - 1, w, 1, c, alpha, height);
    this.rect(x, y, 1, h, c, alpha, height);
    this.rect(x + w - 1, y, 1, h, c, alpha, height);
  }

  circle(cx: number, cy: number, r: number, c: RGB, alpha = 255, height = 0.5, glow = 0): void {
    const x0 = Math.floor(cx - r - 1);
    const x1 = Math.ceil(cx + r + 1);
    const y0 = Math.floor(cy - r - 1);
    const y1 = Math.ceil(cy + r + 1);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const dx = i + 0.5 - cx;
        const dy = j + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r + 0.5) continue;
        const aa = Math.min(1, Math.max(0, r + 0.5 - d));
        this.px(i, j, c, alpha * aa, height, glow);
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, alpha = 255, height = 0.5, glow = 0): void {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const dx = (i + 0.5 - cx) / Math.max(0.001, rx);
        const dy = (j + 0.5 - cy) / Math.max(0.001, ry);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 1.05) continue;
        const aa = Math.min(1, Math.max(0, 1.05 - d));
        this.px(i, j, c, alpha * aa, height, glow);
      }
    }
  }

  /** Fills an ellipse and writes a dome-shaped height field (great normals). */
  dome(cx: number, cy: number, rx: number, ry: number, c: RGB, base = 0.35, peak = 1, glow = 0): void {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const dx = (i + 0.5 - cx) / Math.max(0.001, rx);
        const dy = (j + 0.5 - cy) / Math.max(0.001, ry);
        const d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;
        const h = base + (peak - base) * Math.sqrt(1 - d2);
        const aa = Math.min(1, Math.max(0, 1.02 - Math.sqrt(d2)));
        this.px(i, j, c, 255 * aa, h, glow);
      }
    }
  }

  /** Soft radial falloff - used for glows, mist puffs and the lantern halo. */
  radial(cx: number, cy: number, r: number, c: RGB, peakAlpha = 255, glow = 1, power = 2): void {
    const x0 = Math.floor(cx - r - 1);
    const x1 = Math.ceil(cx + r + 1);
    const y0 = Math.floor(cy - r - 1);
    const y1 = Math.ceil(cy + r + 1);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const dx = i + 0.5 - cx;
        const dy = j + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy) / Math.max(0.001, r);
        if (d >= 1) continue;
        const f = Math.pow(1 - d, power);
        this.px(i, j, c, peakAlpha * f, 0.5, glow * f);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGB, thickness = 1, alpha = 255, height = 0.55): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 2 + 1;
    const half = (thickness - 1) / 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + dx * t;
      const cy = y0 + dy * t;
      for (let j = Math.floor(cy - half); j <= Math.ceil(cy + half); j++) {
        for (let i = Math.floor(cx - half); i <= Math.ceil(cx + half); i++) {
          const ddx = i + 0.5 - cx;
          const ddy = j + 0.5 - cy;
          if (Math.sqrt(ddx * ddx + ddy * ddy) <= half + 0.6) this.px(i, j, c, alpha, height);
        }
      }
    }
  }

  /** Ordered 2x2 bayer dither between two colours - the classic pixel-art ramp. */
  dither(x: number, y: number, w: number, h: number, a: RGB, b: RGB, bias = 0.5, height = 0.5): void {
    const bayer = [0, 2, 3, 1];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const t = bayer[((j & 1) << 1) | (i & 1)] / 4 + 0.125;
        this.px(x + i, y + j, t < bias ? a : b, 255, height);
      }
    }
  }

  /** Adds fbm-based mottling to a region (rock grain, fabric weave, cloud wisps). */
  mottle(
    x: number,
    y: number,
    w: number,
    h: number,
    dark: RGB,
    light: RGB,
    amount = 0.5,
    scale = 0.18,
    seed = 7,
    heightScale = 0.2,
  ): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const gx = x + i;
        const gy = y + j;
        if (!this.inside(gx, gy)) continue;
        const idx = (gy * this.width + gx) | 0;
        if (this.rgba[idx * 4 + 3] < 8) continue; // only touch painted pixels
        const n = fbm(i * scale, j * scale, 4, seed);
        const t = Math.min(1, Math.max(0, 0.5 + (n - 0.5) * 2 * amount));
        const c = mix(dark, light, t);
        const base = this.heightMap[idx];
        this.px(gx, gy, c, 255, base + (n - 0.5) * heightScale, this.glowMap[idx]);
      }
    }
  }

  /** Dark outline around every opaque pixel - gives pixel art its crisp read. */
  outline(c: RGB, alpha = 255, height = 0.3, includeDiagonals = true): void {
    const w = this.width;
    const h = this.height;
    const src = new Uint8ClampedArray(this.rgba);
    const offsets = includeDiagonals
      ? [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ]
      : [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const idx = (j * w + i) * 4;
        if (src[idx + 3] > 24) continue;
        let touched = false;
        for (const [ox, oy] of offsets) {
          const nx = i + ox;
          const ny = j + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (src[(ny * w + nx) * 4 + 3] > 140) {
            touched = true;
            break;
          }
        }
        if (touched) this.px(i, j, c, alpha, height);
      }
    }
  }

  /** Copies another canvas in with optional per-pixel colour remap. */
  blit(src: PixelCanvas, dx: number, dy: number, tint?: (c: RGB, x: number, y: number) => RGB): void {
    for (let j = 0; j < src.height; j++) {
      for (let i = 0; i < src.width; i++) {
        const si = (j * src.width + i) * 4;
        const a = src.rgba[si + 3];
        if (a < 1) continue;
        let c: RGB = [src.rgba[si], src.rgba[si + 1], src.rgba[si + 2]];
        if (tint) c = tint(c, i, j);
        const idx = j * src.width + i;
        this.px(dx + i, dy + j, c, a, src.heightMap[idx], src.glowMap[idx]);
      }
    }
  }

  /** Vertical flip (used to mirror silhouettes for variety). */
  flipX(): void {
    const w = this.width;
    const h = this.height;
    const rgba = new Uint8ClampedArray(this.rgba);
    const ht = new Float32Array(this.heightMap.length);
    const gl = new Float32Array(this.glowMap.length);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const s = (j * w + i) * 4;
        const d = (j * w + (w - 1 - i)) * 4;
        this.rgba[d] = rgba[s];
        this.rgba[d + 1] = rgba[s + 1];
        this.rgba[d + 2] = rgba[s + 2];
        this.rgba[d + 3] = rgba[s + 3];
        this.heightMap[j * w + (w - 1 - i)] = ht[j * w + i];
        this.glowMap[j * w + (w - 1 - i)] = gl[j * w + i];
      }
    }
  }

  /** Upload-ready ImageData. */
  toImageData(): ImageData {
    return new ImageData(new Uint8ClampedArray(this.rgba), this.width, this.height);
  }

  /** Debug helper: raster to a canvas element (nearest neighbour). */
  toCanvas(scale = 1): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.width * scale;
    c.height = this.height * scale;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingEnabled = false;
      const tmp = document.createElement("canvas");
      tmp.width = this.width;
      tmp.height = this.height;
      tmp.getContext("2d")?.putImageData(this.toImageData(), 0, 0);
      ctx.drawImage(tmp, 0, 0, c.width, c.height);
    }
    return c;
  }

  clear(): void {
    this.rgba.fill(0);
    this.heightMap.fill(0);
    this.glowMap.fill(0);
  }
}
