/**
 * Weather + Time-of-Day authority (runs inside WebAssembly).
 *
 * Two independent systems, both continuous:
 *   1. Time of day  - a fixed-length cycle (dawn -> harsh noon -> purple/orange
 *      dusk -> lantern-lit night) driven by a keyframed palette table.
 *   2. Weather      - a weighted state machine (Calm -> Cloudy -> Windy ->
 *      Thunderstorm) whose parameters are cross-faded with smootherstep over
 *      8-16 seconds, then modulated by layered fbm noise so gusts, rain and
 *      cloud cover never feel like a switch was flipped.
 *
 * Results are written into a flat Float32Array the host reads zero-copy.
 */

import {
  clampf,
  dampf,
  fbm1,
  lerpf,
  nextF32,
  pickI32,
  rangeF32,
  saturate,
  smoothstep,
  smootherstep,
  TAU,
} from "./math";
import {
  W_ALTITUDE,
  W_AMBIENT_B,
  W_AMBIENT_G,
  W_AMBIENT_R,
  W_CLOUD_B,
  W_CLOUD_COVER,
  W_CLOUD_G,
  W_CLOUD_R,
  W_DIFFICULTY,
  W_EXPOSURE,
  W_FOG,
  W_FOG_B,
  W_FOG_G,
  W_FOG_R,
  W_LANTERN,
  W_LIGHTNING,
  W_RAIN,
  W_SCROLL,
  W_SHADOW_SOFTNESS,
  W_SKY_HORIZON_B,
  W_SKY_HORIZON_G,
  W_SKY_HORIZON_R,
  W_SKY_TOP_B,
  W_SKY_TOP_G,
  W_SKY_TOP_R,
  W_STAR_ALPHA,
  W_STATE,
  W_STATE_BLEND,
  W_STORM,
  W_SUN_AZIMUTH,
  W_SUN_B,
  W_SUN_ELEVATION,
  W_SUN_G,
  W_SUN_INTENSITY,
  W_SUN_R,
  W_THUNDER_EVENTS,
  W_TIME_OF_DAY,
  W_WIND,
  W_WIND_DIR,
  W_WIND_GUST,
  WEATHER_STRIDE,
  WS_CALM,
  WS_CLOUDY,
  WS_STORM,
  WS_WINDY,
} from "./layout";

// --- Palette keyframe table -------------------------------------------------
const KF_STRIDE: i32 = 10; // phase, skyTop RGB, horizon RGB, sun/moon RGB
const KF_COUNT: i32 = 11;
const kf: Float32Array = new Float32Array(KF_COUNT * KF_STRIDE);
const ambPacked: Uint32Array = new Uint32Array(KF_COUNT);
const exposureTable: Float32Array = new Float32Array(KF_COUNT);
const lanternTable: Float32Array = new Float32Array(KF_COUNT);
const sunITable: Float32Array = new Float32Array(KF_COUNT);

function kfSet(i: i32, phase: f32, top: u32, hor: u32, sun: u32, amb: u32, exposure: f32, lantern: f32, sunI: f32): void {
  const o = i * KF_STRIDE;
  kf[o + 0] = phase;
  kf[o + 1] = f32((top >> 16) & 255) / 255.0;
  kf[o + 2] = f32((top >> 8) & 255) / 255.0;
  kf[o + 3] = f32(top & 255) / 255.0;
  kf[o + 4] = f32((hor >> 16) & 255) / 255.0;
  kf[o + 5] = f32((hor >> 8) & 255) / 255.0;
  kf[o + 6] = f32(hor & 255) / 255.0;
  kf[o + 7] = f32((sun >> 16) & 255) / 255.0;
  kf[o + 8] = f32((sun >> 8) & 255) / 255.0;
  kf[o + 9] = f32(sun & 255) / 255.0;
  ambPacked[i] = amb;
  exposureTable[i] = exposure;
  lanternTable[i] = lantern;
  sunITable[i] = sunI;
}

export function buildPalette(): void {
  //          phase   skyTop    horizon   sun/moon  ambient   exposure lantern sunI
  kfSet(0, 0.0, 0x141a3c, 0x4b3a63, 0xffb27a, 0x3d4570, 0.72, 0.85, 0.35); // pre-dawn
  kfSet(1, 0.06, 0x37417f, 0xff9e6b, 0xffc98f, 0x6a6f9e, 0.86, 0.3, 0.8); // dawn
  kfSet(2, 0.13, 0x5d94d6, 0xffd7a1, 0xfff0cf, 0xa9c2de, 1.0, 0.0, 1.15); // warm morning
  kfSet(3, 0.25, 0x3f86dd, 0xcfe8fb, 0xfffaf0, 0xdce9f6, 1.14, 0.0, 1.45); // harsh midday
  kfSet(4, 0.38, 0x4a86cf, 0xffe0b0, 0xffe9c0, 0xcddaea, 1.05, 0.0, 1.2); // afternoon
  kfSet(5, 0.47, 0x4a5f9e, 0xffab5e, 0xffb066, 0xb39cc0, 1.0, 0.12, 1.0); // golden hour
  kfSet(6, 0.55, 0x3a2a63, 0xff7a45, 0xff6a3a, 0x8a6fae, 0.92, 0.4, 0.6); // purple/orange dusk
  kfSet(7, 0.63, 0x1d1c46, 0x77407a, 0xc96a9a, 0x4e4a86, 0.8, 0.72, 0.26); // twilight
  kfSet(8, 0.75, 0x060a1c, 0x141c3e, 0x8fa8d8, 0x223058, 0.7, 1.0, 0.18); // night (moonlight)
  kfSet(9, 0.88, 0x080c22, 0x1b2145, 0x9fb0dd, 0x26314f, 0.7, 1.0, 0.18); // deep night
  kfSet(10, 1.0, 0x141a3c, 0x4b3a63, 0xffb27a, 0x3d4570, 0.72, 0.85, 0.35); // wrap to pre-dawn
}

// --- Weather state parameter table -----------------------------------------
// cloudCover, wind, rain, fog, storm, gustiness
const STATE_STRIDE: i32 = 6;
const stateTable: Float32Array = new Float32Array(4 * STATE_STRIDE);

function stSet(i: i32, cover: f32, wind: f32, rain: f32, fog: f32, storm: f32, gust: f32): void {
  const o = i * STATE_STRIDE;
  stateTable[o + 0] = cover;
  stateTable[o + 1] = wind;
  stateTable[o + 2] = rain;
  stateTable[o + 3] = fog;
  stateTable[o + 4] = storm;
  stateTable[o + 5] = gust;
}

export function buildStates(): void {
  stSet(WS_CALM, 0.16, 0.05, 0.0, 0.16, 0.0, 0.15);
  stSet(WS_CLOUDY, 0.63, 0.2, 0.1, 0.34, 0.06, 0.4);
  stSet(WS_WINDY, 0.46, 0.8, 0.04, 0.24, 0.12, 0.95);
  stSet(WS_STORM, 0.94, 0.66, 0.88, 0.52, 1.0, 0.75);
}

// Weighted transition matrix (row = current state, column = next state).
const transMatrix: Float32Array = new Float32Array(16);

export function buildTransitions(): void {
  transMatrix[0] = 0.0;
  transMatrix[1] = 0.62;
  transMatrix[2] = 0.28;
  transMatrix[3] = 0.1;
  transMatrix[4] = 0.3;
  transMatrix[5] = 0.0;
  transMatrix[6] = 0.4;
  transMatrix[7] = 0.3;
  transMatrix[8] = 0.2;
  transMatrix[9] = 0.45;
  transMatrix[10] = 0.0;
  transMatrix[11] = 0.35;
  transMatrix[12] = 0.15;
  transMatrix[13] = 0.5;
  transMatrix[14] = 0.35;
  transMatrix[15] = 0.0;
}

// --- Module state -----------------------------------------------------------
export const weather: Float32Array = new Float32Array(WEATHER_STRIDE);

let simTime: f32 = 0.0;
let dayLength: f32 = 240.0;
let dayPhase: f32 = 0.012; // boot into early morning for the title screen
let state: i32 = WS_CALM;
let nextState: i32 = WS_CLOUDY;
let blend: f32 = 1.0;
let blendDuration: f32 = 12.0;
let holdTimer: f32 = 24.0;
let lightningTimer: f32 = 6.0;
let lightningElapsed: f32 = 99.0;
let thunderEvents: f32 = 0.0;
let gustSeed: f32 = 0.0;

export function weatherInit(startPhase: f32, lengthSec: f32): void {
  buildPalette();
  buildStates();
  buildTransitions();
  simTime = 0.0;
  dayLength = lengthSec > 20.0 ? lengthSec : 240.0;
  dayPhase = startPhase;
  state = WS_CALM;
  nextState = WS_CLOUDY;
  blend = 1.0;
  blendDuration = 12.0;
  holdTimer = 26.0;
  lightningTimer = 5.0;
  lightningElapsed = 99.0;
  gustSeed = rangeF32(0.0, 1000.0);
  for (let i = 0; i < WEATHER_STRIDE; i++) weather[i] = 0.0;
  weather[W_TIME_OF_DAY] = dayPhase;
  weather[W_STATE] = f32(state);
  weather[W_STATE_BLEND] = 1.0;
  weather[W_EXPOSURE] = 1.0;
}

export function setDayLength(sec: f32): void {
  dayLength = sec > 20.0 ? sec : 20.0;
}

export function setDayPhase(phase: f32): void {
  dayPhase = phase - Mathf.floor(phase);
}

/** Deterministically force a weather state (debug / attract mode). */
export function forceState(s: i32): void {
  nextState = clampi(s, 0, 3);
  blend = 0.0;
  blendDuration = 6.0;
  holdTimer = 30.0;
}

function clampi(v: i32, lo: i32, hi: i32): i32 {
  return v < lo ? lo : v > hi ? hi : v;
}

function chooseNext(from: i32): i32 {
  const row = from * 4;
  const r = nextF32();
  let acc: f32 = 0.0;
  for (let i = 0; i < 4; i++) {
    acc += transMatrix[row + i];
    if (r <= acc && i != from) return i;
  }
  // Fallback: pick anything that is not the current state.
  let n = pickI32(3);
  if (n >= from) n++;
  return n;
}

function samplePalette(phase: f32): void {
  let i0 = 0;
  for (let i = 0; i < KF_COUNT - 1; i++) {
    if (phase >= kf[i * KF_STRIDE] && phase <= kf[(i + 1) * KF_STRIDE]) {
      i0 = i;
      break;
    }
    i0 = KF_COUNT - 2;
  }
  const i1 = i0 + 1;
  const a = i0 * KF_STRIDE;
  const b = i1 * KF_STRIDE;
  const p0 = kf[a];
  const p1 = kf[b];
  const span = p1 - p0;
  const t: f32 = span > 0.0001 ? smootherstep((phase - p0) / span) : 0.0;

  weather[W_SKY_TOP_R] = lerpf(kf[a + 1], kf[b + 1], t);
  weather[W_SKY_TOP_G] = lerpf(kf[a + 2], kf[b + 2], t);
  weather[W_SKY_TOP_B] = lerpf(kf[a + 3], kf[b + 3], t);
  weather[W_SKY_HORIZON_R] = lerpf(kf[a + 4], kf[b + 4], t);
  weather[W_SKY_HORIZON_G] = lerpf(kf[a + 5], kf[b + 5], t);
  weather[W_SKY_HORIZON_B] = lerpf(kf[a + 6], kf[b + 6], t);
  weather[W_SUN_R] = lerpf(kf[a + 7], kf[b + 7], t);
  weather[W_SUN_G] = lerpf(kf[a + 8], kf[b + 8], t);
  weather[W_SUN_B] = lerpf(kf[a + 9], kf[b + 9], t);

  const ambA = ambPacked[i0];
  const ambB = ambPacked[i1];
  weather[W_AMBIENT_R] = lerpf(f32((ambA >> 16) & 255) / 255.0, f32((ambB >> 16) & 255) / 255.0, t);
  weather[W_AMBIENT_G] = lerpf(f32((ambA >> 8) & 255) / 255.0, f32((ambB >> 8) & 255) / 255.0, t);
  weather[W_AMBIENT_B] = lerpf(f32(ambA & 255) / 255.0, f32(ambB & 255) / 255.0, t);

  weather[W_EXPOSURE] = lerpf(exposureTable[i0], exposureTable[i1], t);
  weather[W_LANTERN] = lerpf(lanternTable[i0], lanternTable[i1], t);
  weather[W_SUN_INTENSITY] = lerpf(sunITable[i0], sunITable[i1], t);
}

/**
 * Advance the atmosphere. `dt` is the fixed simulation step, `altitude` the
 * balloon's height in metres and `scroll` the accumulated world scroll.
 */
export function weatherStep(dt: f32, altitude: f32, scroll: f32): void {
  simTime += dt;

  // ---- time of day (independent of score) ----
  dayPhase += dt / dayLength;
  if (dayPhase >= 1.0) dayPhase -= 1.0;
  weather[W_TIME_OF_DAY] = dayPhase;

  const sunElev = Mathf.sin(TAU * dayPhase);
  weather[W_SUN_ELEVATION] = sunElev;
  weather[W_SUN_AZIMUTH] = Mathf.cos(TAU * dayPhase) * 0.7;
  samplePalette(dayPhase);

  // ---- weather state machine ---------------------------------------------
  // `state` is what we are fading FROM, `nextState` what we are fading TO.
  // The cross-fade is long (9-17 s, smootherstep) and each state then holds
  // for 22-46 s, so the sky is almost always mid-transition somewhere.
  if (blend < 1.0) {
    blend = saturate(blend + dt / blendDuration);
    if (blend >= 1.0) {
      state = nextState;
      holdTimer = rangeF32(22.0, 46.0);
    }
  } else {
    holdTimer -= dt;
    if (holdTimer <= 0.0) {
      nextState = chooseNext(state);
      blend = 0.0;
      blendDuration = rangeF32(9.0, 17.0);
    }
  }
  // Report the dominant state so the UI label matches what the sky looks like.
  weather[W_STATE] = f32(blend > 0.5 ? nextState : state);
  weather[W_STATE_BLEND] = blend;

  const oa = state * STATE_STRIDE;
  const ob = nextState * STATE_STRIDE;
  const t = smootherstep(blend);
  const cover = lerpf(stateTable[oa + 0], stateTable[ob + 0], t);
  const windBase = lerpf(stateTable[oa + 1], stateTable[ob + 1], t);
  const rainBase = lerpf(stateTable[oa + 2], stateTable[ob + 2], t);
  const fogBase = lerpf(stateTable[oa + 3], stateTable[ob + 3], t);
  const storm = lerpf(stateTable[oa + 4], stateTable[ob + 4], t);
  const gustiness = lerpf(stateTable[oa + 5], stateTable[ob + 5], t);

  // ---- wind: sustained + slow wander + sharp gusts ----
  const wander = fbm1(simTime * 0.07 + gustSeed, 3, 91);
  const gustRaw = fbm1(simTime * 0.31 + gustSeed * 1.7, 2, 17);
  const gust: f32 = Mathf.pow(saturate(gustRaw * 1.75 - 0.45), 1.6) * (0.35 + 1.15 * gustiness);
  const wind = saturate(clampf(windBase * (0.72 + 0.56 * wander) + gust * 0.55, 0.0, 1.25));
  weather[W_WIND] = wind;
  weather[W_WIND_GUST] = gust;

  const dirWander = Mathf.sin(simTime * 0.09 + gustSeed) * 0.45 + (fbm1(simTime * 0.05 + 31.0, 2, 7) - 0.5) * 0.9;
  const dir = clampf(dirWander * (0.5 + wind), -1.0, 1.0);
  weather[W_WIND_DIR] = dir;

  // ---- precipitation / fog with organic modulation ----
  const rain = saturate(rainBase * (0.7 + 0.6 * fbm1(simTime * 0.13 + 5.0, 3, 29)) + storm * 0.1);
  weather[W_RAIN] = rain;

  const nightFactor = saturate(0.5 - sunElev * 1.35);
  const altitudeFog = smoothstep(1400.0, 3200.0, altitude) * 0.3;
  const fog = saturate(fogBase * (0.8 + 0.4 * fbm1(simTime * 0.06 + 61.0, 2, 53)) + nightFactor * 0.12 + altitudeFog);
  weather[W_FOG] = fog;

  weather[W_CLOUD_COVER] = saturate(cover * (0.9 + 0.2 * fbm1(simTime * 0.04 + 3.0, 2, 11)));
  weather[W_STORM] = storm;

  // ---- lightning: sparse, double-strike, distance-attenuated ----
  let flash: f32 = 0.0;
  if (storm > 0.02) {
    lightningTimer -= dt;
    if (lightningTimer <= 0.0) {
      lightningElapsed = 0.0;
      lightningTimer = rangeF32(1.6, 9.0) / clampf(storm, 0.15, 1.0);
      thunderEvents += 1.0;
    }
  } else {
    lightningTimer = Mathf.max(lightningTimer, rangeF32(0.5, 1.5));
  }
  if (lightningElapsed < 3.0) {
    lightningElapsed += dt;
    const e = lightningElapsed;
    const decay = Mathf.exp(-e * 5.5);
    const strike2 = Mathf.exp(-Mathf.abs(e - 0.22) * 26.0) * 0.8;
    const strike3 = Mathf.exp(-Mathf.abs(e - 0.41) * 34.0) * 0.45;
    const flicker: f32 = 0.82 + 0.18 * Mathf.sin(e * 91.0);
    flash = saturate((decay + strike2 + strike3) * flicker * (0.35 + 0.85 * storm));
  }
  weather[W_LIGHTNING] = flash;
  weather[W_THUNDER_EVENTS] = thunderEvents;

  // ---- derived lighting terms ----
  const cloudDim: f32 = 1.0 - 0.78 * weather[W_CLOUD_COVER];
  const sunIntensity = weather[W_SUN_INTENSITY] * cloudDim * (0.35 + 0.65 * saturate(sunElev * 2.2 + 0.45));
  weather[W_SUN_INTENSITY] = clampf(sunIntensity + flash * 2.6, 0.0, 4.0);
  weather[W_EXPOSURE] = clampf(weather[W_EXPOSURE] * (1.0 - 0.16 * weather[W_CLOUD_COVER]) + flash * 0.35, 0.35, 2.0);
  weather[W_LANTERN] = saturate(weather[W_LANTERN] * (0.55 + 0.75 * weather[W_CLOUD_COVER]) + nightFactor * 0.25);
  weather[W_STAR_ALPHA] = saturate(nightFactor * 1.35 * (1.0 - weather[W_CLOUD_COVER] * 0.92));
  weather[W_SHADOW_SOFTNESS] = saturate(0.2 + 0.72 * weather[W_CLOUD_COVER] + nightFactor * 0.18);

  // Ambient picks up the lightning flash and the warm/cool bounce of the sky.
  const bounceR = weather[W_SKY_HORIZON_R] * 0.35 + flash * 0.9;
  const bounceG = weather[W_SKY_HORIZON_G] * 0.3 + flash * 0.92;
  const bounceB = weather[W_SKY_HORIZON_B] * 0.4 + flash * 1.0;
  weather[W_AMBIENT_R] = saturate(weather[W_AMBIENT_R] * 0.86 + bounceR * 0.34);
  weather[W_AMBIENT_G] = saturate(weather[W_AMBIENT_G] * 0.86 + bounceG * 0.32);
  weather[W_AMBIENT_B] = saturate(weather[W_AMBIENT_B] * 0.9 + bounceB * 0.36);

  // Fog + cloud tints: sky-coloured, desaturated by cover, lifted by lightning.
  weather[W_FOG_R] = saturate(lerpf(weather[W_SKY_HORIZON_R], weather[W_AMBIENT_R], 0.55) * (1.0 - 0.25 * fog) + flash * 0.8);
  weather[W_FOG_G] = saturate(lerpf(weather[W_SKY_HORIZON_G], weather[W_AMBIENT_G], 0.55) * (1.0 - 0.2 * fog) + flash * 0.82);
  weather[W_FOG_B] = saturate(lerpf(weather[W_SKY_HORIZON_B], weather[W_AMBIENT_B], 0.6) * (1.0 - 0.1 * fog) + flash * 0.9);
  const cloudLift: f32 = 0.55 + 0.45 * saturate(sunElev * 1.6 + 0.3);
  weather[W_CLOUD_R] = saturate(lerpf(weather[W_SKY_HORIZON_R], 1.0, 0.35 * cloudLift) * (1.0 - 0.55 * cover) + flash * 0.9);
  weather[W_CLOUD_G] = saturate(lerpf(weather[W_SKY_HORIZON_G], 1.0, 0.33 * cloudLift) * (1.0 - 0.58 * cover) + flash * 0.9);
  weather[W_CLOUD_B] = saturate(lerpf(weather[W_SKY_TOP_B], 1.0, 0.3 * cloudLift) * (1.0 - 0.5 * cover) + flash * 0.95);

  // ---- difficulty + bookkeeping ----
  const altDifficulty = smoothstep(0.0, 5200.0, altitude);
  weather[W_DIFFICULTY] = saturate(0.08 + altDifficulty * 0.92);
  weather[W_ALTITUDE] = altitude;
  weather[W_SCROLL] = scroll;

  // Keep the ambient term from going fully black at night - the lantern and the
  // moon need something to bounce off.
  weather[W_AMBIENT_R] = Mathf.max(weather[W_AMBIENT_R], 0.075);
  weather[W_AMBIENT_G] = Mathf.max(weather[W_AMBIENT_G], 0.085);
  weather[W_AMBIENT_B] = Mathf.max(weather[W_AMBIENT_B], 0.13);
}

/** Host reads this to know when to trigger a thunder clap. */
export function consumeThunder(): f32 {
  return weather[W_THUNDER_EVENTS];
}

export function weatherTime(): f32 {
  return simTime;
}

/** Frame-rate independent smoothing helper reused by the host-side systems. */
export function approach(current: f32, target: f32, halfLife: f32, dt: f32): f32 {
  return dampf(current, target, halfLife, dt);
}
