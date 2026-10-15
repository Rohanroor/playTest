/**
 * GPU-fed particle simulation (runs inside WebAssembly).
 *
 * Thousands of rain drops, mist puffs, wind streaks and embers are integrated
 * here in linear memory and rendered by the host as a single instanced draw
 * call. Particle space is screen space measured in world units with +Y down
 * (the direction the world scrolls), so no matrix math is needed per particle.
 *
 * The pool is fixed size with swap-remove compaction: steady state allocates
 * nothing, which is exactly what an infinite WASM run needs.
 */

import { clampf, nextF32, rangeF32, saturate, TAU } from "./math";
import {
  MAX_PARTICLES,
  P_ALPHA,
  P_DEPTH,
  P_LIFE,
  P_MAX_LIFE,
  P_ROT,
  P_SEED,
  P_SIZE,
  P_TYPE,
  P_VX,
  P_VY,
  P_X,
  P_Y,
  PARTICLE_STRIDE,
  PT_DUST,
  PT_EMBER,
  PT_GLOW_MOTE,
  PT_MIST,
  PT_RAIN,
  PT_SPARK,
  PT_WIND_STREAK,
} from "./layout";

export const particles: Float32Array = new Float32Array(MAX_PARTICLES * PARTICLE_STRIDE);
let alive: i32 = 0;

let rainAcc: f32 = 0.0;
let mistAcc: f32 = 0.0;
let streakAcc: f32 = 0.0;
let dustAcc: f32 = 0.0;
let glowAcc: f32 = 0.0;

export function particlesAlive(): i32 {
  return alive;
}

export function particlesReset(): void {
  alive = 0;
  rainAcc = 0.0;
  mistAcc = 0.0;
  streakAcc = 0.0;
  dustAcc = 0.0;
  glowAcc = 0.0;
}

export function particlesCapacity(): i32 {
  return MAX_PARTICLES;
}

function spawn(
  type: f32,
  x: f32,
  y: f32,
  vx: f32,
  vy: f32,
  life: f32,
  size: f32,
  depth: f32,
  alpha: f32,
  rot: f32,
): void {
  if (alive >= MAX_PARTICLES) return;
  const o = alive * PARTICLE_STRIDE;
  particles[o + P_X] = x;
  particles[o + P_Y] = y;
  particles[o + P_VX] = vx;
  particles[o + P_VY] = vy;
  particles[o + P_LIFE] = life;
  particles[o + P_MAX_LIFE] = life;
  particles[o + P_SIZE] = size;
  particles[o + P_TYPE] = type;
  particles[o + P_ROT] = rot;
  particles[o + P_ALPHA] = alpha;
  particles[o + P_DEPTH] = depth;
  particles[o + P_SEED] = nextF32() * 1000.0;
  alive++;
}

/** Host-triggered one-shot burst (collision sparks, burner embers, untie puff). */
export function emitBurst(x: f32, y: f32, count: i32, type: f32, spread: f32, speed: f32, life: f32, size: f32): void {
  for (let i = 0; i < count; i++) {
    if (alive >= MAX_PARTICLES) return;
    const a = nextF32() * TAU;
    const s: f32 = speed * (0.35 + nextF32() * 0.9);
    const vx = Mathf.cos(a) * s * spread;
    const vy = Mathf.sin(a) * s * spread;
    const l: f32 = life * (0.55 + nextF32() * 0.7);
    spawn(type, x + (nextF32() - 0.5) * 0.04, y + (nextF32() - 0.5) * 0.04, vx, vy, l, size * (0.6 + nextF32() * 0.8), 1.0, 1.0, nextF32() * TAU);
  }
}

function removeAt(i: i32): void {
  const last = alive - 1;
  if (i != last) {
    const a = i * PARTICLE_STRIDE;
    const b = last * PARTICLE_STRIDE;
    for (let k = 0; k < PARTICLE_STRIDE; k++) particles[a + k] = particles[b + k];
  }
  alive--;
}

/**
 * Advance every particle and top up the emitters.
 *
 * @param dt          fixed timestep (seconds)
 * @param viewW/viewH viewport size in world units
 * @param wind        0..1 sustained wind strength
 * @param windDir     -1..1 lateral direction
 * @param rain        0..1 rain intensity
 * @param fog         0..1 fog density
 * @param scroll      world scroll speed (units/s, downward)
 * @param leanX       camera lean in world units (parallax offset source)
 * @param lightning   0..1 instantaneous flash energy
 * @param night       0..1 how dark it is
 */
export function particlesStep(
  dt: f32,
  viewW: f32,
  viewH: f32,
  wind: f32,
  windDir: f32,
  rain: f32,
  fog: f32,
  scroll: f32,
  leanX: f32,
  lightning: f32,
  night: f32,
): void {
  const windPush = windDir * wind;

  // --- emission rates (particles per second) --------------------------------
  // World space is normalised: the viewport is 1.0 unit wide and 1/aspect
  // tall, so these velocities/sizes are fractions of the screen.
  const rainRate: f32 = rain * 2600.0;
  const mistRate: f32 = (0.12 + fog * 0.9) * 55.0;
  const streakRate: f32 = saturate(wind - 0.22) * 240.0;
  const dustRate: f32 = 34.0;
  const glowRate: f32 = night * 80.0;

  rainAcc += rainRate * dt;
  mistAcc += mistRate * dt;
  streakAcc += streakRate * dt;
  dustAcc += dustRate * dt;
  glowAcc += glowRate * dt;

  while (rainAcc >= 1.0) {
    rainAcc -= 1.0;
    if (alive >= MAX_PARTICLES) break;
    const depth: f32 = rangeF32(0.55, 2.1);
    const speed: f32 = (0.85 + depth * 0.4) * rangeF32(0.9, 1.2);
    spawn(
      PT_RAIN,
      rangeF32(-0.15, viewW + 0.15) - windPush * depth * 0.06,
      rangeF32(-0.25, -0.01),
      windPush * (0.35 + depth * 0.3),
      speed,
      rangeF32(0.7, 1.6),
      rangeF32(0.004, 0.011) * (0.6 + depth * 0.4),
      depth,
      1.0,
      0.0,
    );
  }

  while (mistAcc >= 1.0) {
    mistAcc -= 1.0;
    if (alive >= MAX_PARTICLES) break;
    const depth: f32 = rangeF32(0.25, 1.25);
    spawn(
      PT_MIST,
      rangeF32(-0.3, viewW + 0.3),
      rangeF32(-0.3, viewH + 0.3),
      windPush * depth * 0.12 + rangeF32(-0.03, 0.03),
      scroll * depth * 0.55 + rangeF32(-0.02, 0.02),
      rangeF32(4.0, 9.0),
      rangeF32(0.08, 0.34),
      depth,
      1.0,
      nextF32() * TAU,
    );
  }

  while (streakAcc >= 1.0) {
    streakAcc -= 1.0;
    if (alive >= MAX_PARTICLES) break;
    const depth: f32 = rangeF32(0.9, 2.3);
    const fromLeft: bool = windPush > 0.0;
    spawn(
      PT_WIND_STREAK,
      fromLeft ? -0.25 : viewW + 0.25,
      rangeF32(-0.05, viewH + 0.05),
      windPush * (0.7 + depth * 0.6),
      scroll * depth * 0.7 + rangeF32(-0.05, 0.05),
      rangeF32(0.4, 1.1),
      rangeF32(0.05, 0.18),
      depth,
      1.0,
      0.0,
    );
  }

  while (dustAcc >= 1.0) {
    dustAcc -= 1.0;
    if (alive >= MAX_PARTICLES) break;
    const depth: f32 = rangeF32(0.8, 1.4);
    spawn(
      PT_DUST,
      rangeF32(-0.05, viewW + 0.05),
      rangeF32(-0.05, viewH + 0.05),
      windPush * depth * 0.2 + rangeF32(-0.02, 0.02),
      scroll * depth + rangeF32(-0.03, 0.01),
      rangeF32(2.5, 6.0),
      rangeF32(0.004, 0.014),
      depth,
      1.0,
      nextF32() * TAU,
    );
  }

  while (glowAcc >= 1.0) {
    glowAcc -= 1.0;
    if (alive >= MAX_PARTICLES) break;
    spawn(
      PT_GLOW_MOTE,
      rangeF32(-0.05, viewW + 0.05),
      rangeF32(0.0, viewH + 0.1),
      windPush * 0.1 + rangeF32(-0.015, 0.015),
      scroll * 0.9 - rangeF32(0.02, 0.09),
      rangeF32(3.0, 7.0),
      rangeF32(0.005, 0.02),
      rangeF32(0.9, 1.3),
      1.0,
      nextF32() * TAU,
    );
  }

  // --- integration ----------------------------------------------------------
  let i = 0;
  while (i < alive) {
    const o = i * PARTICLE_STRIDE;
    const type = particles[o + P_TYPE];
    const depth = particles[o + P_DEPTH];
    let vx = particles[o + P_VX];
    let vy = particles[o + P_VY];

    if (type == PT_RAIN) {
      vx = vx * 0.9 + windPush * (0.35 + depth * 0.3) * 0.1;
      vy += 0.5 * dt;
    } else if (type == PT_MIST) {
      vx += windPush * depth * 0.05 * dt;
      vy = scroll * depth * 0.55;
      vx *= 0.99;
    } else if (type == PT_WIND_STREAK) {
      vy = scroll * depth * 0.7;
      vx += windPush * 0.25 * dt;
    } else if (type == PT_DUST) {
      vy = scroll * depth + Mathf.sin(particles[o + P_SEED] + particles[o + P_LIFE] * 2.0) * 0.012;
      vx += windPush * depth * 0.06 * dt;
    } else if (type == PT_GLOW_MOTE) {
      vy = scroll * depth * 0.9 + Mathf.sin(particles[o + P_SEED] * 0.7 + particles[o + P_LIFE]) * 0.02;
      vx += windPush * 0.05 * dt;
    } else if (type == PT_SPARK || type == PT_EMBER) {
      vy += (type == PT_EMBER ? -0.12 : 0.9) * dt; // embers rise from the burner
      vx *= 0.965;
      vy *= 0.965;
      vx += windPush * 0.25 * dt;
    }

    particles[o + P_VX] = vx;
    particles[o + P_VY] = vy;
    particles[o + P_X] += vx * dt;
    particles[o + P_Y] += vy * dt;

    particles[o + P_LIFE] -= dt;

    // Fade in/out over the lifetime so nothing pops, and derive the authored
    // alpha from weather each frame (single source of truth - no drift).
    const maxLife = particles[o + P_MAX_LIFE];
    const t: f32 = maxLife > 0.0 ? saturate(particles[o + P_LIFE] / maxLife) : 0.0;
    const fade: f32 = saturate(t * 4.5) * saturate((1.0 - t) * 2.5 + 0.2);
    let a: f32 = 0.3;
    if (type == PT_RAIN) a = clampf(0.18 + rain * 0.45 + lightning * 0.45, 0.0, 1.0) * (0.5 + depth * 0.3);
    else if (type == PT_MIST) a = clampf(fog * 0.42 + 0.04, 0.0, 0.55);
    else if (type == PT_WIND_STREAK) a = clampf(wind * 0.3 + lightning * 0.3, 0.0, 0.55);
    else if (type == PT_DUST) a = clampf(0.1 + lightning * 0.55 + night * 0.1, 0.0, 0.7);
    else if (type == PT_GLOW_MOTE) a = clampf(night * 0.75 + 0.05, 0.0, 0.9);
    else if (type == PT_SPARK) a = 1.0;
    else if (type == PT_EMBER) a = 0.95;
    particles[o + P_ALPHA] = a * fade;

    const x = particles[o + P_X];
    const y = particles[o + P_Y];
    const dead =
      particles[o + P_LIFE] <= 0.0 ||
      y > viewH + 0.35 ||
      y < -0.5 ||
      x < -0.4 ||
      x > viewW + 0.4;

    if (dead) {
      removeAt(i);
      continue;
    }
    i++;
  }
}
