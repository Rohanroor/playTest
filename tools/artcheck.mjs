/**
 * Headless art-pipeline verification.
 *
 *   node tools/artcheck.mjs          (also imported by tools/verify.mjs)
 *
 * The sprites, normal maps, atlas and bitmap font are all generated at runtime
 * by TypeScript that never touches the DOM until it uploads to WebGL, so the
 * whole art pipeline can be baked and asserted in Node. That catches the class
 * of bug a browser would otherwise find first: a sprite name referenced by a
 * system but never registered in the atlas (Atlas.region throws), an entity id
 * with no sprite, a glyph missing from the typeface, or an empty normal map.
 *
 * The TS sources are bundled with the esbuild binary Vite already ships, then
 * imported from a data URL, so no build artefacts are written to disk.
 */
import { build } from "esbuild";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

const ENTRY = `
export { Atlas } from "./src/art/Atlas";
export { buildSprites, OBSTACLE_SPRITES, DECOR_SPRITES, PARTICLE_SPRITES } from "./src/art/Sprites";
export { Font, buildFontAtlas } from "./src/art/Font";
export { DECOR, OBSTACLE, PARTICLE } from "./src/sim/layout";
`;

/** Every .ts file under a directory (recursive). */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

async function loadArt(root) {
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: "ts", sourcefile: "artcheck-entry.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node18",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return import(url);
}

/**
 * @param {{check: (label: string, ok: boolean, extra?: string) => void}} reporter
 */
export async function runArtChecks({ check, root = DEFAULT_ROOT }) {
  const art = await loadArt(root);

  // --- bake ------------------------------------------------------------------
  const atlas = new art.Atlas(1024);
  let bakeError = null;
  let data = null;
  try {
    art.buildSprites(atlas);
    art.buildFontAtlas(atlas);
    data = atlas.bake();
  } catch (err) {
    bakeError = err instanceof Error ? err.message : String(err);
  }
  check("atlas bakes without error", bakeError === null, bakeError ? `(${bakeError})` : "");
  if (!data) return;

  const regions = atlas.names;
  const usage = atlas.usage(data);
  check(
    "all sprites packed",
    regions.length > 0 && data.size <= 2048 && usage < 1,
    `(${regions.length} regions, ${data.size}px atlas, ${(usage * 100).toFixed(1)}% full)`,
  );

  // --- sprite name coverage --------------------------------------------------
  const missing = [];
  const referenced = [];
  for (const [label, map] of [
    ["obstacle", art.OBSTACLE_SPRITES],
    ["decor", art.DECOR_SPRITES],
  ]) {
    for (const [id, names] of Object.entries(map)) {
      for (const n of names) {
        referenced.push(`${label}[${id}]:${n}`);
        if (!atlas.has(n)) missing.push(`${label}[${id}] -> "${n}"`);
      }
    }
  }
  for (const [id, n] of Object.entries(art.PARTICLE_SPRITES)) {
    referenced.push(`particle[${id}]:${n}`);
    if (!atlas.has(n)) missing.push(`particle[${id}] -> "${n}"`);
  }
  check("sprite maps reference baked regions", missing.length === 0, missing.length ? `(${missing.slice(0, 6).join(", ")})` : `(${referenced.length} refs)`);

  // Every entity id the simulation can emit must have art behind it.
  const uncovered = [];
  for (const [label, ids, map] of [
    ["OBSTACLE", art.OBSTACLE, art.OBSTACLE_SPRITES],
    ["DECOR", art.DECOR, art.DECOR_SPRITES],
    ["PARTICLE", art.PARTICLE, art.PARTICLE_SPRITES],
  ]) {
    for (const [name, id] of Object.entries(ids)) {
      const entry = map[id];
      const ok = Array.isArray(entry) ? entry.length > 0 : typeof entry === "string" && entry.length > 0;
      if (!ok) uncovered.push(`${label}.${name}(${id})`);
    }
  }
  check("every entity id has a sprite", uncovered.length === 0, uncovered.length ? `(${uncovered.join(", ")})` : "");

  // --- literal region lookups in the host code -------------------------------
  const files = walk(join(root, "src"));
  const literalNames = new Set();
  const regionRe = /\.region\(\s*"([^"]+)"\s*\)/g;
  const uiSpriteRe = /\bsprite\(\s*[^,]+,\s*"([^"]+)"/g;
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(regionRe)) literalNames.add(m[1]);
    for (const m of src.matchAll(uiSpriteRe)) literalNames.add(m[1]);
  }
  const badLiterals = [...literalNames].filter((n) => !atlas.has(n)).sort();
  check(
    "every literal atlas lookup resolves",
    badLiterals.length === 0,
    badLiterals.length ? `(${badLiterals.join(", ")})` : `(${literalNames.size} names)`,
  );

  // --- font ------------------------------------------------------------------
  const font = new art.Font(atlas.region("font"), data.size, art.Font.chars);
  const chars = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  const uiFiles = files.filter((f) => /UIManager\.ts$|Game\.ts$/.test(f));
  let textLiterals = 0;
  for (const f of uiFiles) {
    const src = readFileSync(f, "utf8");
    // Only literals handed to the bitmap-font renderer (not atlas region names).
    for (const m of src.matchAll(/\btext\(\s*\w+\s*,\s*"([^"]*)"/g)) {
      textLiterals++;
      for (const ch of m[1]) chars.add(ch);
    }
  }
  const noGlyph = [...chars].filter((ch) => ch !== "\n" && ch !== "\t" && !font.glyph(ch)).sort();
  check(
    "typeface covers every UI character",
    noGlyph.length === 0 && textLiterals > 0,
    noGlyph.length
      ? `(missing ${JSON.stringify(noGlyph.join(""))})`
      : `(${chars.size} chars from ${textLiterals} strings)`,
  );
  check("font metrics are usable", font.measure("BEST", 2) > 0 && font.glyph("A") !== undefined);

  // --- texture payloads ------------------------------------------------------
  const { color, material, size } = data;
  let painted = 0;
  let sampled = 0;
  let flat = 0;
  let glowingRegions = 0;
  const step = 2; // every other texel: plenty of signal, a fraction of the cost
  for (const name of regions) {
    const r = atlas.region(name);
    let lit = 0;
    let seen = 0;
    for (let y = r.y; y < r.y + r.h; y += step) {
      for (let x = r.x; x < r.x + r.w; x += step) {
        const o = (y * size + x) * 4;
        seen++;
        if (color[o + 3] > 0) painted++;
        if (material[o + 3] > 0) lit++;
        // A texel whose normal is exactly (0.5, 0.5, 1) contributed no relief.
        if (material[o] === 128 && material[o + 1] === 128 && material[o + 2] === 255) flat++;
      }
    }
    sampled += seen;
    if (seen > 0 && lit / seen > 0.02) glowingRegions++;
  }
  check("albedo texels painted", painted / sampled > 0.25, `(${((painted / sampled) * 100).toFixed(1)}% of sprite area)`);
  check("normal maps carry relief", flat / sampled < 0.6, `(${((1 - flat / sampled) * 100).toFixed(1)}% of texels displaced)`);
  check("emissive mask generated", glowingRegions >= 6, `(${glowingRegions}/${regions.length} sprites glow)`);
}

// --- standalone --------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let checks = 0;
  let failures = 0;
  const check = (label, ok, extra = "") => {
    checks++;
    if (!ok) {
      failures++;
      console.error(`  \u2717 ${label} ${extra}`);
    } else {
      console.log(`  \u2713 ${label} ${extra}`);
    }
  };
  console.log("\n[art]");
  try {
    await runArtChecks({ check });
  } catch (err) {
    failures++;
    console.error("  \u2717 art pipeline threw:", err instanceof Error ? err.stack : err);
  }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} art checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}
