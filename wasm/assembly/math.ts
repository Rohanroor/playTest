/**
 * Deterministic math / noise / RNG utilities for the simulation core.
 *
 * Everything here is pure and seedable: the same seed + chunk index always
 * produces the same level. That keeps replay/verification possible and makes
 * the WASM core a drop-in deterministic authority for the host renderer.
 */

export const TAU: f32 = 6.28318530718;

// ---------------------------------------------------------------------------
// Two independent xorshift32 streams.
//
//   world - the gameplay authority: chunk authoring, weather timing, lightning
//           scheduling. It is drained only by fixed-timestep simulation code,
//           so a given seed always replays the same level.
//   fx    - cosmetic churn: particle jitter, burst velocities, band decor. How
//           much of it happens depends on frame pacing and host-side dice, so
//           it is deliberately isolated: a busy particle system can never shift
//           the world stream and quietly re-author the level.
// ---------------------------------------------------------------------------

let worldState: u32 = 0x9e3779b9;
let fxState: u32 = 0x85ebca6b;

/** Decorrelate two streams from one seed (finaliser of a MurmurHash3). */
function mix32(seed: u32, salt: u32): u32 {
  let h: u32 = seed ^ salt;
  h = (h ^ (h >>> 16)) * 2246822519;
  h = (h ^ (h >>> 13)) * 3266489917;
  h = h ^ (h >>> 16);
  return h == 0 ? salt : h;
}

function xorshift32(x: u32): u32 {
  let v = x;
  v ^= v << 13;
  v ^= v >>> 17;
  v ^= v << 5;
  return v;
}

export function seedRng(seed: u32): void {
  const s: u32 = seed == 0 ? 0x9e3779b9 : seed;
  worldState = mix32(s, 0x9e3779b9);
  fxState = mix32(s, 0x85ebca6b);
  // Warm both generators so the first draws are well distributed.
  for (let i = 0; i < 12; i++) {
    worldState = xorshift32(worldState);
    fxState = xorshift32(fxState);
  }
}

/** World stream: gameplay-random. */
export function nextU32(): u32 {
  worldState = xorshift32(worldState);
  return worldState;
}

/** Uniform float in [0,1) from the world stream. */
export function nextF32(): f32 {
  return f32(nextU32() >>> 8) * (1.0 / 16777216.0);
}

export function rangeF32(a: f32, b: f32): f32 {
  return a + (b - a) * nextF32();
}

export function chance(p: f32): bool {
  return nextF32() < p;
}

export function pickI32(n: i32): i32 {
  if (n <= 1) return 0;
  return i32(nextF32() * f32(n)) % n;
}

/** FX stream: cosmetic-random, safe to drain at any rate. */
export function fxNextU32(): u32 {
  fxState = xorshift32(fxState);
  return fxState;
}

export function fxNextF32(): f32 {
  return f32(fxNextU32() >>> 8) * (1.0 / 16777216.0);
}

export function fxRangeF32(a: f32, b: f32): f32 {
  return a + (b - a) * fxNextF32();
}

// ---------------------------------------------------------------------------
// Stateless hashing - used by the chunk generator so chunks are reproducible
// without touching the shared RNG stream.
// ---------------------------------------------------------------------------

export function hashU32(x: i32, y: i32, seed: u32): u32 {
  let h: u32 = u32(x) * 374761393 + u32(y) * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return h;
}

export function hashF32(x: i32, y: i32, seed: u32): f32 {
  return f32(hashU32(x, y, seed) >>> 8) * (1.0 / 16777216.0);
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export function clampf(v: f32, lo: f32, hi: f32): f32 {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerpf(a: f32, b: f32, t: f32): f32 {
  return a + (b - a) * t;
}

export function saturate(v: f32): f32 {
  return clampf(v, 0.0, 1.0);
}

export function smoothstep(e0: f32, e1: f32, x: f32): f32 {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3.0 - 2.0 * t);
}

/** Ken Perlin's smootherstep - zero 1st and 2nd derivative at the ends. */
export function smootherstep(t: f32): f32 {
  const x = saturate(t);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

/** Frame-rate independent exponential approach ("lerp with a time constant"). */
export function dampf(current: f32, target: f32, halfLife: f32, dt: f32): f32 {
  if (halfLife <= 0.0001) return target;
  const k: f32 = 1.0 - Mathf.pow(0.5, dt / halfLife);
  return current + (target - current) * k;
}

// ---------------------------------------------------------------------------
// Value noise + fbm
// ---------------------------------------------------------------------------

export function noise1(x: f32, seed: u32): f32 {
  const i = Mathf.floor(x);
  const f = x - i;
  const xi = i32(i);
  const a = hashF32(xi, 0, seed);
  const b = hashF32(xi + 1, 0, seed);
  return lerpf(a, b, smootherstep(f));
}

export function noise2(x: f32, y: f32, seed: u32): f32 {
  const ix = Mathf.floor(x);
  const iy = Mathf.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = smootherstep(fx);
  const v = smootherstep(fy);
  const x0 = i32(ix);
  const y0 = i32(iy);
  const a = lerpf(hashF32(x0, y0, seed), hashF32(x0 + 1, y0, seed), u);
  const b = lerpf(hashF32(x0, y0 + 1, seed), hashF32(x0 + 1, y0 + 1, seed), u);
  return lerpf(a, b, v);
}

export function fbm2(x: f32, y: f32, octaves: i32, seed: u32): f32 {
  let amp: f32 = 0.5;
  let freq: f32 = 1.0;
  let sum: f32 = 0.0;
  let norm: f32 = 0.0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + u32(i) * 1013);
    norm += amp;
    amp *= 0.5;
    freq *= 2.02;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}

export function fbm1(x: f32, octaves: i32, seed: u32): f32 {
  let amp: f32 = 0.5;
  let freq: f32 = 1.0;
  let sum: f32 = 0.0;
  let norm: f32 = 0.0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise1(x * freq, seed + u32(i) * 7919);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return norm > 0.0 ? sum / norm : 0.0;
}
