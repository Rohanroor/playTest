#!/usr/bin/env node
/**
 * Builds the AssemblyScript simulation core into a real WebAssembly binary.
 *
 *   node wasm/build.mjs            -> public/wasm/sim.wasm   (optimized, shipped)
 *   node wasm/build.mjs --debug    -> wasm/build/sim.debug.wasm
 *   node wasm/build.mjs --watch    -> rebuild on change
 *
 * The emitted module is loaded at runtime by src/sim/SimCore.ts. Keeping the
 * artifact out of git (see .gitignore) means CI always rebuilds from source.
 */
import { spawn } from "node:child_process";
import { mkdirSync, statSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const debug = args.includes("--debug");
const watching = args.includes("--watch");

mkdirSync(join(here, "build"), { recursive: true });
mkdirSync(join(root, "public", "wasm"), { recursive: true });

const ascMain = join(root, "node_modules", "assemblyscript", "bin", "asc.js");

function build() {
  return new Promise((ok, fail) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [ascMain, "assembly/index.ts", "--config", join(here, "asconfig.json"), "--target", debug ? "debug" : "release"],
      { cwd: here, stdio: "inherit" },
    );
    child.on("error", fail);
    child.on("exit", (code) => {
      if (code !== 0) return fail(new Error(`asc exited with code ${code}`));
      const out = debug ? join(here, "build", "sim.debug.wasm") : join(root, "public", "wasm", "sim.wasm");
      let bytes = 0;
      try {
        bytes = statSync(out).size;
      } catch {
        /* stat is best-effort */
      }
      console.log(`[wasm] built ${out.replace(root + "/", "")} (${(bytes / 1024).toFixed(1)} KB) in ${Date.now() - started}ms`);
      ok();
    });
  });
}

await build();

if (watching) {
  let timer = null;
  let running = false;
  watch(join(here, "assembly"), { recursive: true }, () => {
    if (running) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      running = true;
      try {
        await build();
      } catch (err) {
        console.error("[wasm] rebuild failed:", err.message);
      }
      running = false;
    }, 120);
  });
  console.log("[wasm] watching wasm/assembly for changes…");
}
