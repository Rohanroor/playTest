/**
 * Shared memory-layout contract between the WASM simulation core and the
 * TypeScript host. The host mirrors these constants in src/sim/layout.ts and
 * asserts `layoutVersion()` at boot, so a stale binary can never be silently
 * misread.
 *
 * All buffers are flat Float32Arrays living in WASM linear memory. The host
 * reads them through zero-copy typed-array views - no marshalling, no GC churn.
 */

export const LAYOUT_VERSION: i32 = 7;

// --- Weather / time-of-day state -------------------------------------------
export const WEATHER_STRIDE: i32 = 40;
export const W_TIME_OF_DAY: i32 = 0; // 0..1 (0 = dawn, .25 = noon, .5 = dusk, .75 = midnight)
export const W_SUN_ELEVATION: i32 = 1; // -1..1
export const W_SUN_AZIMUTH: i32 = 2; // -1..1, drives shadow direction
export const W_CLOUD_COVER: i32 = 3; // 0..1
export const W_WIND: i32 = 4; // 0..1 sustained
export const W_WIND_DIR: i32 = 5; // -1..1 screen-space
export const W_WIND_GUST: i32 = 6; // 0..1.6 instantaneous
export const W_RAIN: i32 = 7; // 0..1
export const W_FOG: i32 = 8; // 0..1
export const W_LIGHTNING: i32 = 9; // 0..1 instantaneous flash energy
export const W_THUNDER_EVENTS: i32 = 10; // monotonic counter; host diffs it
export const W_SKY_TOP_R: i32 = 11;
export const W_SKY_TOP_G: i32 = 12;
export const W_SKY_TOP_B: i32 = 13;
export const W_SKY_HORIZON_R: i32 = 14;
export const W_SKY_HORIZON_G: i32 = 15;
export const W_SKY_HORIZON_B: i32 = 16;
export const W_SUN_R: i32 = 17;
export const W_SUN_G: i32 = 18;
export const W_SUN_B: i32 = 19;
export const W_AMBIENT_R: i32 = 20;
export const W_AMBIENT_G: i32 = 21;
export const W_AMBIENT_B: i32 = 22;
export const W_EXPOSURE: i32 = 23;
export const W_LANTERN: i32 = 24; // 0 day -> 1 deep night
export const W_STATE: i32 = 25; // WeatherState enum
export const W_STATE_BLEND: i32 = 26; // 0..1 progress toward the target state
export const W_STORM: i32 = 27; // 0..1 storm energy
export const W_DIFFICULTY: i32 = 28; // 0..1 derived from altitude
export const W_STAR_ALPHA: i32 = 29;
export const W_SHADOW_SOFTNESS: i32 = 30;
export const W_FOG_R: i32 = 31;
export const W_FOG_G: i32 = 32;
export const W_FOG_B: i32 = 33;
export const W_CLOUD_R: i32 = 34;
export const W_CLOUD_G: i32 = 35;
export const W_CLOUD_B: i32 = 36;
export const W_SUN_INTENSITY: i32 = 37;
export const W_ALTITUDE: i32 = 38; // metres, monotonic
export const W_SCROLL: i32 = 39; // accumulated world scroll in world units

/**
 * Units for the chunk manifest: X, W and H are world units, and the world is
 * normalised so the viewport is exactly 1.0 world unit wide (height = 1/aspect).
 * Y is a fraction of CHUNK_HEIGHT. Because W and H share the same unit, sprites
 * never get squashed on ultrawide or portrait screens.
 */

// --- Chunk manifest: obstacles ---------------------------------------------
export const OBSTACLE_STRIDE: i32 = 12;
export const MAX_OBSTACLES_PER_CHUNK: i32 = 14;
export const O_TYPE: i32 = 0;
export const O_X: i32 = 1; // world units, 0..1 across the viewport
export const O_Y: i32 = 2; // 0..1 within the chunk (0 = chunk top)
export const O_W: i32 = 3; // world units (same scale as X)
export const O_H: i32 = 4; // world units (same scale as X)
export const O_SPEED: i32 = 5; // multiplier on world scroll speed
export const O_ROT: i32 = 6;
export const O_DRIFT: i32 = 7; // constant horizontal velocity (world units/s)
export const O_SWAY: i32 = 8; // sinusoidal sway amplitude
export const O_PHASE: i32 = 9;
export const O_VARIANT: i32 = 10;
export const O_VALUE: i32 = 11; // score bonus / mass for knockback

// --- Chunk manifest: background & foreground decor --------------------------
export const DECOR_STRIDE: i32 = 10;
export const MAX_DECOR_PER_CHUNK: i32 = 30;
export const D_TYPE: i32 = 0;
export const D_X: i32 = 1;
export const D_Y: i32 = 2;
export const D_SCALE: i32 = 3;
export const D_VARIANT: i32 = 4;
export const D_PARALLAX: i32 = 5; // depth factor (0.05 far .. 2.2 near)
export const D_PHASE: i32 = 6;
export const D_TINT: i32 = 7; // palette index
export const D_SPIN: i32 = 8;
export const D_LAYER: i32 = 9; // 0 far, 1 mid, 2 near, 3 foreground

// --- Particles --------------------------------------------------------------
export const PARTICLE_STRIDE: i32 = 12;
export const MAX_PARTICLES: i32 = 3072;
export const P_X: i32 = 0;
export const P_Y: i32 = 1;
export const P_VX: i32 = 2;
export const P_VY: i32 = 3;
export const P_LIFE: i32 = 4;
export const P_MAX_LIFE: i32 = 5;
export const P_SIZE: i32 = 6;
export const P_TYPE: i32 = 7;
export const P_ROT: i32 = 8;
export const P_ALPHA: i32 = 9;
export const P_DEPTH: i32 = 10; // parallax factor for this particle
export const P_SEED: i32 = 11;

// --- Enumerations (mirrored on the host) ------------------------------------
export const OB_SPIKE_CLUSTER: f32 = 0;
export const OB_DEBRIS_PLANK: f32 = 1;
export const OB_STORM_BARREL: f32 = 2;
export const OB_ROCK_ISLAND: f32 = 3;
export const OB_DRIFT_MINE: f32 = 4;
export const OB_ICE_SHARD: f32 = 5;

export const DC_CLOUD: f32 = 0;
export const DC_MOUNTAIN_FAR: f32 = 1;
export const DC_RIDGE_FOREST: f32 = 2;
export const DC_BIRD: f32 = 3;
export const DC_STARFIELD: f32 = 4;
export const DC_ROCK_SPIRE: f32 = 5;
export const DC_FLOAT_ISLET: f32 = 6;
export const DC_FOREGROUND_CLOUD: f32 = 7;
export const DC_TREE_CANOPY: f32 = 8;
export const DC_RUIN: f32 = 9;

export const PT_RAIN: f32 = 0;
export const PT_MIST: f32 = 1;
export const PT_WIND_STREAK: f32 = 2;
export const PT_SPARK: f32 = 3;
export const PT_EMBER: f32 = 4;
export const PT_DUST: f32 = 5;
export const PT_GLOW_MOTE: f32 = 6;

export const WS_CALM: i32 = 0;
export const WS_CLOUDY: i32 = 1;
export const WS_WINDY: i32 = 2;
export const WS_STORM: i32 = 3;
