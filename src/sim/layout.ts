/**
 * Host-side mirror of the WASM memory contract (wasm/assembly/layout.ts).
 *
 * Keep these two files in lockstep; SimCore asserts `layoutVersion()` at boot
 * so a mismatched binary fails loudly instead of rendering garbage.
 */

export const LAYOUT_VERSION = 7;

// --- weather / time of day --------------------------------------------------
export const W = {
  TIME_OF_DAY: 0,
  SUN_ELEVATION: 1,
  SUN_AZIMUTH: 2,
  CLOUD_COVER: 3,
  WIND: 4,
  WIND_DIR: 5,
  WIND_GUST: 6,
  RAIN: 7,
  FOG: 8,
  LIGHTNING: 9,
  THUNDER_EVENTS: 10,
  SKY_TOP_R: 11,
  SKY_TOP_G: 12,
  SKY_TOP_B: 13,
  SKY_HORIZON_R: 14,
  SKY_HORIZON_G: 15,
  SKY_HORIZON_B: 16,
  SUN_R: 17,
  SUN_G: 18,
  SUN_B: 19,
  AMBIENT_R: 20,
  AMBIENT_G: 21,
  AMBIENT_B: 22,
  EXPOSURE: 23,
  LANTERN: 24,
  STATE: 25,
  STATE_BLEND: 26,
  STORM: 27,
  DIFFICULTY: 28,
  STAR_ALPHA: 29,
  SHADOW_SOFTNESS: 30,
  FOG_R: 31,
  FOG_G: 32,
  FOG_B: 33,
  CLOUD_R: 34,
  CLOUD_G: 35,
  CLOUD_B: 36,
  SUN_INTENSITY: 37,
  ALTITUDE: 38,
  SCROLL: 39,
} as const;

// --- chunk manifest ---------------------------------------------------------
export const O = {
  TYPE: 0,
  X: 1,
  Y: 2,
  W: 3,
  H: 4,
  SPEED: 5,
  ROT: 6,
  DRIFT: 7,
  SWAY: 8,
  PHASE: 9,
  VARIANT: 10,
  VALUE: 11,
} as const;

export const D = {
  TYPE: 0,
  X: 1,
  Y: 2,
  SCALE: 3,
  VARIANT: 4,
  PARALLAX: 5,
  PHASE: 6,
  TINT: 7,
  SPIN: 8,
  LAYER: 9,
} as const;

// --- particles --------------------------------------------------------------
export const P = {
  X: 0,
  Y: 1,
  VX: 2,
  VY: 3,
  LIFE: 4,
  MAX_LIFE: 5,
  SIZE: 6,
  TYPE: 7,
  ROT: 8,
  ALPHA: 9,
  DEPTH: 10,
  SEED: 11,
} as const;

export const OBSTACLE = {
  SPIKE_CLUSTER: 0,
  DEBRIS_PLANK: 1,
  STORM_BARREL: 2,
  ROCK_ISLAND: 3,
  DRIFT_MINE: 4,
  ICE_SHARD: 5,
} as const;

export const DECOR = {
  CLOUD: 0,
  MOUNTAIN_FAR: 1,
  RIDGE_FOREST: 2,
  BIRD: 3,
  STARFIELD: 4,
  ROCK_SPIRE: 5,
  FLOAT_ISLET: 6,
  FOREGROUND_CLOUD: 7,
  TREE_CANOPY: 8,
  RUIN: 9,
} as const;

export const PARTICLE = {
  RAIN: 0,
  MIST: 1,
  WIND_STREAK: 2,
  SPARK: 3,
  EMBER: 4,
  DUST: 5,
  GLOW_MOTE: 6,
} as const;

export const WEATHER_STATE = {
  CALM: 0,
  CLOUDY: 1,
  WINDY: 2,
  STORM: 3,
} as const;

export const WEATHER_STATE_NAME = ["Calm", "Cloudy", "Windy", "Thunderstorm"] as const;

/**
 * World space contract.
 *
 * The viewport is exactly 1.0 world units wide; its height is 1/aspect. Fixing
 * the *width* means the horizontal dodge space - the only axis the player
 * controls - is identical on a phone and on an ultrawide monitor.
 */
export const WORLD_WIDTH = 1;
