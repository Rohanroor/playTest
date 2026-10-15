/**
 * ASCENSION simulation core - WebAssembly entry point.
 *
 * Everything the game *simulates* lives here (procedural chunks, weather,
 * time-of-day, particles). Everything the game *renders* lives in TypeScript
 * on the host. The boundary is a set of flat Float32Arrays in linear memory
 * that the host reads zero-copy - see wasm/assembly/layout.ts.
 *
 * Build: node wasm/build.mjs   (or `npm run wasm`)
 */

import { LAYOUT_VERSION, DECOR_STRIDE, MAX_PARTICLES, OBSTACLE_STRIDE, PARTICLE_STRIDE, WEATHER_STRIDE } from "./layout";
import { fbm2, nextF32, noise2, seedRng } from "./math";
import { CHUNK_HEIGHT, chunkDecorCount, chunkObstacleCount, corridorCenter, corridorHalfWidth, decorManifest, generateChunk, obstacleManifest } from "./chunks";
import {
  consumeThunder,
  weather,
  forceState,
  setDayLength,
  setDayPhase,
  weatherInit,
  weatherStep,
  weatherTime,
} from "./weather";
import { emitBurst, particles, particlesAlive, particlesCapacity, particlesReset, particlesStep } from "./particles";

// --- identity & layout contract ---------------------------------------------
export function layoutVersion(): i32 {
  return LAYOUT_VERSION;
}
export function weatherStride(): i32 {
  return WEATHER_STRIDE;
}
export function obstacleStride(): i32 {
  return OBSTACLE_STRIDE;
}
export function decorStride(): i32 {
  return DECOR_STRIDE;
}
export function particleStride(): i32 {
  return PARTICLE_STRIDE;
}
export function particleCapacity(): i32 {
  return MAX_PARTICLES;
}
export function chunkHeight(): f32 {
  return CHUNK_HEIGHT;
}

// --- zero-copy buffer handles ------------------------------------------------
export function weatherPtr(): usize {
  return weather.dataStart;
}
export function obstaclePtr(): usize {
  return obstacleManifest.dataStart;
}
export function decorPtr(): usize {
  return decorManifest.dataStart;
}
export function particlePtr(): usize {
  return particles.dataStart;
}

// --- lifecycle ---------------------------------------------------------------
export function simInit(seed: u32): void {
  seedRng(seed);
  weatherInit(0.012, 240.0);
  particlesReset();
}

export function simReset(seed: u32): void {
  simInit(seed);
}

export function simDayLength(sec: f32): void {
  setDayLength(sec);
}

export function simDayPhase(phase: f32): void {
  setDayPhase(phase);
}

export function simTimeOfDay(): f32 {
  return weather[0];
}

export function simElapsed(): f32 {
  return weatherTime();
}

export function simForceWeather(state: i32): void {
  forceState(state);
}

export function simThunderEvents(): f32 {
  return consumeThunder();
}

// --- per-frame stepping ------------------------------------------------------
export function simWeatherStep(dt: f32, altitude: f32, scroll: f32): void {
  weatherStep(dt, altitude, scroll);
}

export function simGenerateChunk(index: i32, difficulty: f32, wind: f32, cover: f32, storm: f32): void {
  generateChunk(index, difficulty, wind, cover, storm);
}

export function simObstacleCount(): i32 {
  return chunkObstacleCount();
}

export function simDecorCount(): i32 {
  return chunkDecorCount();
}

/** Centre of the guaranteed-safe corridor of the last generated chunk. */
export function simCorridorCenter(y: f32): f32 {
  return corridorCenter(y);
}

export function simCorridorHalfWidth(): f32 {
  return corridorHalfWidth();
}

export function simParticlesStep(
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
  particlesStep(dt, viewW, viewH, wind, windDir, rain, fog, scroll, leanX, lightning, night);
}

export function simParticlesReset(): void {
  particlesReset();
}

export function simParticleCount(): i32 {
  return particlesAlive();
}

export function simEmitBurst(x: f32, y: f32, count: i32, type: f32, spread: f32, speed: f32, life: f32, size: f32): void {
  emitBurst(x, y, count, type, spread, speed, life, size);
}

// --- noise exposed to the host (keeps CPU and GPU noise in the same family) --
export function simNoise2(x: f32, y: f32, seed: u32): f32 {
  return noise2(x, y, seed);
}

export function simFbm2(x: f32, y: f32, octaves: i32, seed: u32): f32 {
  return fbm2(x, y, octaves, seed);
}

export function simRandom(): f32 {
  return nextF32();
}
