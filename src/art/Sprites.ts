/**
 * Sprites - the entire art set, generated in code at boot.
 *
 * Art direction ("The Replaced Look"): chunky, readable pixel art with a
 * limited, cohesive palette - but every sprite carries a height field so the
 * renderer can normal-map it against a moving sun, a swinging lantern and
 * lightning. Soft shapes (clouds, mist) get low normal strength; hard shapes
 * (rock, metal, ice) get high strength so they catch specular highlights.
 *
 * Nothing here is downloaded: the atlas is deterministic, tiny and CI-friendly.
 */

import { PixelCanvas, fbm, hash2, hex, mix, shade, type RGB } from "./PixelCanvas";
import { Atlas } from "./Atlas";

// --- palette ---------------------------------------------------------------
const C = {
  envelope: [hex(0xd94f3d), hex(0xf0913c), hex(0xf4dfa8), hex(0x2f6f8f), hex(0xe86a5a)],
  envelopeDark: hex(0x7c2b2a),
  rope: hex(0x8a6a44),
  ropeDark: hex(0x55402a),
  basket: [hex(0x9c6b3c), hex(0x7a4f2a), hex(0x55341a), hex(0xc08a52)],
  rock: [hex(0x2b2740), hex(0x423c5c), hex(0x5d5680), hex(0x817aa5)],
  rockDark: hex(0x1b1830),
  metal: [hex(0x6c7787), hex(0x9aa7b8), hex(0xd6e2f0), hex(0x454e5c)],
  wood: [hex(0x5a381d), hex(0x7a4f2a), hex(0x9c6b3c)],
  foliage: [hex(0x14301f), hex(0x1f4a35), hex(0x2f6b45), hex(0x57a05e)],
  cloud: [hex(0xffffff), hex(0xe8eef8), hex(0xc3d0e4), hex(0x93a4c0)],
  ice: [hex(0x9fd8f5), hex(0xcfeeff), hex(0xffffff), hex(0x6ba8cf)],
  glow: hex(0xffc46b),
  glowHot: hex(0xffe6b0),
  ember: hex(0xff7a35),
  traveler: [hex(0x2b3a5c), hex(0x3f5480), hex(0xd9b38c), hex(0x8a3f3f)],
  ui: [hex(0xff4d6d), hex(0xffa3b5), hex(0x4a1424)],
  dirt: [hex(0x4a3626), hex(0x6b4f34), hex(0x8a6a44)],
  grass: [hex(0x2b5c3a), hex(0x3f8a4f), hex(0x66b463)],
  night: hex(0x0d1330),
};

// --- generic helpers -------------------------------------------------------

function scanlineFill(_pc: PixelCanvas, pts: [number, number][], fill: (x: number, y: number) => void): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of pts) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if (y0 === y1) continue;
      if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) {
        xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.floor(xs[i]); x <= Math.ceil(xs[i + 1]); x++) fill(x, y);
    }
  }
}

/** Irregular rocky blob: radius modulated by fbm, shaded with a dome. */
function rockBlob(
  pc: PixelCanvas,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  roughness = 0.28,
  palette: RGB[] = C.rock,
): void {
  const pts: [number, number][] = [];
  const steps = 26;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const n = fbm(Math.cos(a) * 1.6 + 4, Math.sin(a) * 1.6 + 4, 4, seed);
    const r = 1 + (n - 0.5) * 2 * roughness;
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }
  scanlineFill(pc, pts, (x, y) => {
    const dx = (x - cx) / Math.max(1, rx);
    const dy = (y - cy) / Math.max(1, ry);
    const d = Math.sqrt(dx * dx + dy * dy);
    const grain = fbm(x * 0.34, y * 0.34, 3, seed + 11);
    let c = mix(palette[0], palette[1], Math.min(1, grain * 1.2));
    // Light comes from the upper left in texture space; the shader re-lights it.
    if (d < 0.62 && grain > 0.5) c = mix(c, palette[2], 0.55);
    if (d > 0.86) c = mix(c, palette[0], 0.6);
    const h = 0.25 + Math.sqrt(Math.max(0, 1 - d * d)) * 0.72 + (grain - 0.5) * 0.24;
    pc.px(x, y, c, 255, Math.min(1, Math.max(0, h)));
  });
  pc.mottle(0, 0, pc.width, pc.height, shade(palette[0], 0.8), palette[2], 0.35, 0.42, seed, 0.18);
  pc.outline(C.rockDark, 235, 0.18);
}

/** Soft cumulus: overlapping domes + noisy edge, low normal strength. */
function cloudBlob(
  pc: PixelCanvas,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed: number,
  palette: RGB[] = C.cloud,
  alphaScale = 1,
): void {
  const lobes = 7;
  for (let i = 0; i < lobes; i++) {
    const t = i / (lobes - 1);
    const lx = cx + (t - 0.5) * rx * 1.5;
    const ly = cy + Math.sin(t * Math.PI * 1.4 + seed) * ry * 0.18;
    const lr = ry * (0.55 + 0.45 * Math.sin(t * Math.PI)) * (0.85 + hash2(i, seed, 3) * 0.3);
    pc.dome(lx, ly, lr * (rx / ry) * 0.72, lr, palette[1], 0.3, 0.95);
  }
  pc.dome(cx, cy - ry * 0.15, rx * 0.95, ry * 0.85, palette[1], 0.28, 1.0);
  // Bottom shading + wispy erosion.
  for (let y = 0; y < pc.height; y++) {
    for (let x = 0; x < pc.width; x++) {
      const i = (y * pc.width + x) | 0;
      const a = pc.rgba[i * 4 + 3];
      if (a < 4) continue;
      const dx = (x - cx) / Math.max(1, rx);
      const dy = (y - cy) / Math.max(1, ry);
      const d = Math.sqrt(dx * dx * 0.85 + dy * dy);
      const n = fbm(x * 0.13 + seed, y * 0.19 + seed, 4, seed + 5);
      const edge = 1 - Math.min(1, Math.max(0, (d - 0.72) / 0.4));
      const erode = Math.min(1, Math.max(0, edge * (0.55 + n * 0.85)));
      if (erode < 0.08) {
        pc.rgba[i * 4 + 3] = 0;
        continue;
      }
      const lit = Math.min(1, Math.max(0, 1 - d * 0.9 + (n - 0.5) * 0.35));
      const c = mix(palette[2], palette[0], lit);
      pc.rgba[i] = c[0];
      pc.rgba[i * 4 + 1] = c[1];
      pc.rgba[i * 4 + 2] = c[2];
      pc.rgba[i * 4 + 3] = Math.min(255, a * erode * alphaScale);
      pc.heightMap[i] = 0.25 + lit * 0.7;
    }
  }
}

/** Woven wicker basket with a rim, floor shadow and rope anchors. */
function basket(pc: PixelCanvas, cx: number, topY: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const taper = 1 - (y / h) * 0.16;
    const bw = Math.round(w * taper);
    const bx = Math.round(cx - bw / 2);
    for (let x = 0; x < bw; x++) {
      const weave = ((x + y) % 3 === 0 ? 1 : 0) * 0.16 + ((x % 4 < 2 ? 1 : 0) * (y % 4 < 2 ? 1 : 0)) * 0.1;
      let c = mix(C.basket[1], C.basket[0], weave);
      if (y < 2) c = mix(C.basket[3], C.basket[0], 0.4); // rim catches light
      if (y > h - 3) c = mix(c, C.basket[2], 0.55); // floor in shadow
      const edge = x < 1 || x > bw - 2;
      if (edge) c = mix(c, C.basket[2], 0.6);
      const hh = 0.4 + (1 - Math.abs(x - bw / 2) / (bw / 2)) * 0.35 + weave * 0.3 - (y / h) * 0.18;
      pc.px(bx + x, topY + y, c, 255, Math.max(0.05, hh));
    }
  }
}

/** Vertical gore panels for the balloon envelope. */
function envelope(pc: PixelCanvas, cx: number, cy: number, rx: number, ry: number, variant: number): void {
  const gores = 7;
  const cols = [C.envelope[variant % C.envelope.length], C.envelope[(variant + 1) % C.envelope.length], C.envelope[2]];
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      // Gore index by longitude, so panels converge at the poles.
      const lon = Math.atan2(dx, Math.sqrt(Math.max(0.0001, 1 - d2)));
      let g = Math.floor(((lon / Math.PI) * 0.5 + 0.5) * gores);
      g = Math.min(gores - 1, Math.max(0, g));
      const seam = Math.abs(((lon / Math.PI) * 0.5 + 0.5) * gores - g - 0.5) > 0.44;
      let c = cols[g % cols.length];
      if (seam) c = mix(c, C.envelopeDark, 0.65);
      // Latitude bands (the classic horizontal stripe near the equator).
      const band = Math.sin(dy * Math.PI * 2.2);
      if (band > 0.82) c = mix(c, cols[(g + 1) % cols.length], 0.55);
      // Top-light gradient baked in as *height*, not colour, so the shader re-lights.
      const h = Math.sqrt(1 - d2);
      const grain = fbm(x * 0.5, y * 0.5, 2, 21 + variant) - 0.5;
      const aa = Math.min(1, Math.max(0, 1.03 - Math.sqrt(d2)));
      pc.px(x, y, c, 255 * aa, Math.max(0.05, h * 0.9 + grain * 0.1), 0);
    }
  }
  // Skirt + throat at the bottom.
  const skirtY = cy + ry * 0.92;
  pc.rect(cx - rx * 0.3, skirtY, rx * 0.6, 3, mix(C.envelopeDark, C.basket[1], 0.3), 255, 0.35);
  pc.rect(cx - rx * 0.16, skirtY + 2, rx * 0.32, 3, hex(0x2a1a1c), 255, 0.2, 0.15);
}

// --- sprite definitions ----------------------------------------------------

export interface SpriteDefs {
  atlas: Atlas;
}

export function buildSprites(atlas: Atlas): void {
  // === The balloon =========================================================
  for (let v = 0; v < 3; v++) {
    const pc = new PixelCanvas(58, 80);
    const cx = 29;
    const cy = 30;
    envelope(pc, cx, cy, 25, 28, v);
    // Ropes from skirt to basket.
    const basketTop = 62;
    for (const sx of [-8, -3, 3, 8]) {
      pc.line(cx + sx * 1.5, cy + 26, cx + sx * 0.9, basketTop, C.rope, 1, 255, 0.45);
    }
    // Burner frame.
    pc.rect(cx - 5, basketTop - 6, 10, 4, C.metal[1], 255, 0.6);
    pc.rect(cx - 3, basketTop - 9, 6, 4, C.metal[3], 255, 0.62);
    basket(pc, cx, basketTop, 22, 15);
    // Lantern hanging off the basket - emissive, lights the night scenes.
    pc.line(cx + 12, basketTop + 2, cx + 17, basketTop + 6, C.ropeDark, 1, 255, 0.4);
    pc.rect(cx + 15, basketTop + 6, 5, 7, C.metal[3], 255, 0.55);
    pc.rect(cx + 16, basketTop + 7, 3, 5, C.glow, 255, 0.6, 1.0);
    pc.radial(cx + 17, basketTop + 9, 7, C.glow, 90, 1, 2);
    atlas.add(`balloon_${v}`, pc, { strength: 1.5, ao: 0.5, pivot: [0.5, 0.42] });
  }

  // Burner flame (pure emissive; the shader adds it to bloom).
  {
    const pc = new PixelCanvas(16, 26);
    for (let y = 0; y < 26; y++) {
      const t = y / 25;
      const w = Math.round((1 - t) * 6 + 1.5);
      for (let x = -w; x <= w; x++) {
        const d = Math.abs(x) / Math.max(1, w);
        const n = fbm(x * 0.6 + 3, y * 0.4, 3, 9);
        const a = (1 - d) * (0.35 + 0.65 * t) * (0.6 + n * 0.7);
        const c = mix(C.glowHot, C.ember, Math.min(1, d * 0.8 + t * 0.4));
        pc.px(8 + x, 25 - y, c, Math.min(255, a * 255), 0.5, 1);
      }
    }
    atlas.add("flame", pc, { strength: 0.2, ao: 0, pivot: [0.5, 1] });
  }

  // Warm halo used for the lantern and the flame's bounce light.
  {
    const pc = new PixelCanvas(64, 64);
    pc.radial(32, 32, 31, C.glow, 200, 1, 2.4);
    atlas.add("halo", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }

  // === The traveler (title screen) =========================================
  {
    const pc = new PixelCanvas(20, 30);
    // cloak
    const pts: [number, number][] = [
      [10, 6],
      [15, 12],
      [17, 26],
      [12, 28],
      [8, 28],
      [3, 26],
      [5, 12],
    ];
    scanlineFill(pc, pts, (x, y) => {
      const n = fbm(x * 0.4, y * 0.4, 3, 5);
      const c = mix(C.traveler[0], C.traveler[1], n * 0.8 + (10 - Math.abs(x - 10)) * 0.03);
      pc.px(x, y, c, 255, 0.35 + n * 0.4);
    });
    // head + hood
    pc.circle(10, 6, 3.4, C.traveler[2], 255, 0.72);
    pc.circle(10, 5, 3.8, C.traveler[0], 255, 0.6);
    pc.circle(10, 6.4, 2.7, C.traveler[2], 255, 0.78);
    // scarf
    pc.rect(7, 9, 6, 2, C.traveler[3], 255, 0.62);
    pc.rect(12, 10, 2, 5, C.traveler[3], 255, 0.55);
    // arm holding a lantern
    pc.line(14, 15, 17, 20, C.traveler[0], 2, 255, 0.5);
    pc.rect(16, 20, 4, 5, C.metal[3], 255, 0.6);
    pc.rect(17, 21, 2, 3, C.glow, 255, 0.6, 1);
    pc.radial(18, 22, 6, C.glow, 110, 1, 2);
    pc.outline(hex(0x141a30), 230, 0.2);
    atlas.add("traveler", pc, { strength: 1.9, ao: 0.6, pivot: [0.5, 1] });
  }

  // === Obstacles ===========================================================
  // Floating spike cluster: rock base + iron spikes.
  for (let v = 0; v < 3; v++) {
    const pc = new PixelCanvas(38, 38);
    rockBlob(pc, 19, 22, 13, 10, 3 + v * 7, 0.3);
    const spikes = 4 + v;
    for (let s = 0; s < spikes; s++) {
      const a = -Math.PI / 2 + (s / Math.max(1, spikes - 1) - 0.5) * 2.2 + v * 0.3;
      const len = 9 + hash2(s, v, 11) * 7;
      const bx = 19 + Math.cos(a) * 7;
      const by = 20 + Math.sin(a) * 5;
      const tx = bx + Math.cos(a) * len;
      const ty = by + Math.sin(a) * len;
      for (let t = 0; t <= 1.001; t += 0.05) {
        const x = bx + (tx - bx) * t;
        const y = by + (ty - by) * t;
        const w = Math.max(0.6, (1 - t) * 3.1);
        for (let j = Math.floor(y - w); j <= Math.ceil(y + w); j++) {
          for (let i = Math.floor(x - w); i <= Math.ceil(x + w); i++) {
            const d = Math.hypot(i + 0.5 - x, j + 0.5 - y);
            if (d > w) continue;
            const c = mix(C.metal[3], C.metal[2], Math.min(1, t + (1 - d / w) * 0.6));
            pc.px(i, j, c, 255, 0.55 + t * 0.4);
          }
        }
      }
    }
    pc.outline(hex(0x171428), 220, 0.2);
    atlas.add(`spike_${v}`, pc, { strength: 2.6, ao: 0.62, pivot: [0.5, 0.5] });
  }

  // Storm debris: splintered plank with nails.
  for (let v = 0; v < 2; v++) {
    const pc = new PixelCanvas(60, 26);
    const y0 = 8 + v * 2;
    for (let x = 2; x < 58; x++) {
      const jag = Math.round(fbm(x * 0.3, v * 4, 2, 17) * 3);
      const h = 9 - (x > 46 ? Math.round((x - 46) * 0.5) : 0) - (x < 8 ? Math.round((8 - x) * 0.6) : 0);
      for (let y = 0; y < h; y++) {
        const grain = fbm(x * 0.22, (y + y0) * 0.9, 3, 5 + v);
        let c = mix(C.wood[0], C.wood[2], grain);
        if (y === 0) c = mix(c, C.wood[2], 0.6);
        if (y === h - 1) c = mix(c, C.wood[0], 0.7);
        if (Math.abs(x - (18 + v * 14)) < 1 && y > 2) c = C.metal[1]; // nail
        pc.px(x, y0 + y + jag * 0.2, c, 255, 0.35 + grain * 0.4 + (1 - y / h) * 0.3);
      }
    }
    // splinters
    for (let s = 0; s < 6; s++) {
      const x = 4 + hash2(s, v, 3) * 50;
      const y = y0 + hash2(s, v, 9) * 6;
      pc.line(x, y, x + (hash2(s, v, 4) - 0.5) * 10, y + (hash2(s, v, 5) - 0.5) * 8, C.wood[1], 1, 255, 0.6);
    }
    pc.outline(hex(0x241508), 210, 0.2);
    atlas.add(`plank_${v}`, pc, { strength: 2.2, ao: 0.6, pivot: [0.5, 0.5] });
  }

  // Storm barrel: banded cask, hooped iron.
  for (let v = 0; v < 2; v++) {
    const pc = new PixelCanvas(28, 36);
    for (let y = 2; y < 34; y++) {
      const t = (y - 2) / 32;
      const w = Math.round(9 + Math.sin(t * Math.PI) * 3.4);
      for (let x = -w; x <= w; x++) {
        const grain = fbm((x + w) * 0.3, y * 0.18, 3, 8 + v);
        let c = mix(C.wood[0], C.wood[1], grain);
        if ((x + w) % 6 === 0) c = mix(c, C.wood[0], 0.6); // stave seams
        if (y === 6 || y === 7 || y === 28 || y === 29) c = mix(C.metal[0], C.metal[1], grain);
        const dome = Math.sqrt(Math.max(0, 1 - (x / w) ** 2));
        pc.px(14 + x, y, c, 255, 0.25 + dome * 0.7 + grain * 0.12);
      }
    }
    pc.ellipse(14, 3, 9, 3, C.wood[2], 255, 0.8);
    pc.outline(hex(0x1e1206), 225, 0.2);
    atlas.add(`barrel_${v}`, pc, { strength: 2.3, ao: 0.6, pivot: [0.5, 0.5] });
  }

  // Rock island: grass-topped floating shelf with hanging roots.
  for (let v = 0; v < 3; v++) {
    const pc = new PixelCanvas(86, 46);
    rockBlob(pc, 43, 20, 36, 14, 40 + v * 13, 0.22, C.rock);
    // grass cap
    for (let x = 8; x < 78; x++) {
      const top = 12 + Math.round(fbm(x * 0.16, v, 3, 31 + v) * 4);
      if (pc.rgba[(top * pc.width + x) * 4 + 3] < 8) continue;
      const gh = 3 + Math.round(hash2(x, v, 6) * 3);
      for (let y = top - gh; y <= top + 1; y++) {
        const c = mix(C.foliage[1], C.foliage[3], hash2(x, y, 2));
        pc.px(x, y, c, 255, 0.55 + hash2(x, y, 8) * 0.25);
      }
    }
    // hanging roots / underside spikes
    for (let r = 0; r < 7; r++) {
      const x = 18 + hash2(r, v, 12) * 50;
      const len = 6 + hash2(r, v, 14) * 14;
      pc.line(x, 28, x + (hash2(r, v, 16) - 0.5) * 6, 28 + len, mix(C.rock[0], C.dirt[0], 0.4), 2, 255, 0.3);
    }
    pc.outline(C.rockDark, 225, 0.18);
    atlas.add(`island_${v}`, pc, { strength: 2.4, ao: 0.6, pivot: [0.5, 0.4] });
  }

  // Drift mine: spiked sphere with a pulsing core (emissive).
  for (let v = 0; v < 2; v++) {
    const pc = new PixelCanvas(30, 30);
    pc.dome(15, 15, 9, 9, C.metal[0], 0.25, 1);
    for (let y = 6; y < 24; y++) {
      for (let x = 6; x < 24; x++) {
        const d = Math.hypot(x - 15, y - 15);
        if (d > 9) continue;
        const n = fbm(x * 0.4, y * 0.4, 2, 12 + v);
        const c = mix(C.metal[3], C.metal[1], n + (1 - d / 9) * 0.4);
        pc.px(x, y, c, 255, 0.3 + Math.sqrt(Math.max(0, 1 - (d / 9) ** 2)) * 0.7);
      }
    }
    for (let s = 0; s < 8; s++) {
      const a = (s / 8) * Math.PI * 2 + v * 0.3;
      pc.line(15 + Math.cos(a) * 8, 15 + Math.sin(a) * 8, 15 + Math.cos(a) * 13, 15 + Math.sin(a) * 13, C.metal[2], 2, 255, 0.7);
    }
    pc.circle(15, 15, 3.4, C.ember, 255, 0.6, 1);
    pc.radial(15, 15, 8, C.ember, 130, 1, 2);
    pc.outline(hex(0x15131f), 230, 0.2);
    atlas.add(`mine_${v}`, pc, { strength: 2.8, ao: 0.55, pivot: [0.5, 0.5] });
  }

  // Ice shard: faceted crystal, translucent read via pale core.
  for (let v = 0; v < 2; v++) {
    const pc = new PixelCanvas(24, 58);
    const pts: [number, number][] = [
      [12, 2],
      [19, 18],
      [17, 40],
      [12, 56],
      [7, 40],
      [5, 18],
    ];
    scanlineFill(pc, pts, (x, y) => {
      const t = (x - 12) / 8;
      const n = fbm(x * 0.3, y * 0.12, 3, 22 + v);
      const c = mix(C.ice[0], C.ice[2], Math.min(1, 0.5 + t * -0.5 + n * 0.5));
      pc.px(x, y, c, 235, 0.3 + (1 - Math.abs(t)) * 0.65 + n * 0.12, 0.08);
    });
    // facet lines
    pc.line(12, 3, 12, 55, mix(C.ice[2], C.ice[1], 0.4), 1, 190, 0.85);
    pc.line(12, 10, 18, 22, C.ice[1], 1, 150, 0.7);
    pc.line(12, 12, 6, 24, C.ice[1], 1, 150, 0.7);
    pc.outline(hex(0x3f6f92), 200, 0.35);
    atlas.add(`shard_${v}`, pc, { strength: 3.0, ao: 0.4, pivot: [0.5, 0.5] });
  }

  // === Background / parallax decor =========================================
  for (let v = 0; v < 4; v++) {
    const w = 96 + v * 34;
    const h = 52 + v * 12;
    const pc = new PixelCanvas(w, h);
    cloudBlob(pc, w / 2, h / 2 + 4, w * 0.42, h * 0.36, 3 + v * 9);
    atlas.add(`cloud_${v}`, pc, { strength: 0.7, ao: 0.22, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(220, 86);
    cloudBlob(pc, 110, 48, 96, 34, 77, C.cloud, 0.92);
    // foreground clouds read darker + softer so they sell the depth
    for (let i = 0; i < pc.rgba.length; i += 4) {
      if (pc.rgba[i + 3] > 4) {
        pc.rgba[i] *= 0.86;
        pc.rgba[i + 1] *= 0.88;
        pc.rgba[i + 2] *= 0.94;
      }
    }
    atlas.add("cloud_fg", pc, { strength: 0.45, ao: 0.18, pivot: [0.5, 0.5] });
  }

  // Far mountain range (silhouette + snow caps).
  for (let v = 0; v < 3; v++) {
    const pc = new PixelCanvas(180, 108);
    const peaks = 3 + v;
    for (let p = 0; p < peaks; p++) {
      const cx = 20 + (p / peaks) * 150 + hash2(p, v, 3) * 18;
      const hgt = 42 + hash2(p, v, 5) * 46;
      const halfW = 26 + hash2(p, v, 7) * 22;
      const pts: [number, number][] = [
        [cx - halfW, 106],
        [cx - halfW * 0.25, 106 - hgt * 0.72],
        [cx + (hash2(p, v, 9) - 0.5) * 8, 106 - hgt],
        [cx + halfW * 0.3, 106 - hgt * 0.66],
        [cx + halfW, 106],
      ];
      scanlineFill(pc, pts, (x, y) => {
        const t = (106 - y) / hgt;
        const n = fbm(x * 0.06, y * 0.06, 3, 40 + v);
        let c = mix(hex(0x1d2440), hex(0x3a4670), t * 0.8 + n * 0.3);
        c = mix(c, hex(0x2a3358), (x - (cx - halfW)) / (halfW * 2) * 0.25);
        if (t > 0.72 - n * 0.12) c = mix(c, hex(0xe8f0ff), Math.min(1, (t - 0.7) * 3));
        pc.px(x, y, c, 255, 0.15 + t * 0.6 + n * 0.2);
      });
    }
    atlas.add(`mountain_${v}`, pc, { strength: 1.1, ao: 0.3, pivot: [0.5, 1] });
  }

  // Forested ridge (mid-ground).
  for (let v = 0; v < 3; v++) {
    const pc = new PixelCanvas(180, 76);
    for (let x = 0; x < 180; x++) {
      const base = 56 + Math.round(fbm(x * 0.03, v * 3, 3, 60 + v) * 12);
      for (let y = base; y < 76; y++) {
        const n = fbm(x * 0.1, y * 0.1, 2, 61 + v);
        const c = mix(C.foliage[0], C.foliage[1], n);
        pc.px(x, y, c, 255, 0.2 + n * 0.3);
      }
    }
    // conifer silhouettes along the crest
    for (let t = 0; t < 26; t++) {
      const x = 4 + hash2(t, v, 13) * 172;
      const baseY = 56 + Math.round(fbm(x * 0.03, v * 3, 3, 60 + v) * 12);
      const h = 10 + hash2(t, v, 17) * 16;
      for (let y = 0; y < h; y++) {
        const w = Math.max(1, Math.round((1 - y / h) * (h * 0.32)));
        for (let dx = -w; dx <= w; dx++) {
          const n = fbm((x + dx) * 0.2, (baseY - y) * 0.2, 2, 71);
          const c = mix(C.foliage[1], C.foliage[2], n * (1 - y / h));
          pc.px(Math.round(x) + dx, Math.round(baseY - y), c, 255, 0.35 + (1 - y / h) * 0.5);
        }
      }
    }
    atlas.add(`ridge_${v}`, pc, { strength: 1.6, ao: 0.4, pivot: [0.5, 1] });
  }

  // Rock spire (mid-depth landmark).
  for (let v = 0; v < 2; v++) {
    const pc = new PixelCanvas(60, 104);
    const pts: [number, number][] = [
      [10, 102],
      [20, 46],
      [28, 8],
      [34, 4],
      [38, 44],
      [50, 102],
    ];
    scanlineFill(pc, pts, (x, y) => {
      const n = fbm(x * 0.12, y * 0.09, 4, 80 + v);
      const c = mix(C.rock[0], C.rock[2], n * 0.9 + (1 - y / 104) * 0.25);
      pc.px(x, y, c, 255, 0.2 + n * 0.6 + (1 - y / 104) * 0.2);
    });
    pc.outline(C.rockDark, 210, 0.2);
    atlas.add(`spire_${v}`, pc, { strength: 2.2, ao: 0.5, pivot: [0.5, 1] });
  }

  // Floating islet with a lone tree.
  for (let v = 0; v < 2; v++) {
    const pc = new PixelCanvas(88, 60);
    rockBlob(pc, 44, 34, 32, 14, 90 + v * 5, 0.26);
    for (let x = 18; x < 70; x++) {
      const top = 26 + Math.round(fbm(x * 0.2, v, 2, 91) * 3);
      if (pc.rgba[(top * pc.width + x) * 4 + 3] < 8) continue;
      pc.px(x, top, mix(C.foliage[1], C.foliage[2], hash2(x, v, 4)), 255, 0.62);
      pc.px(x, top - 1, mix(C.foliage[2], C.foliage[3], hash2(x, v, 5)), 255, 0.66);
    }
    const tx = 40 + v * 10;
    pc.rect(tx, 12, 3, 15, C.wood[0], 255, 0.55);
    for (let i = 0; i < 5; i++) {
      pc.circle(tx + 1 + (hash2(i, v, 21) - 0.5) * 14, 10 + (hash2(i, v, 22) - 0.5) * 8, 5 + hash2(i, v, 23) * 4, mix(C.foliage[1], C.foliage[3], hash2(i, v, 24)), 255, 0.7);
    }
    pc.outline(C.rockDark, 215, 0.2);
    atlas.add(`islet_${v}`, pc, { strength: 1.9, ao: 0.5, pivot: [0.5, 0.5] });
  }

  // Close canopy (near layer, big and dark).
  for (let v = 0; v < 2; v++) {
    const pc = new PixelCanvas(130, 56);
    for (let i = 0; i < 12; i++) {
      const x = 8 + hash2(i, v, 31) * 114;
      const y = 20 + hash2(i, v, 32) * 22;
      const r = 12 + hash2(i, v, 33) * 16;
      pc.circle(x, y, r, mix(C.foliage[0], C.foliage[1], hash2(i, v, 34)), 255, 0.35 + hash2(i, v, 35) * 0.4);
    }
    pc.mottle(0, 0, pc.width, pc.height, C.foliage[0], C.foliage[2], 0.5, 0.2, 33 + v, 0.3);
    pc.outline(hex(0x0b1a12), 200, 0.2);
    atlas.add(`canopy_${v}`, pc, { strength: 1.7, ao: 0.5, pivot: [0.5, 0.5] });
  }

  // Ruin: a broken tower whose windows glow at night.
  {
    const pc = new PixelCanvas(52, 82);
    for (let y = 8; y < 82; y++) {
      const taper = 1 - (82 - y) / 260;
      const w = Math.round(20 * taper);
      for (let x = -w; x <= w; x++) {
        const brick = (y % 6 < 1 || (x + (y % 12 < 6 ? 0 : 3)) % 8 === 0) ? 0.35 : 0;
        const n = fbm(x * 0.25, y * 0.25, 3, 44);
        const c = mix(hex(0x4a4458), hex(0x6f6880), n * 0.8 + brick);
        const dome = Math.sqrt(Math.max(0, 1 - (x / w) ** 2));
        pc.px(26 + x, y, c, 255, 0.2 + dome * 0.6 + n * 0.2);
      }
    }
    // broken top - ragged erosion of the tower crest
    for (let x = 0; x < pc.width; x++) {
      const cut = 10 + Math.round(fbm(x * 0.22, 3, 2, 45) * 11);
      for (let y = 0; y < cut; y++) {
        const i = y * pc.width + x;
        pc.rgba[i * 4 + 3] = 0;
        pc.heightMap[i] = 0;
      }
    }
    // windows (emissive at night)
    for (const [wx, wy] of [
      [22, 30],
      [30, 44],
      [20, 58],
      [32, 68],
    ]) {
      pc.rect(wx, wy, 5, 8, hex(0x1a1428), 255, 0.15);
      pc.rect(wx + 1, wy + 1, 3, 6, C.glow, 255, 0.4, 1);
    }
    pc.outline(hex(0x221f33), 220, 0.2);
    atlas.add("ruin", pc, { strength: 2.1, ao: 0.55, pivot: [0.5, 1] });
  }

  // Birds: three wing frames.
  for (let f = 0; f < 3; f++) {
    const pc = new PixelCanvas(16, 12);
    const lift = [3, 0, -3][f];
    const body = hex(0x1b1f2e);
    pc.line(8, 6, 3, 6 + lift, body, 2, 255, 0.6);
    pc.line(8, 6, 13, 6 + lift, body, 2, 255, 0.6);
    pc.ellipse(8, 6, 2.4, 1.6, body, 255, 0.65);
    pc.px(10, 5, hex(0xf0c060), 255, 0.7);
    atlas.add(`bird_${f}`, pc, { strength: 1.2, ao: 0.3, pivot: [0.5, 0.5] });
  }

  // Star cluster (emissive points on a transparent field).
  {
    const pc = new PixelCanvas(72, 72);
    for (let i = 0; i < 26; i++) {
      const x = 3 + hash2(i, 1, 51) * 66;
      const y = 3 + hash2(i, 2, 52) * 66;
      const b = 0.4 + hash2(i, 3, 53) * 0.6;
      const c = mix(hex(0xbcd2ff), hex(0xfff2d0), hash2(i, 4, 54));
      pc.px(Math.round(x), Math.round(y), c, 255 * b, 0.5, 1);
      if (b > 0.82) {
        pc.px(Math.round(x) - 1, Math.round(y), c, 90 * b, 0.5, 0.8);
        pc.px(Math.round(x) + 1, Math.round(y), c, 90 * b, 0.5, 0.8);
        pc.px(Math.round(x), Math.round(y) - 1, c, 90 * b, 0.5, 0.8);
        pc.px(Math.round(x), Math.round(y) + 1, c, 90 * b, 0.5, 0.8);
      }
    }
    atlas.add("stars", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }

  // === Title-screen landscape ==============================================
  {
    const pc = new PixelCanvas(180, 60);
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 180; x++) {
        const n = fbm(x * 0.06, y * 0.12, 4, 12);
        const t = y / 60;
        let c: RGB = mix(C.grass[0], C.grass[1], n * 1.1);
        if (t > 0.35) c = mix(C.dirt[0], C.dirt[1], n);
        if (t > 0.72) c = mix(C.dirt[1], C.dirt[2], n * 0.7);
        const h = 0.75 - t * 0.5 + n * 0.22;
        pc.px(x, y, c, 255, Math.max(0.05, h));
      }
    }
    // grass blades along the crest
    for (let x = 0; x < 180; x += 1) {
      const h = 2 + Math.round(hash2(x, 7, 5) * 4);
      for (let y = 0; y < h; y++) {
        pc.px(x, y, mix(C.grass[1], C.grass[2], hash2(x, y, 6)), 255, 0.8 - y * 0.08);
      }
    }
    // pebbles
    for (let i = 0; i < 14; i++) {
      const x = 6 + hash2(i, 8, 9) * 168;
      const y = 26 + hash2(i, 9, 10) * 30;
      pc.circle(x, y, 1 + hash2(i, 10, 11) * 2, mix(C.rock[1], C.dirt[2], 0.5), 255, 0.8);
    }
    atlas.add("ground", pc, { strength: 2.0, ao: 0.55, pivot: [0.5, 0] });
  }
  {
    const pc = new PixelCanvas(20, 16);
    for (let i = 0; i < 5; i++) {
      const x = 3 + hash2(i, 1, 61) * 14;
      const h = 5 + hash2(i, 2, 62) * 9;
      pc.line(x, 15, x + (hash2(i, 3, 63) - 0.5) * 5, 15 - h, mix(C.grass[1], C.grass[2], hash2(i, 4, 64)), 2, 255, 0.7);
    }
    atlas.add("tuft", pc, { strength: 1.4, ao: 0.4, pivot: [0.5, 1] });
  }
  {
    const pc = new PixelCanvas(16, 28);
    pc.rect(5, 4, 6, 22, C.wood[1], 255, 0.6);
    pc.rect(5, 4, 2, 22, C.wood[2], 255, 0.72);
    pc.rect(3, 2, 10, 4, C.wood[0], 255, 0.66);
    pc.circle(8, 9, 2.6, C.metal[1], 255, 0.8);
    pc.circle(8, 9, 1.2, C.wood[0], 255, 0.5);
    pc.outline(hex(0x23160a), 220, 0.2);
    atlas.add("post", pc, { strength: 2.2, ao: 0.55, pivot: [0.5, 1] });
  }

  // === Sky bodies + lightning ==============================================
  {
    const pc = new PixelCanvas(48, 48);
    pc.radial(24, 24, 23, hex(0xfff3d0), 255, 1, 2.2);
    pc.circle(24, 24, 11, hex(0xfffbec), 255, 0.5, 1);
    atlas.add("sun", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(40, 40);
    pc.circle(20, 20, 13, hex(0xf2f5ff), 255, 0.7, 0.35);
    for (const [cx, cy, r] of [
      [15, 16, 3.4],
      [24, 22, 2.6],
      [20, 27, 2.1],
      [26, 14, 1.7],
    ]) {
      pc.circle(cx, cy, r, mix(hex(0xc9d2e8), hex(0xf2f5ff), 0.3), 255, 0.62, 0.3);
    }
    pc.radial(20, 20, 19, hex(0xa8c8ff), 70, 0.6, 2.6);
    atlas.add("moon", pc, { strength: 0.6, ao: 0.2, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(34, 132);
    let x = 17;
    let y = 2;
    while (y < 128) {
      const ny = y + 6 + Math.round(hash2(y, 1, 71) * 10);
      const nx = x + (hash2(y, 2, 72) - 0.5) * 14;
      pc.line(x, y, nx, ny, hex(0xf4f8ff), 3, 255, 0.5);
      pc.line(x, y, nx, ny, hex(0xbcd6ff), 5, 120, 0.5);
      if (hash2(y, 3, 73) > 0.66) {
        pc.line(nx, ny, nx + (hash2(y, 4, 74) - 0.5) * 22, ny + 12 + hash2(y, 5, 75) * 12, hex(0xdfeaff), 2, 200, 0.5);
      }
      x = nx;
      y = ny;
    }
    pc.radial(17, 40, 20, hex(0xcfe2ff), 60, 1, 2);
    atlas.add("bolt", pc, { strength: 0, ao: 0, pivot: [0.5, 0] });
  }

  // === Particles ===========================================================
  {
    const pc = new PixelCanvas(4, 16);
    for (let y = 0; y < 16; y++) {
      const t = y / 15;
      const a = Math.sin(t * Math.PI) * 255;
      pc.px(1, y, hex(0xdfefff), a, 0.5);
      pc.px(2, y, hex(0xffffff), a * 0.85, 0.5);
    }
    atlas.add("p_rain", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(44, 44);
    pc.radial(22, 22, 21, hex(0xe6eefc), 190, 0, 2.6);
    atlas.add("p_mist", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(26, 4);
    for (let x = 0; x < 26; x++) {
      const t = x / 25;
      const a = Math.sin(t * Math.PI) * 230;
      pc.px(x, 1, hex(0xeaf2ff), a, 0.5);
      pc.px(x, 2, hex(0xcfe0f5), a * 0.6, 0.5);
    }
    atlas.add("p_streak", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(6, 6);
    pc.radial(3, 3, 2.6, hex(0xfff0c0), 255, 1, 2);
    atlas.add("p_spark", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(6, 6);
    pc.radial(3, 3, 2.6, C.ember, 255, 1, 2.2);
    atlas.add("p_ember", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(3, 3);
    pc.px(1, 1, hex(0xf2ead8), 255, 0.5);
    pc.px(0, 1, hex(0xd8cbae), 130, 0.5);
    pc.px(2, 1, hex(0xd8cbae), 130, 0.5);
    pc.px(1, 0, hex(0xd8cbae), 130, 0.5);
    pc.px(1, 2, hex(0xd8cbae), 130, 0.5);
    atlas.add("p_dust", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(8, 8);
    pc.radial(4, 4, 3.6, hex(0xbfe0ff), 235, 1, 2.4);
    atlas.add("p_mote", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }
  {
    const pc = new PixelCanvas(16, 16);
    pc.radial(8, 8, 7.5, hex(0xffffff), 255, 0.4, 3);
    atlas.add("p_soft", pc, { strength: 0, ao: 0, pivot: [0.5, 0.5] });
  }

  // === UI ==================================================================
  for (const [name, filled] of [
    ["heart_full", true],
    ["heart_empty", false],
  ] as [string, boolean][]) {
    const pc = new PixelCanvas(14, 13);
    const pts: [number, number][] = [
      [7, 12],
      [1, 6],
      [1, 3],
      [3, 1],
      [5, 1],
      [7, 3],
      [9, 1],
      [11, 1],
      [13, 3],
      [13, 6],
    ];
    scanlineFill(pc, pts, (x, y) => {
      if (!filled) {
        pc.px(x, y, C.ui[2], 255, 0.3);
        return;
      }
      const t = 1 - y / 12;
      const c = mix(C.ui[0], C.ui[1], t * 0.85 + (x < 5 ? 0.2 : 0));
      pc.px(x, y, c, 255, 0.3 + t * 0.6);
    });
    if (filled) {
      pc.px(4, 4, hex(0xffffff), 220, 0.9);
      pc.px(5, 3, hex(0xffffff), 160, 0.9);
    }
    pc.outline(hex(0x2a0a14), 255, 0.2);
    atlas.add(name, pc, { strength: 2.2, ao: 0.4, pivot: [0.5, 0.5] });
  }
  {
    // Small "1UP"-style pip used for the extra-life flash.
    const pc = new PixelCanvas(8, 8);
    pc.circle(4, 4, 3, C.glow, 255, 0.7, 0.9);
    atlas.add("pip", pc, { strength: 1.2, ao: 0.3, pivot: [0.5, 0.5] });
  }
}

/** Convenience: sprite names grouped by gameplay role (used by the spawner). */
export const OBSTACLE_SPRITES: Record<number, string[]> = {
  0: ["spike_0", "spike_1", "spike_2"],
  1: ["plank_0", "plank_1"],
  2: ["barrel_0", "barrel_1"],
  3: ["island_0", "island_1", "island_2"],
  4: ["mine_0", "mine_1"],
  5: ["shard_0", "shard_1"],
};

export const DECOR_SPRITES: Record<number, string[]> = {
  0: ["cloud_0", "cloud_1", "cloud_2", "cloud_3"],
  1: ["mountain_0", "mountain_1", "mountain_2"],
  2: ["ridge_0", "ridge_1", "ridge_2"],
  3: ["bird_0", "bird_1", "bird_2"],
  4: ["stars"],
  5: ["spire_0", "spire_1"],
  6: ["islet_0", "islet_1"],
  7: ["cloud_fg"],
  8: ["canopy_0", "canopy_1"],
  9: ["ruin"],
};

export const PARTICLE_SPRITES: Record<number, string> = {
  0: "p_rain",
  1: "p_mist",
  2: "p_streak",
  3: "p_spark",
  4: "p_ember",
  5: "p_dust",
  6: "p_mote",
};
