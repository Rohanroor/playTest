#!/usr/bin/env node
/**
 * Headless verification of the simulation core + built web assets.
 *
 *   node tools/verify.mjs
 *
 * Instantiates public/wasm/sim.wasm, drives weather / chunks / particles for a
 * simulated 3-minute run and asserts the invariants the renderer depends on:
 * finite values, sane ranges, pool bounds, chunk fairness and no growth in
 * live particle count once the pool is saturated.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasmPath = join(root, "public", "wasm", "sim.wasm");

let failures = 0;
let checks = 0;
function check(label, ok, extra = "") {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  ✗ ${label} ${extra}`);
  } else {
    console.log(`  ✓ ${label} ${extra}`);
  }
}

if (!existsSync(wasmPath)) {
  console.error("sim.wasm missing - run `npm run wasm` first.");
  process.exit(1);
}

const bytes = readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {
  env: { abort: () => { throw new Error("wasm abort"); } },
});
const e = instance.exports;
console.log(`\n[sim] ${wasmPath.replace(root + "/", "")} ${(bytes.length / 1024).toFixed(1)} KB, ${Object.keys(e).length} exports`);

// AssemblyScript modules with a runtime must be initialised before use.
if (typeof e._initialize === "function") e._initialize();
else if (typeof e._start === "function") e._start();

check("memory exported", e.memory instanceof WebAssembly.Memory);
check("layout version matches host contract", e.layoutVersion() === 7, `(got ${e.layoutVersion()})`);

const mem = () => e.memory.buffer;
const weather = () => new Float32Array(mem(), e.weatherPtr(), e.weatherStride());

e.simInit(1337);

// --- weather / day-night ----------------------------------------------------
const DT = 1 / 60;
let minExposure = 9, maxExposure = -9, minSun = 9, maxSun = -9, flashes = 0, states = new Set();
let prevThunder = e.simThunderEvents();
let thunder = 0;
let nan = 0;
const phases = new Set();
let altitude = 0;
let scroll = 0;

// Simulate 6 minutes (1.5 full day cycles at dayLength=240s).
for (let i = 0; i < 60 * 360; i++) {
  altitude += 26 * DT;
  scroll += 1.6 * DT;
  e.simWeatherStep(DT, altitude, scroll);
  const w = weather();
  for (let k = 0; k < w.length; k++) if (!Number.isFinite(w[k])) nan++;
  minExposure = Math.min(minExposure, w[23]);
  maxExposure = Math.max(maxExposure, w[23]);
  minSun = Math.min(minSun, w[1]);
  maxSun = Math.max(maxSun, w[1]);
  if (w[9] > 0.4) flashes++;
  states.add(Math.round(w[25]));
  phases.add(Math.round(w[0] * 24) / 24);
  const th = e.simThunderEvents();
  if (th > prevThunder) thunder += th - prevThunder;
  prevThunder = th;
}
const w = weather();
check("weather buffer is finite", nan === 0, `(${nan} non-finite slots)`);
check("day/night cycle completes", maxSun > 0.9 && minSun < -0.9, `(sun ${minSun.toFixed(2)}..${maxSun.toFixed(2)})`);
check("time of day wraps", w[0] >= 0 && w[0] < 1, `(phase=${w[0].toFixed(3)})`);
check("exposure stays in range", minExposure > 0.3 && maxExposure < 2.1, `(${minExposure.toFixed(2)}..${maxExposure.toFixed(2)})`);
check("all 4 weather states visited", states.size === 4, `(${[...states].sort().join(",")})`);
check("lightning fires in storms", flashes > 0, `(${flashes} bright frames)`);
check("thunder events counted", thunder > 0, `(${thunder} claps)`);
check("sky palette is lit", w[11] + w[12] + w[13] > 0.02, `(top rgb ${w[11].toFixed(2)},${w[12].toFixed(2)},${w[13].toFixed(2)})`);
check("wind bounded", w[4] >= 0 && w[4] <= 1.3, `(${w[4].toFixed(3)})`);

// --- chunk generation: playability (reachability) --------------------------
// For each chunk we rasterise the obstacles onto a grid and flood-fill the
// player's reachable cells row by row, respecting a conservative lateral speed.
// A chunk is fair iff the player can travel from the first row to the last.
const ROWS = 48, COLS = 100;
const PLAYER_HALF = 0.09; // normalised collision half width (matches WASM core)
const LATERAL_PER_ROW = (0.6 * (1 / ROWS)) / 0.5; // playerSpeed * rowTime / scrollSpeed
const LAT_COLS = Math.max(1, Math.ceil(LATERAL_PER_ROW * COLS));
const OS = e.obstacleStride();

let totalObstacles = 0, chunks = 0, badSizes = 0, impassable = [];
let maxObs = 0;
for (let c = 0; c < 400; c++) {
  const diff = Math.min(1, c / 300);
  e.simGenerateChunk(c, diff, w[4], w[3], w[27]);
  const n = e.simObstacleCount();
  const buf = new Float32Array(mem(), e.obstaclePtr(), n * OS);
  chunks++;
  totalObstacles += n;
  maxObs = Math.max(maxObs, n);

  const free = new Uint8Array(ROWS * COLS).fill(1);
  for (let i = 0; i < n; i++) {
    const ox = buf[i * OS + 1], oy = buf[i * OS + 2];
    const ow = buf[i * OS + 3], oh = buf[i * OS + 4];
    const sway = buf[i * OS + 8], drift = buf[i * OS + 7];
    if (!Number.isFinite(ox) || ow <= 0 || ow > 0.9 || oh <= 0 || oh > 0.9) badSizes++;
    // inflate the obstacle by the player's radius + its wander envelope
    const hx = ow / 2 + PLAYER_HALF + Math.abs(sway) + Math.abs(drift) * 0.6;
    const hy = oh / 2 + 0.1; // player half-height in world units
    for (let r = 0; r < ROWS; r++) {
      const cy = (r + 0.5) / ROWS;
      if (Math.abs(cy - oy) > hy) continue;
      for (let col = 0; col < COLS; col++) {
        const cx = (col + 0.5) / COLS;
        if (Math.abs(cx - ox) <= hx) free[r * COLS + col] = 0;
      }
    }
  }

  let reach = new Uint8Array(COLS);
  for (let col = 0; col < COLS; col++) reach[col] = free[col];
  for (let r = 1; r < ROWS; r++) {
    const next = new Uint8Array(COLS);
    for (let col = 0; col < COLS; col++) {
      if (!reach[col]) continue;
      const lo = Math.max(0, col - LAT_COLS), hi = Math.min(COLS - 1, col + LAT_COLS);
      for (let k = lo; k <= hi; k++) if (free[r * COLS + k]) next[k] = 1;
    }
    reach = next;
  }
  let survived = 0;
  for (let col = 0; col < COLS; col++) survived += reach[col];
  if (survived === 0) impassable.push({ chunk: c, difficulty: +diff.toFixed(2), obstacles: n });
}
check("chunks generated", chunks === 400 && totalObstacles > 400, `(${totalObstacles} obstacles, max ${maxObs}/chunk)`);
check("obstacle sizes sane", badSizes === 0, `(${badSizes} bad)`);
check("every chunk is survivable", impassable.length === 0,
  impassable.length ? `(failed: ${JSON.stringify(impassable.slice(0, 4))}${impassable.length > 4 ? ` +${impassable.length - 4} more` : ""})` : "(400/400 reachable)");

// --- determinism ------------------------------------------------------------
function chunkFingerprint(idx) {
  e.simInit(4242);
  e.simGenerateChunk(idx, 0.5, 0.3, 0.5, 0.2);
  const n = e.simObstacleCount();
  const buf = new Float32Array(mem(), e.obstaclePtr(), n * e.obstacleStride());
  return Array.from(buf).map((v) => v.toFixed(6)).join("|");
}
check("same seed => same chunk", chunkFingerprint(17) === chunkFingerprint(17));

// Particles, bursts and host-side cosmetic dice run on a separate FX stream, so
// no amount of visual churn may re-author the level. (Weather shares the world
// stream on purpose: it is stepped at a fixed 60 Hz and is part of the timeline
// a seed replays.)
function fingerprintWithChurn(idx, churn) {
  e.simInit(4242);
  if (churn) {
    for (let i = 0; i < 500; i++) e.simFxRandom();
    for (let i = 0; i < 900; i++) e.simParticlesStep(1 / 60, 1, 0.5625, 0.9, 0.2, 1, 0.6, 0.3, 0.05, 0.8, 0.2);
    for (let i = 0; i < 40; i++) e.simEmitBurst(0.5, 0.3, 30, 3, 1.0, 1.2, 0.6, 0.01);
    for (let i = 0; i < 500; i++) e.simFxRandom();
  }
  e.simGenerateChunk(idx, 0.5, 0.3, 0.5, 0.2);
  const n = e.simObstacleCount();
  const buf = new Float32Array(mem(), e.obstaclePtr(), n * e.obstacleStride());
  return Array.from(buf).map((v) => v.toFixed(6)).join("|");
}
check("cosmetic churn cannot re-author the world", fingerprintWithChurn(23, false) === fingerprintWithChurn(23, true));

const fxDice = [];
e.simInit(5150);
for (let i = 0; i < 5; i++) fxDice.push(e.simFxRandom());
check(
  "fx stream is seeded and varied",
  fxDice.every((v) => v >= 0 && v < 1) && new Set(fxDice.map((v) => v.toFixed(6))).size === 5,
  `(${fxDice.slice(0, 3).map((v) => v.toFixed(4)).join(", ")} ...)`,
);
e.simInit(5150);
const worldDice = [e.simRandom(), e.simRandom()];
check("world and fx streams are decorrelated", Math.abs(worldDice[0] - fxDice[0]) > 1e-6 && Math.abs(worldDice[1] - fxDice[1]) > 1e-6);

// --- particles --------------------------------------------------------------
e.simInit(99);
e.simForceWeather(3); // thunderstorm
let peak = 0;
for (let i = 0; i < 60 * 40; i++) {
  e.simWeatherStep(DT, 800 + i * 0.4, i * 0.03);
  const ww = weather();
  e.simParticlesStep(DT, 1.0, 1 / 1.7778, ww[4], ww[5], ww[7], ww[8], 1.6, 0.0, ww[9], Math.max(0, 0.5 - ww[1] * 1.35));
  peak = Math.max(peak, e.simParticleCount());
}
const cap = e.particleCapacity();
const pb = new Float32Array(mem(), e.particlePtr(), e.simParticleCount() * e.particleStride());
let pnan = 0;
for (let k = 0; k < pb.length; k++) if (!Number.isFinite(pb[k])) pnan++;
check("particles emitted in storm", peak > 800, `(peak ${peak} / cap ${cap})`);
check("particle pool never overflows", peak <= cap, `(peak ${peak})`);
check("particle data finite", pnan === 0);

e.simEmitBurst(0.5, 0.5, 40, 3, 1.0, 1.4, 0.6, 0.03);
const afterBurst = e.simParticleCount();
check("burst emitter works", afterBurst > 0);

// --- asset / build sanity ---------------------------------------------------
console.log("\n[assets]");
for (const f of ["index.html", "package.json", "vite.config.ts", "wasm/asconfig.json", ".github/workflows/ci.yml"]) {
  check(f, existsSync(join(root, f)));
}
if (existsSync(join(root, "dist"))) {
  const distFiles = statSync(join(root, "dist"));
  check("dist built", distFiles.isDirectory(), `(${(statSync(join(root, "dist", "index.html")).size / 1024).toFixed(1)} KB index.html)`);
  check("dist contains wasm", existsSync(join(root, "dist", "wasm", "sim.wasm")));
}

// --- GLSL lint (no driver in CI, so catch the mechanical failures) ----------
console.log("\n[shaders]");
try {
  const { runShaderChecks } = await import("./shadercheck.mjs");
  await runShaderChecks({ check, root });
} catch (err) {
  check("shader lint runs", false, `(${err instanceof Error ? err.message : String(err)})`);
}

// --- art pipeline (baked headlessly: sprites, normals, atlas, typeface) -----
console.log("\n[art]");
try {
  const { runArtChecks } = await import("./artcheck.mjs");
  await runArtChecks({ check, root });
} catch (err) {
  check("art pipeline runs", false, `(${err instanceof Error ? err.message : String(err)})`);
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
