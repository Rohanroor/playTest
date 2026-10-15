/**
 * Headless GLSL lint.
 *
 *   node tools/shadercheck.mjs       (also imported by tools/verify.mjs)
 *
 * A shader that fails to compile is the single most likely way this game shows a
 * black screen, and CI has no GL driver to catch it. These checks cover the
 * failure modes that are actually mechanical:
 *
 *   - WebGL1 leftovers (`gl_FragColor`, `texture2D`, `varying`, `attribute`)
 *     which are hard errors under `#version 300 es`
 *   - a missing `#version` line or missing float precision in a fragment shader
 *   - varyings a fragment shader reads but its vertex shader never writes
 *   - identifiers used as `uSomething` with no matching `uniform` declaration
 *   - unbalanced braces (a truncated template literal)
 *   - the instanced attribute layout drifting between GLSL and SpriteBatch
 *
 * Shader *semantics* still need a real driver; `GL.annotate()` exists for that
 * case and prints the offending line into the boot overlay.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, "..");

/** Which vertex shader each fragment shader is linked against (see Pipeline). */
const PAIRS = [
  ["SPRITE_FS", "SPRITE_VS"],
  ["SKY_FS", "FULLSCREEN_VS"],
  ["FOG_FS", "FULLSCREEN_VS"],
  ["BRIGHT_FS", "FULLSCREEN_VS"],
  ["BLUR_FS", "FULLSCREEN_VS"],
  ["BLOOM_DOWN_FS", "FULLSCREEN_VS"],
  ["BLOOM_UP_FS", "FULLSCREEN_VS"],
  ["COMPOSITE_FS", "FULLSCREEN_VS"],
];

const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^\s*(uniform|in|out|layout\([^)]*\)\s*in)\s+[^;]+;/gm, "");

function declaredUniforms(src) {
  return new Set([...src.matchAll(/uniform\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/g)].map((m) => m[1]));
}
function ioNames(src, kind) {
  return new Set([...src.matchAll(new RegExp(`^\\s*(?:layout\\([^)]*\\)\\s*)?${kind}\\s+\\w+\\s+(\\w+)\\s*;`, "gm"))].map((m) => m[1]));
}

async function loadShaders(root) {
  const result = await build({
    stdin: {
      contents: 'export * from "./src/render/shaders";',
      resolveDir: root,
      loader: "ts",
      sourcefile: "shadercheck-entry.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node18",
    logLevel: "silent",
  });
  const url = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
  return import(url);
}

/**
 * @param {{check: (label: string, ok: boolean, extra?: string) => void}} reporter
 */
export async function runShaderChecks({ check, root = DEFAULT_ROOT }) {
  const shaders = await loadShaders(root);
  const names = Object.keys(shaders).filter((k) => /_(VS|FS)$/.test(k) || k === "NOISE_GLSL");
  check("shader sources exported", names.length >= 9, `(${names.length}: ${names.join(", ")})`);

  // --- per-shader hygiene ----------------------------------------------------
  const webgl1 = [];
  const noVersion = [];
  const noPrecision = [];
  const unbalanced = [];
  const undeclaredUniforms = [];
  for (const name of names.filter((n) => n !== "NOISE_GLSL")) {
    const src = shaders[name];
    if (!src.startsWith("#version 300 es")) noVersion.push(name);
    if (/[^\w](gl_FragColor|texture2D\s*\(|textureCube\s*\()[^\w]?/.test(src) || /^\s*(varying|attribute)\s/m.test(src)) {
      webgl1.push(name);
    }
    if (name.endsWith("_FS") && !/precision\s+(highp|mediump|lowp)\s+float\s*;/.test(src)) noPrecision.push(name);
    const opens = (src.match(/\{/g) ?? []).length;
    const closes = (src.match(/\}/g) ?? []).length;
    if (opens !== closes) unbalanced.push(`${name} (${opens}/{closes})`);

    const declared = declaredUniforms(src);
    const body = strip(src);
    for (const m of body.matchAll(/\bu[A-Z]\w*\b/g)) {
      if (!declared.has(m[0])) undeclaredUniforms.push(`${name}:${m[0]}`);
    }
  }
  check("every shader declares #version 300 es", noVersion.length === 0, noVersion.length ? `(${noVersion.join(", ")})` : "");
  check("no WebGL1 leftovers", webgl1.length === 0, webgl1.length ? `(${webgl1.join(", ")})` : "(no gl_FragColor / texture2D / varying / attribute)");
  check("fragment shaders declare float precision", noPrecision.length === 0, noPrecision.length ? `(${noPrecision.join(", ")})` : "");
  check("shader braces balance", unbalanced.length === 0, unbalanced.length ? `(${unbalanced.join(", ")})` : "");
  check(
    "every uXxx identifier is a declared uniform",
    undeclaredUniforms.length === 0,
    undeclaredUniforms.length ? `(${[...new Set(undeclaredUniforms)].slice(0, 8).join(", ")})` : "",
  );

  // --- varyings must be written by the paired vertex shader ------------------
  const dangling = [];
  let varyingCount = 0;
  for (const [fs, vs] of PAIRS) {
    if (!(fs in shaders) || !(vs in shaders)) {
      dangling.push(`${fs}: missing ${vs}`);
      continue;
    }
    const outs = ioNames(shaders[vs], "out");
    for (const name of ioNames(shaders[fs], "in")) {
      varyingCount++;
      if (!outs.has(name)) dangling.push(`${fs} reads ${name}, ${vs} never writes it`);
    }
  }
  check(
    "varyings are written by their vertex shader",
    dangling.length === 0,
    dangling.length ? `(${dangling.join("; ")})` : `(${varyingCount} varyings across ${PAIRS.length} programs)`,
  );

  // --- the instanced attribute layout must agree with SpriteBatch ------------
  const batchSrc = readFileSync(join(root, "src", "render", "SpriteBatch.ts"), "utf8");
  const instanceFloats = Number(/INSTANCE_FLOATS\s*=\s*(\d+)/.exec(batchSrc)?.[1] ?? 0);
  const glSizes = { float: 1, vec2: 2, vec3: 3, vec4: 4, mat2: 4, mat3: 9, mat4: 16 };
  const glslAttribs = [...shaders.SPRITE_VS.matchAll(/layout\(location\s*=\s*(\d+)\)\s*in\s+(\w+)\s+(\w+)\s*;/g)].map((m) => ({
    location: Number(m[1]),
    type: m[2],
    name: m[3],
    size: glSizes[m[2]] ?? 0,
  }));
  // SpriteBatch: the static quad at location 0, then the instance tuples.
  const quad = /vertexAttribPointer\(\s*0\s*,\s*(\d+)/.exec(batchSrc);
  const tuples = [...batchSrc.matchAll(/\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\],\s*\/\/\s*(\w+)/g)].map((m) => ({
    location: Number(m[1]),
    size: Number(m[2]),
    offset: Number(m[3]),
    name: m[4],
  }));
  const batchAttribs = [...(quad ? [{ location: 0, size: Number(quad[1]), offset: 0, name: "aCorner" }] : []), ...tuples];

  const mismatched = [];
  for (const a of batchAttribs) {
    const g = glslAttribs.find((x) => x.location === a.location);
    if (!g) mismatched.push(`location ${a.location} (${a.name}) is not declared in SPRITE_VS`);
    else if (g.size !== a.size) mismatched.push(`location ${a.location}: GLSL ${g.type} (${g.size}) vs batch size ${a.size}`);
  }
  for (const g of glslAttribs) {
    if (!batchAttribs.some((a) => a.location === g.location)) mismatched.push(`GLSL location ${g.location} (${g.name}) is never bound`);
  }
  check(
    "instanced attribute layout matches SpriteBatch",
    mismatched.length === 0 && instanceFloats > 0,
    mismatched.length ? `(${mismatched.join("; ")})` : `(${glslAttribs.length} attributes, locations ${glslAttribs.map((a) => a.location).join("/")})`,
  );

  // Offsets must tile the instance struct exactly, with no gaps or overlaps.
  const instance = tuples.slice().sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  const gaps = [];
  for (const t of instance) {
    if (t.offset !== cursor) gaps.push(`${t.name} at ${t.offset}, expected ${cursor}`);
    cursor = t.offset + t.size * 4;
  }
  check(
    "instance stride tiles without gaps",
    gaps.length === 0 && cursor === instanceFloats * 4,
    gaps.length ? `(${gaps.join("; ")})` : `(${cursor} bytes = ${instanceFloats} floats)`,
  );
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
  console.log("\n[shaders]");
  try {
    await runShaderChecks({ check });
  } catch (err) {
    failures++;
    console.error("  \u2717 shader lint threw:", err instanceof Error ? err.stack : err);
  }
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} shader checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}
