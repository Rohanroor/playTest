/**
 * Chunk-based procedural generation (runs inside WebAssembly).
 *
 * The world is sliced into vertical chunks of fixed height. When the host
 * scrolls far enough, it asks the core for the next chunk and receives a flat
 * manifest of obstacle + decor descriptors. The host then fills its object
 * pools from that manifest - nothing is allocated on either side, so an
 * infinite run produces zero garbage and no leaks in the WASM heap.
 *
 * Generation guarantees:
 *   - every chunk contains at least one survivable gap (>= 2.2x player width)
 *   - obstacle density, drift and speed scale with a difficulty curve
 *   - decor is distributed across 4 parallax layers (far .. foreground)
 *   - the same (seed, chunkIndex) always yields the same chunk
 */

import { TAU, chance, clampf, hashF32, nextF32, pickI32, rangeF32, saturate } from "./math";
import {
  D_LAYER,
  D_PARALLAX,
  D_PHASE,
  D_SCALE,
  D_SPIN,
  D_TINT,
  D_TYPE,
  D_VARIANT,
  D_X,
  D_Y,
  DC_BIRD,
  DC_CLOUD,
  DC_FLOAT_ISLET,
  DC_FOREGROUND_CLOUD,
  DC_MOUNTAIN_FAR,
  DC_RIDGE_FOREST,
  DC_ROCK_SPIRE,
  DC_RUIN,
  DC_STARFIELD,
  DC_TREE_CANOPY,
  DECOR_STRIDE,
  MAX_DECOR_PER_CHUNK,
  MAX_OBSTACLES_PER_CHUNK,
  O_DRIFT,
  O_H,
  O_PHASE,
  O_ROT,
  O_SPEED,
  O_SWAY,
  O_TYPE,
  O_VALUE,
  O_VARIANT,
  O_W,
  O_X,
  O_Y,
  OB_DEBRIS_PLANK,
  OB_DRIFT_MINE,
  OB_ICE_SHARD,
  OB_ROCK_ISLAND,
  OB_SPIKE_CLUSTER,
  OB_STORM_BARREL,
  OBSTACLE_STRIDE,
} from "./layout";

/**
 * Chunk height in world units. The host's world space is normalised so the
 * viewport is exactly 1.0 world unit wide (height = 1/aspect), which keeps the
 * horizontal dodge space identical on every screen shape.
 */
export const CHUNK_HEIGHT: f32 = 1.0;
/** Player collision half width in world units (sprite is deliberately bigger). */
export const PLAYER_HALF_WIDTH: f32 = 0.09;
/**
 * How much normalised-x the player can cover per unit of scroll-y
 * (playerSpeed / scrollSpeed, measured on the host). The corridor generator
 * never sweeps faster than this, which is what makes every chunk solvable.
 */
export const PLAYER_LATERAL_AUTHORITY: f32 = 1.2;

export const obstacleManifest: Float32Array = new Float32Array(MAX_OBSTACLES_PER_CHUNK * OBSTACLE_STRIDE);
export const decorManifest: Float32Array = new Float32Array(MAX_DECOR_PER_CHUNK * DECOR_STRIDE);

let obstacleCount: i32 = 0;
let decorCount: i32 = 0;

export function chunkObstacleCount(): i32 {
  return obstacleCount;
}

export function chunkDecorCount(): i32 {
  return decorCount;
}

function pushObstacle(
  type: f32,
  x: f32,
  y: f32,
  w: f32,
  h: f32,
  speed: f32,
  rot: f32,
  drift: f32,
  sway: f32,
  phase: f32,
  variant: f32,
  value: f32,
): void {
  if (obstacleCount >= MAX_OBSTACLES_PER_CHUNK) return;
  const o = obstacleCount * OBSTACLE_STRIDE;
  obstacleManifest[o + O_TYPE] = type;
  obstacleManifest[o + O_X] = x;
  obstacleManifest[o + O_Y] = y;
  obstacleManifest[o + O_W] = w;
  obstacleManifest[o + O_H] = h;
  obstacleManifest[o + O_SPEED] = speed;
  obstacleManifest[o + O_ROT] = rot;
  obstacleManifest[o + O_DRIFT] = drift;
  obstacleManifest[o + O_SWAY] = sway;
  obstacleManifest[o + O_PHASE] = phase;
  obstacleManifest[o + O_VARIANT] = variant;
  obstacleManifest[o + O_VALUE] = value;
  obstacleCount++;
}

function pushDecor(type: f32, x: f32, y: f32, scale: f32, variant: f32, parallax: f32, phase: f32, tint: f32, spin: f32, layer: f32): void {
  if (decorCount >= MAX_DECOR_PER_CHUNK) return;
  const o = decorCount * DECOR_STRIDE;
  decorManifest[o + D_TYPE] = type;
  decorManifest[o + D_X] = x;
  decorManifest[o + D_Y] = y;
  decorManifest[o + D_SCALE] = scale;
  decorManifest[o + D_VARIANT] = variant;
  decorManifest[o + D_PARALLAX] = parallax;
  decorManifest[o + D_PHASE] = phase;
  decorManifest[o + D_TINT] = tint;
  decorManifest[o + D_SPIN] = spin;
  decorManifest[o + D_LAYER] = layer;
  decorCount++;
}

// --- Corridor state (recomputed per chunk) ---------------------------------
let corridorBase: f32 = 0.5;
let corridorAmp: f32 = 0.08;
let corridorFreq: f32 = 1.0;
let corridorPhase: f32 = 0.0;
let corridorHalf: f32 = 0.2;

/** Centre of the guaranteed-safe corridor at a given chunk-relative y. */
export function corridorCenter(y: f32): f32 {
  return clampf(corridorBase + corridorAmp * Mathf.sin(y * corridorFreq * TAU + corridorPhase), 0.16, 0.84);
}

export function corridorHalfWidth(): f32 {
  return corridorHalf;
}

/**
 * Build the manifest for `chunkIndex`.
 *
 * Units: X, W and H are world units (the viewport is exactly 1.0 world units
 * wide); Y is a fraction of CHUNK_HEIGHT. Because W and H share a unit, sprites
 * keep their aspect ratio on every screen shape and the fairness maths is
 * aspect-ratio independent. DRIFT/SWAY are per
 * second in the same normalised space.
 *
 * `difficulty` is 0..1; `wind`/`cover`/`storm` let the weather shape the level
 * (storms throw more drifting debris, calm skies get wider corridors).
 */
export function generateChunk(chunkIndex: i32, difficulty: f32, wind: f32, cover: f32, storm: f32): void {
  obstacleCount = 0;
  decorCount = 0;
  const seed: u32 = u32(chunkIndex) * 2654435761 + 1013904223;
  const d: f32 = saturate(difficulty);
  const gentle: bool = chunkIndex < 2; // grace period right after launch

  // --- the guaranteed-survivable corridor (a slalom, not a straight lane) ----
  // The player can travel PLAYER_LATERAL_AUTHORITY normalised-x per unit of
  // scroll-y. The corridor's steepest slope is amp*freq*TAU, so we clamp the
  // frequency from the amplitude: a wide sweep must be slow, otherwise the
  // corridor would outrun the player and the chunk would be unsolvable.
  corridorBase = 0.24 + hashF32(chunkIndex, 1, seed) * 0.52;
  corridorAmp = 0.04 + d * 0.1 + hashF32(chunkIndex, 2, seed) * 0.04;
  const maxSlope: f32 = PLAYER_LATERAL_AUTHORITY * 0.42; // safety margin
  const freqCap: f32 = maxSlope / Mathf.max(corridorAmp * TAU, 0.0001);
  corridorFreq = Mathf.min(0.7 + d * 1.1 + hashF32(chunkIndex, 4, seed) * 0.5, freqCap);
  corridorPhase = hashF32(chunkIndex, 3, seed) * TAU;
  corridorHalf = (0.42 - d * 0.1) * 0.5;

  // --- obstacle budget -------------------------------------------------------
  let budget: i32 = gentle ? 2 : i32(2.0 + d * 6.0 + storm * 2.0);
  if (budget > MAX_OBSTACLES_PER_CHUNK) budget = MAX_OBSTACLES_PER_CHUNK;
  if (chunkIndex < 1) budget = 0;

  for (let i = 0; i < budget; i++) {
    // Vertical bands keep obstacles from stacking into a single wall.
    const band: f32 = f32(i) / f32(budget);
    const y: f32 = clampf(band + hashF32(chunkIndex, i, seed) * (1.0 / f32(budget)) * 0.8, 0.04, 0.94);

    const roll: f32 = hashF32(chunkIndex, i * 13 + 5, seed);
    let type: f32 = OB_SPIKE_CLUSTER;
    if (roll < 0.22) type = OB_SPIKE_CLUSTER;
    else if (roll < 0.42) type = OB_DEBRIS_PLANK;
    else if (roll < 0.58) type = OB_STORM_BARREL;
    else if (roll < 0.74) type = OB_ROCK_ISLAND;
    else if (roll < 0.89) type = OB_DRIFT_MINE;
    else type = OB_ICE_SHARD;

    let w: f32 = 0.12;
    let h: f32 = 0.12;
    let speed: f32 = 1.0;
    let drift: f32 = 0.0;
    let sway: f32 = 0.0;
    let value: f32 = 1.0;
    let rot: f32 = 0.0;

    if (type == OB_SPIKE_CLUSTER) {
      w = rangeF32(0.09, 0.15) * (0.9 + d * 0.3);
      h = w * rangeF32(0.8, 1.15);
      speed = rangeF32(0.95, 1.15);
      sway = d > 0.35 ? rangeF32(0.0, 0.035) : 0.0;
      rot = rangeF32(-0.3, 0.3);
    } else if (type == OB_DEBRIS_PLANK) {
      w = rangeF32(0.14, 0.26) * (0.9 + d * 0.25);
      h = w * rangeF32(0.3, 0.5);
      speed = rangeF32(1.0, 1.3);
      rot = rangeF32(-0.8, 0.8);
      drift = wind * rangeF32(-0.05, 0.05) * (hashF32(chunkIndex, i, seed + 3) < 0.5 ? -1.0 : 1.0);
      value = 1.2;
    } else if (type == OB_STORM_BARREL) {
      w = rangeF32(0.09, 0.14);
      h = w * rangeF32(1.1, 1.4);
      speed = rangeF32(0.9, 1.1);
      drift = wind * rangeF32(-0.08, 0.08);
      rot = rangeF32(-0.2, 0.2);
      value = 1.1;
    } else if (type == OB_ROCK_ISLAND) {
      w = rangeF32(0.2, 0.36) * (0.85 + d * 0.35);
      h = w * rangeF32(0.32, 0.55);
      speed = rangeF32(0.82, 0.98);
      rot = rangeF32(-0.1, 0.1);
      value = 1.5;
    } else if (type == OB_DRIFT_MINE) {
      w = rangeF32(0.08, 0.12);
      h = w;
      speed = rangeF32(0.85, 1.05);
      sway = rangeF32(0.04, 0.11) * (0.5 + d);
      value = 1.3;
    } else {
      // ice shard - fast, narrow, tilts as it falls
      w = rangeF32(0.06, 0.1);
      h = w * rangeF32(1.8, 2.8);
      speed = rangeF32(1.15, 1.5) * (0.8 + d * 0.5);
      rot = rangeF32(-0.5, 0.5);
      value = 1.4;
    }

    // Storm debris blows sideways with the wind.
    if (storm > 0.3 && chance(0.35)) drift += wind * rangeF32(0.03, 0.09) * (nextF32() < 0.5 ? -1.0 : 1.0);
    drift = clampf(drift, -0.18, 0.18);

    // --- place it OUTSIDE the corridor (analytically, never by luck) --------
    // `half` is the obstacle's *reach*: its sprite radius plus the player's
    // collision radius plus everything that makes it wander (sway + drift), so
    // the free corridor stays free even in the worst frame of the animation.
    let x: f32 = 0.06 + hashF32(chunkIndex, i * 31 + 11, seed) * 0.88;
    const c: f32 = corridorCenter(y);
    let half: f32 = w * 0.5 + PLAYER_HALF_WIDTH + sway + Mathf.abs(drift) * 0.6;
    const phase: f32 = rangeF32(0.0, TAU);

    const edgeL: f32 = 0.02;
    const edgeR: f32 = 0.98;
    const leftRoom: f32 = (c - corridorHalf) - edgeL;
    const rightRoom: f32 = edgeR - (c + corridorHalf);
    const bestRoom: f32 = Mathf.max(leftRoom, rightRoom);

    // Too fat for either side? Shrink until it provably fits.
    let guard: i32 = 0;
    while (half * 2.0 > bestRoom && guard < 10) {
      w *= 0.72;
      h *= 0.72;
      half = w * 0.5 + PLAYER_HALF_WIDTH + sway + Mathf.abs(drift) * 0.6;
      guard++;
    }

    const leftHi: f32 = c - corridorHalf - half;
    const rightLo: f32 = c + corridorHalf + half;
    const fitsLeft: bool = leftHi >= edgeL + half;
    const fitsRight: bool = rightLo <= edgeR - half;
    let onLeft: bool = x < c;
    if (onLeft && !fitsLeft) onLeft = false;
    if (!onLeft && !fitsRight && fitsLeft) onLeft = true;

    if (onLeft && fitsLeft) x = clampf(x, edgeL + half, leftHi);
    else if (fitsRight) x = clampf(x, rightLo, edgeR - half);
    else x = clampf(x, edgeL + half, edgeR - half); // degenerate: keep on screen

    pushObstacle(type, clampf(x, 0.02, 0.98), y, w, h, speed, rot, drift, sway, phase, f32(pickI32(3)), value);
  }

  // ------------------------------------------------------------------------
  // Decor: distributed over 4 parallax layers. Density follows cloud cover.
  // ------------------------------------------------------------------------
  const cloudiness: f32 = clampf(cover, 0.05, 1.0);

  // Layer 0 - far mountains (sparse, big, slow)
  if (chunkIndex % 2 == 0) {
    const n: i32 = 1 + pickI32(2);
    for (let i = 0; i < n; i++) {
      pushDecor(DC_MOUNTAIN_FAR, rangeF32(-0.1, 1.1), rangeF32(0.1, 0.9), rangeF32(1.1, 1.9), f32(pickI32(4)), 0.08, nextF32() * TAU, f32(pickI32(3)), 0.0, 0.0);
    }
  }

  // Layer 0/1 - forest ridges and distant spires
  if (chunkIndex % 2 == 1) {
    pushDecor(DC_RIDGE_FOREST, rangeF32(0.0, 1.0), rangeF32(0.15, 0.85), rangeF32(1.2, 2.0), f32(pickI32(3)), 0.22, nextF32() * TAU, f32(pickI32(3)), 0.0, 0.0);
    if (chance(0.5)) pushDecor(DC_ROCK_SPIRE, rangeF32(0.0, 1.0), rangeF32(0.1, 0.9), rangeF32(0.6, 1.2), f32(pickI32(3)), 0.3, nextF32() * TAU, f32(pickI32(2)), 0.0, 1.0);
  }

  // Layer 1 - mid clouds
  const midClouds: i32 = i32(2.0 + cloudiness * 7.0);
  for (let i = 0; i < midClouds && decorCount < MAX_DECOR_PER_CHUNK; i++) {
    const scale: f32 = rangeF32(0.5, 1.5) * (0.8 + cloudiness * 0.6);
    pushDecor(DC_CLOUD, nextF32() * 1.3 - 0.15, nextF32(), scale, f32(pickI32(5)), rangeF32(0.38, 0.55), nextF32() * TAU, f32(pickI32(3)), 0.0, 1.0);
  }

  // Layer 1 - floating islets and ruins (story bits from the world below)
  if (chance(0.35)) {
    pushDecor(DC_FLOAT_ISLET, rangeF32(0.05, 0.95), rangeF32(0.1, 0.9), rangeF32(0.5, 1.0), f32(pickI32(3)), 0.62, nextF32() * TAU, f32(pickI32(2)), 0.0, 1.0);
  }
  if (chance(0.14)) {
    pushDecor(DC_RUIN, rangeF32(0.05, 0.95), rangeF32(0.2, 0.8), rangeF32(0.5, 0.9), f32(pickI32(2)), 0.68, nextF32() * TAU, f32(pickI32(2)), 0.0, 1.0);
  }

  // Layer 2 - close canopies and bird flocks (faster than the play plane)
  if (chance(0.55)) {
    pushDecor(DC_TREE_CANOPY, rangeF32(-0.05, 1.05), rangeF32(0.1, 0.9), rangeF32(0.7, 1.3), f32(pickI32(3)), 1.12, nextF32() * TAU, f32(pickI32(2)), 0.0, 2.0);
  }
  const flocks: i32 = chance(0.42) ? 1 + pickI32(2) : 0;
  for (let f = 0; f < flocks; f++) {
    const bx: f32 = nextF32();
    const by: f32 = nextF32();
    const birds: i32 = 3 + pickI32(5);
    for (let b = 0; b < birds && decorCount < MAX_DECOR_PER_CHUNK; b++) {
      const ox: f32 = bx + (nextF32() - 0.5) * 0.22;
      const oy: f32 = by + (nextF32() - 0.5) * 0.14;
      pushDecor(DC_BIRD, clampf(ox, 0.02, 0.98), clampf(oy, 0.02, 0.98), rangeF32(0.5, 0.85), f32(pickI32(3)), rangeF32(1.5, 1.95), nextF32() * TAU, 0.0, rangeF32(-0.35, 0.35), 2.0);
    }
  }

  // Layer 3 - foreground clouds sweeping past faster than the player
  const fgClouds: i32 = i32(0.5 + cloudiness * 2.6);
  for (let i = 0; i < fgClouds && decorCount < MAX_DECOR_PER_CHUNK; i++) {
    pushDecor(DC_FOREGROUND_CLOUD, nextF32() * 1.4 - 0.2, nextF32(), rangeF32(0.9, 2.1), f32(pickI32(4)), rangeF32(1.5, 2.2), nextF32() * TAU, f32(pickI32(3)), 0.0, 3.0);
  }

  // Layer 0 - star clusters (host culls them by star alpha)
  if (chance(0.6)) {
    pushDecor(DC_STARFIELD, nextF32(), nextF32(), rangeF32(0.8, 1.6), f32(pickI32(4)), 0.04, nextF32() * TAU, 0.0, 0.0, 0.0);
  }
}

