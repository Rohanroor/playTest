#!/usr/bin/env node
/**
 * Headless integration test: boots the real game (WASM core + generated art +
 * WebGL renderer + every system) inside a mock DOM/WebGL2 context and plays it
 * for ~30 simulated seconds.
 *
 *   node tools/headless.mjs
 *
 * No browser is available in CI, so this is the safety net that stands in for
 * one. It catches the failures that a clean typecheck cannot see:
 *
 *   - ABI drift: an export declared in SimCore but missing from the binary
 *   - a renderer that throws on the first frame (bad enum, null program, ...)
 *   - NaN reaching the GPU: every vertex upload and uniform value is validated
 *   - uniform/attribute names that do not exist in the shader source they are
 *     looked up against (a silent black sprite or a dead light)
 *   - the flow machine: title -> launch -> play -> pause -> gameover -> restart
 *   - memory growth of the WASM linear memory across a long run (leak check)
 *
 * The mock GL is deliberately permissive (unknown calls are recorded no-ops) so
 * it never masks a real bug with a mock bug, but it records everything the
 * assertions need.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let checks = 0;
let failures = 0;
function check(label, ok, extra = "") {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  \u2717 ${label} ${extra}`);
  } else {
    console.log(`  \u2713 ${label} ${extra}`);
  }
}
function section(name) {
  console.log(`\n[${name}]`);
}

// ---------------------------------------------------------------------------
// Recorded state
// ---------------------------------------------------------------------------
const rec = {
  programs: [], // {name, vs, fs}
  uniformLookups: [], // {program, name}
  attribLookups: [], // {program, name}
  uniformNames: new Map(), // program -> Set(names)
  attribNames: new Map(),
  nonFiniteUniforms: [], // {frame, name}
  nonFiniteUploads: [], // {frame, index}
  uploads: 0,
  uploadFloats: 0,
  draws: [], // {frame, instances, count}
  textures: 0,
  framebuffers: 0,
  deletedTextures: 0,
  deletedPrograms: 0,
  frame: 0,
  maxInstances: 0,
};

// ---------------------------------------------------------------------------
// Mock WebGL2
// ---------------------------------------------------------------------------
function createGL(canvas) {
  const consts = new Map();
  const constVal = (name) => {
    if (!consts.has(name)) consts.set(name, 0x1000 + consts.size);
    return consts.get(name);
  };
  let objects = 0;
  const obj = (kind) => ({ __gl: kind, id: ++objects });

  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const watchValues = (name, args) => {
    for (const a of args) {
      if (typeof a === "number") {
        if (!Number.isFinite(a)) rec.nonFiniteUniforms.push({ frame: rec.frame, name, value: a });
      } else if (a && typeof a === "object" && typeof a.length === "number") {
        for (let i = 0; i < a.length; i++) {
          if (!Number.isFinite(a[i])) {
            rec.nonFiniteUniforms.push({ frame: rec.frame, name, index: i, value: a[i] });
            break;
          }
        }
      }
    }
  };
  const watchBuffer = (data) => {
    if (!(data instanceof Float32Array)) return;
    rec.uploads++;
    rec.uploadFloats += data.length;
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) {
        rec.nonFiniteUploads.push({ frame: rec.frame, index: i, value: data[i] });
        return;
      }
    }
  };

  const impl = {
    // --- shaders / programs -------------------------------------------------
    createShader: (type) => obj(`shader:${type}`),
    shaderSource: (shader, source) => {
      shader.src = source;
    },
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    deleteShader: () => {},
    createProgram: () => obj("program"),
    attachShader: (program, shader) => {
      if (!program.shaders) program.shaders = [];
      program.shaders.push(shader);
    },
    linkProgram: (program) => {
      const srcs = (program.shaders ?? []).map((s) => s.src ?? "");
      program.vs = srcs.find((s) => s.includes("gl_Position")) ?? srcs[0] ?? "";
      program.fs = srcs.find((s) => s.includes("gl_FragColor") || s.includes("outColor")) ?? srcs[srcs.length - 1] ?? "";
      program.all = srcs.join("\n");
      // Identify the pass by a distinctive token from its own source.
      program.tag =
        ["uAtlas", "uFogColor", "uThreshold", "uDirection", "uHigher", "uBloom", "uSkyTop"].find((t) =>
          program.all.includes(t),
        ) ?? "unknown";
      rec.programs.push(program);
    },
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    deleteProgram: () => {
      rec.deletedPrograms++;
    },
    useProgram: (program) => {
      impl.__current = program;
    },
    getUniformLocation: (program, name) => {
      rec.uniformLookups.push({ program, name });
      if (!rec.uniformNames.has(program)) rec.uniformNames.set(program, new Set());
      rec.uniformNames.get(program).add(name);
      return obj(`uniform:${name}`);
    },
    getAttribLocation: (program, name) => {
      rec.attribLookups.push({ program, name });
      if (!rec.attribNames.has(program)) rec.attribNames.set(program, new Set());
      rec.attribNames.get(program).add(name);
      return 0;
    },

    // --- uniforms -----------------------------------------------------------
    uniform1f: (l, a) => watchValues(l?.__gl ?? "?", [a]),
    uniform2f: (l, a, b) => watchValues(l?.__gl ?? "?", [a, b]),
    uniform3f: (l, a, b, c) => watchValues(l?.__gl ?? "?", [a, b, c]),
    uniform4f: (l, a, b, c, d) => watchValues(l?.__gl ?? "?", [a, b, c, d]),
    uniform1i: (l, a) => watchValues(l?.__gl ?? "?", [a]),
    uniform2i: () => {},
    uniform3i: () => {},
    uniform4i: () => {},
    uniform1fv: (l, v) => watchValues(l?.__gl ?? "?", [v]),
    uniform2fv: (l, v) => watchValues(l?.__gl ?? "?", [v]),
    uniform3fv: (l, v) => watchValues(l?.__gl ?? "?", [v]),
    uniform4fv: (l, v) => watchValues(l?.__gl ?? "?", [v]),
    uniformMatrix2fv: (l, _t, v) => watchValues(l?.__gl ?? "?", [v]),
    uniformMatrix3fv: (l, _t, v) => watchValues(l?.__gl ?? "?", [v]),
    uniformMatrix4fv: (l, _t, v) => watchValues(l?.__gl ?? "?", [v]),

    // --- buffers / vaos -----------------------------------------------------
    createBuffer: () => obj("buffer"),
    deleteBuffer: () => {},
    bindBuffer: () => {},
    bufferData: (_target, data) => watchBuffer(data),
    bufferSubData: (_target, _offset, data, srcOffset, length) =>
      watchBuffer(
        data && typeof data.subarray === "function" && length !== undefined
          ? data.subarray(srcOffset ?? 0, (srcOffset ?? 0) + length)
          : data,
      ),
    createVertexArray: () => obj("vao"),
    deleteVertexArray: () => {},
    bindVertexArray: () => {},
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},

    // --- textures / framebuffers -------------------------------------------
    createTexture: () => {
      rec.textures++;
      return obj("texture");
    },
    deleteTexture: () => {
      rec.deletedTextures++;
    },
    bindTexture: () => {},
    activeTexture: () => {},
    texImage2D: () => {},
    texSubImage2D: () => {},
    texStorage2D: () => {},
    texParameteri: () => {},
    texParameterf: () => {},
    generateMipmap: () => {},
    pixelStorei: () => {},
    createFramebuffer: () => {
      rec.framebuffers++;
      return obj("fbo");
    },
    deleteFramebuffer: () => {},
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => constVal("FRAMEBUFFER_COMPLETE"),
    drawBuffers: () => {},
    readBuffer: () => {},
    blitFramebuffer: () => {},

    // --- draw / state -------------------------------------------------------
    drawArrays: (_mode, _first, count) => rec.draws.push({ frame: rec.frame, count, instances: 1 }),
    drawArraysInstanced: (_mode, _first, count, instances) => {
      rec.draws.push({ frame: rec.frame, count, instances });
      if (instances > rec.maxInstances) rec.maxInstances = instances;
    },
    drawElements: (_mode, count) => rec.draws.push({ frame: rec.frame, count, instances: 1 }),
    drawElementsInstanced: (_mode, count, _t, _o, instances) => {
      rec.draws.push({ frame: rec.frame, count, instances });
      if (instances > rec.maxInstances) rec.maxInstances = instances;
    },
    viewport: () => {},
    scissor: () => {},
    clear: () => {},
    clearColor: (r, g, b, a) => watchValues("clearColor", [r, g, b, a]),
    enable: () => {},
    disable: () => {},
    blendFunc: () => {},
    blendFuncSeparate: () => {},
    blendEquation: () => {},
    depthFunc: () => {},
    depthMask: () => {},
    colorMask: () => {},
    lineWidth: () => {},
    frontFace: () => {},
    cullFace: () => {},
    flush: () => {},
    finish: () => {},
    getError: () => 0,
    isContextLost: () => false,
    getExtension: (name) =>
      name === "EXT_color_buffer_float" || name === "OES_texture_float_linear" || name === "EXT_float_blend"
        ? { __gl: `ext:${name}` }
        : null,
    getParameter: (p) => (p === constVal("MAX_TEXTURE_SIZE") ? 4096 : 4096),
    getSupportedExtensions: () => ["EXT_color_buffer_float"],
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
  };

  const overrides = {
    canvas,
    drawingBufferWidth: () => canvas.width,
    drawingBufferHeight: () => canvas.height,
    drawingBufferColorSpace: "srgb",
  };

  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === "symbol") return target[prop];
      if (prop in overrides) {
        const v = overrides[prop];
        return typeof v === "function" ? v() : v;
      }
      if (prop in target) return target[prop];
      // WebGL enums are UPPER_SNAKE and must be stable per name.
      if (/^[A-Z0-9_]+$/.test(prop)) return constVal(prop);
      // Unknown API surface: record it and stay harmless.
      const fn = (...args) => {
        rec[`unknown:${prop}`] = (rec[`unknown:${prop}`] ?? 0) + 1;
        if (/^create/.test(prop)) return obj(prop);
        watchValues(prop, args);
        return undefined;
      };
      target[prop] = fn;
      return fn;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Mock DOM
// ---------------------------------------------------------------------------
const listeners = [];
function makeEventTarget(name, extra = {}) {
  const target = {
    __name: name,
    addEventListener: (type, fn) => listeners.push({ target, type, fn }),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex((l) => l.target === target && l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => true,
    ...extra,
  };
  return target;
}

function makeCtx2d() {
  const ctx = {
    canvas: null,
    imageSmoothingEnabled: false,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    strokeStyle: "#000",
    save() {},
    restore() {},
    scale() {},
    translate() {},
    clearRect() {},
    fillRect() {},
    drawImage() {},
    putImageData() {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
  };
  return ctx;
}

function makeElement(id) {
  const el = makeEventTarget(`#${id}`, {
    id,
    tagName: "DIV",
    textContent: "",
    innerHTML: "",
    hidden: false,
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
    style: {},
    dataset: {},
    children: [],
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      return c;
    },
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    blur() {},
  });
  return el;
}

function installDom(wasmBytes) {
  const canvas = makeElement("game");
  canvas.tagName = "CANVAS";
  canvas.width = 1280;
  canvas.height = 720;
  canvas.clientWidth = 1280;
  canvas.clientHeight = 720;
  const gl = createGL(canvas);
  canvas.getContext = (type) => (type === "webgl2" || type === "webgl" ? gl : makeCtx2d());

  const elements = new Map([["game", canvas]]);
  for (const id of ["hud", "boot", "boot-msg", "bar-fill", "boot-err"]) elements.set(id, makeElement(id));

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };

  // --- audio (mock; failures here fall back to the silent path) -------------
  const audioParam = () => ({
    value: 0,
    defaultValue: 0,
    minValue: -3.4e38,
    maxValue: 3.4e38,
    setValueAtTime() {
      return this;
    },
    linearRampToValueAtTime() {
      return this;
    },
    exponentialRampToValueAtTime() {
      return this;
    },
    setTargetAtTime() {
      return this;
    },
    cancelScheduledValues() {
      return this;
    },
    cancelAndHoldAtTime() {
      return this;
    },
  });
  const audioNode = (kind) =>
    new Proxy(
      {
        kind,
        connect: (dst) => dst,
        disconnect() {},
        start() {},
        stop() {},
        onended: null,
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
      },
      {
        get(t, p) {
          if (p in t) return t[p];
          if (typeof p !== "string") return undefined;
          if (!t[p]) t[p] = audioParam();
          return t[p];
        },
        set(t, p, v) {
          t[p] = v;
          return true;
        },
      },
    );
  let audioNodes = 0;
  class MockAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = "running";
      this.destination = audioNode("destination");
      this.listener = audioNode("listener");
      audioNodes++;
    }
    get currentTime() {
      return clock.now / 1000;
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
    suspend() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    createBuffer(channels, length, sampleRate) {
      const data = [];
      for (let i = 0; i < channels; i++) data.push(new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: (i) => data[i] ?? data[0],
        copyToChannel: (src, i) => (data[i] ?? data[0]).set(src),
      };
    }
  }
  const ctxProto = MockAudioContext.prototype;
  for (const kind of [
    "Gain",
    "Oscillator",
    "BiquadFilter",
    "DynamicsCompressor",
    "BufferSource",
    "StereoPanner",
    "Panner",
    "WaveShaper",
    "Delay",
    "Convolver",
    "Analyser",
    "ConstantSource",
    "ChannelMerger",
    "ChannelSplitter",
  ]) {
    ctxProto[`create${kind}Node`] = function () {
      audioNodes++;
      return audioNode(kind);
    };
    ctxProto[`create${kind}`] = ctxProto[`create${kind}Node`];
  }
  ctxProto.createGain = function () {
    audioNodes++;
    return audioNode("Gain");
  };
  ctxProto.createBufferSource = function () {
    audioNodes++;
    return audioNode("BufferSource");
  };

  // --- clock / raf ----------------------------------------------------------
  const clock = { now: 0 };
  const raf = { cb: null, id: 0 };

  const window = makeEventTarget("window", {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 2,
    localStorage,
    AudioContext: MockAudioContext,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb) => {
      raf.cb = cb;
      return ++raf.id;
    },
    cancelAnimationFrame: () => {
      raf.cb = null;
    },
    setTimeout: (fn) => {
      return 0;
    },
    clearTimeout: () => {},
    fetch: () => Promise.reject(new Error("no network in headless mode")),
  });
  const document = makeEventTarget("document", {
    hidden: false,
    visibilityState: "visible",
    body: makeElement("body"),
    documentElement: makeElement("html"),
    getElementById: (id) => elements.get(id) ?? null,
    querySelector: (sel) => elements.get(String(sel).replace("#", "")) ?? null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const el = makeElement(tag);
      el.tagName = String(tag).toUpperCase();
      if (tag === "canvas") {
        el.width = 1;
        el.height = 1;
        el.getContext = () => makeCtx2d();
      }
      return el;
    },
  });

  // Node 22 defines some web globals as getter-only, so install them all with
  // defineProperty rather than plain assignment.
  const g = globalThis;
  const define = (name, value) => {
    Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
  };
  define("window", window);
  define("document", document);
  define("self", window);
  define("navigator", { userAgent: "node-headless", maxTouchPoints: 0, vibrate: () => false, platform: "linux" });
  define("localStorage", localStorage);
  define("performance", { now: () => clock.now, timeOrigin: 0, mark() {}, measure() {} });
  define("requestAnimationFrame", window.requestAnimationFrame);
  define("cancelAnimationFrame", window.cancelAnimationFrame);
  define("AudioContext", MockAudioContext);
  define("devicePixelRatio", 2);
  define("innerWidth", 1280);
  define("innerHeight", 720);
  define(
    "ImageData",
    class ImageData {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
  define("fetch", async () => ({
    ok: true,
    status: 200,
    url: "mock:wasm/sim.wasm",
    arrayBuffer: async () => wasmBytes.slice().buffer,
    text: async () => "",
  }));

  return {
    canvas,
    gl,
    clock,
    raf,
    audioNodeCount: () => audioNodes,
    listeners,
    fire(target, type, event = {}) {
      const evt = {
        type,
        repeat: false,
        preventDefault() {},
        stopPropagation() {},
        target,
        currentTarget: target,
        ...event,
      };
      for (const l of [...listeners]) if (l.target === target && l.type === type) l.fn(evt);
      return evt;
    },
    fireAll(type, event = {}) {
      for (const l of [...listeners]) if (l.type === type) l.fn({ type, preventDefault() {}, stopPropagation() {}, ...event });
    },
    key(code, down, extra = {}) {
      const t = down ? "keydown" : "keyup";
      this.fireAll(t, { code, key: code, repeat: false, ...extra });
    },
  };
}

// ---------------------------------------------------------------------------
// Bundle the real game sources
// ---------------------------------------------------------------------------
const importMetaShim = {
  name: "import-meta-shim",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, async (args) => {
      if (args.path.includes("node_modules")) return null;
      const text = readFileSync(args.path, "utf8").replace(/import\.meta\.env\.BASE_URL/g, '"/"');
      return { contents: text, loader: "ts" };
    });
  },
};

async function loadGame() {
  const result = await build({
    stdin: {
      contents:
        'export { Game } from "./src/flow/Game";\n' +
        'export { SimCore } from "./src/sim/SimCore";\n' +
        'export { METRES_PER_WORLD_UNIT } from "./src/systems/WeatherTimeManager";\n' +
        'export { PIXEL_DENSITY } from "./src/systems/ParallaxManager";\n',
      resolveDir: ROOT,
      loader: "ts",
      sourcefile: "headless-entry.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node18",
    logLevel: "silent",
    plugins: [importMetaShim],
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const wasmPath = join(ROOT, "public", "wasm", "sim.wasm");
const wasmBytes = new Uint8Array(readFileSync(wasmPath));
const dom = installDom(wasmBytes);

section("boot");
const progress = [];
const mod = await loadGame();
let game = null;
let bootError = null;
try {
  game = await mod.Game.create(dom.canvas, {
    seed: 20261015,
    hud: true,
    weather: 3, // thunderstorm: exercises rain, lightning, wind, wet specular
    onProgress: (p, message) => progress.push({ p, message }),
  });
} catch (err) {
  bootError = err;
}
check("game boots headlessly", bootError === null, bootError ? `\n${bootError.stack ?? bootError}` : "");
if (!game) {
  console.log(`\nFAIL  ${checks - failures}/${checks} checks passed`);
  process.exit(1);
}

check("boot progress reaches 100%", progress.length >= 4 && progress[progress.length - 1].p === 1, `(${progress.map((x) => x.message).join(" | ")})`);

// ABI: every export the host declares must exist in the binary.
const simCoreSrc = readFileSync(join(ROOT, "src", "sim", "SimCore.ts"), "utf8");
const iface = /interface SimExports \{([\s\S]*?)\n\}/.exec(simCoreSrc);
const declared = iface ? [...iface[1].matchAll(/^\s{2}([a-zA-Z_][\w]*)\s*:/gm)].map((m) => m[1]) : [];
const missingExports = declared.filter((n) =>
    n === "memory" ? !(game.sim.exports.memory instanceof WebAssembly.Memory) : typeof game.sim.exports[n] !== "function",
  );
check("WASM ABI matches the host interface", declared.length > 20 && missingExports.length === 0, `(${declared.length} exports${missingExports.length ? `, missing ${missingExports.join(", ")}` : ""})`);

check("atlas uploaded to the GPU", rec.textures >= 2, `(${rec.textures} textures, ${rec.framebuffers} framebuffers)`);
check("renderer compiled its programs", rec.programs.length >= 5, `(${rec.programs.length} programs)`);
check("HDR chain available", game.pipeline.hdr === true);

game.start();
check("start() arms the frame loop", typeof dom.raf.cb === "function");

// --- frame driver -----------------------------------------------------------
function frames(n, onFrame) {
  for (let i = 0; i < n; i++) {
    dom.clock.now += 1000 / 60;
    rec.frame++;
    const cb = dom.raf.cb;
    dom.raf.cb = null;
    if (!cb) throw new Error(`requestAnimationFrame was not re-armed at frame ${rec.frame}`);
    cb(dom.clock.now);
    if (onFrame) onFrame(i);
  }
}

section("title");
frames(60);
check("title mode holds", game.mode === "title", `(mode=${game.mode})`);
check("title screen draws sprites", rec.draws.length > 30, `(${rec.draws.length} draw calls in 60 frames)`);
check("tethered balloon on the title", game.player.phase === "tethered", `(phase=${game.player.phase}, y=${game.player.y.toFixed(3)})`);
const titleDecor = game.parallax.liveDecor() + game.gen.liveObstacles;
check("title scenery is populated", titleDecor > 0, `(${game.parallax.liveDecor()} decor pooled)`);
const drawsPerTitleFrame = rec.draws.length / 60;
check("instanced batching in use", rec.maxInstances > 8, `(max ${rec.maxInstances} instances in one call, ${drawsPerTitleFrame.toFixed(1)} calls/frame)`);

section("launch");
dom.key("Space", true);
dom.key("Space", false);
frames(4);
check("start input leaves the title", game.mode === "launch" || game.mode === "play", `(mode=${game.mode})`);
check("audio unlocked on the gesture", game.audio.ready === true, `(mock audio nodes: ${dom.audioNodeCount()})`);
const tetherY = game.player.y;
let reachedPlay = false;
for (let i = 0; i < 300 && !reachedPlay; i++) {
  frames(1);
  if (game.mode === "play") reachedPlay = true;
}
check("balloon ascends into play mode", reachedPlay, `(mode=${game.mode}, phase=${game.player.phase})`);
check("rope is cut", game.player.ropeIsCut === true);
check("balloon rose toward its anchor", game.player.y < tetherY - 0.02, `(from y=${tetherY.toFixed(3)} to ${game.player.y.toFixed(3)}, anchor ${game.player.anchorY.toFixed(3)})`);

section("play");
const altitudeBefore = game.altitude;
const chunksBefore = game.gen.chunksStreamed;
const memBefore = game.sim.exports.memory.buffer.byteLength;
let struck = false;
let maxParticles = 0;
let maxObstacles = 0;
let maxDrawn = 0;
frames(600, () => {
  if (game.weather.strikeFrame) struck = true;
  maxParticles = Math.max(maxParticles, game.sim.particleCount);
  maxObstacles = Math.max(maxObstacles, game.gen.liveObstacles);
  maxDrawn = Math.max(maxDrawn, game.particles.drawn);
});
check("run stays playable for 10 s", game.mode === "play" || game.mode === "gameover", `(mode=${game.mode}, lives=${game.player.lives}/${game.player.maxLives})`);
check("altitude climbs", game.altitude > altitudeBefore + 20, `(${altitudeBefore.toFixed(0)} m -> ${game.altitude.toFixed(0)} m)`);
check("chunks keep streaming", game.gen.chunksStreamed > chunksBefore, `(${chunksBefore} -> ${game.gen.chunksStreamed} chunks)`);
check("obstacles on screen", maxObstacles > 0, `(peak ${maxObstacles} live)`);
check("storm particles rendered", maxDrawn > 100 && maxParticles > 200, `(peak ${maxDrawn} drawn of ${maxParticles} live)`);
check("lightning struck", struck || game.weather.flash > 0, `(flash=${game.weather.flash.toFixed(3)})`);
check("no spawns dropped", game.gen.droppedSpawns + game.parallax.droppedSpawns === 0, `(${game.gen.droppedSpawns} obstacles, ${game.parallax.droppedSpawns} decor)`);
const memAfter = game.sim.exports.memory.buffer.byteLength;
check("WASM memory did not grow", memAfter === memBefore, `(${(memBefore / 1024).toFixed(0)} KB stable over ${rec.frame} frames)`);

section("controls");
// The unattended soak lets the storm wind pin the balloon against a wall, so
// steer back toward the middle first. Reaching it also proves the player has
// more lateral authority than the wind.
if (game.mode === "play") {
  const toward = game.player.x > 0.5 ? "ArrowLeft" : "ArrowRight";
  dom.key(toward, true);
  for (let i = 0; i < 180 && (toward === "ArrowLeft" ? game.player.x > 0.45 : game.player.x < 0.55); i++) frames(1);
  dom.key(toward, false);
  frames(2);
}
check("the player can fight the storm wind", game.player.x > 0.1 && game.player.x < 0.9, `(recovered to x=${game.player.x.toFixed(3)})`);
const x0 = game.player.x;
dom.key("ArrowRight", true);
frames(45);
dom.key("ArrowRight", false);
const x1 = game.player.x;
dom.key("ArrowLeft", true);
frames(45);
dom.key("ArrowLeft", false);
const x2 = game.player.x;
check("right input moves the balloon right", x1 > x0 + 0.005, `(${x0.toFixed(3)} -> ${x1.toFixed(3)})`);
check("left input moves the balloon left", x2 < x1 - 0.005, `(${x1.toFixed(3)} -> ${x2.toFixed(3)})`);
check("balloon stays inside the screen", x2 > 0.02 && x2 < 0.98, `(x=${x2.toFixed(3)})`);

section("pause");
const altAtPause = game.altitude;
dom.key("Escape", true);
dom.key("Escape", false);
frames(2);
check("escape pauses", game.mode === "paused", `(mode=${game.mode})`);
frames(90);
check("paused world is frozen", game.altitude === altAtPause && game.gen.chunksStreamed >= 0, `(altitude held at ${game.altitude.toFixed(1)} m)`);
dom.key("Escape", true);
dom.key("Escape", false);
frames(2);
check("escape resumes", game.mode === "play", `(mode=${game.mode})`);

section("soak");
// 40 more seconds of unattended flight: difficulty ramps, chunks get denser and
// the day/night cycle advances. Whenever the balloon dies we relaunch it, so the
// stream never stalls (and the restart path gets exercised repeatedly).
const soak = {
  chunks: game.gen.chunksStreamed,
  prevChunks: game.gen.chunksStreamed,
  streamed: 0,
  startAltitude: game.altitude,
  peakAltitude: game.altitude,
  peakDifficulty: game.difficulty,
  mem: game.sim.exports.memory.buffer.byteLength,
  peakObstacles: 0,
  peakDecor: 0,
  peakParticles: 0,
  restarts: 0,
  phase: game.weather.dayPhase,
};
frames(2400, () => {
  soak.peakObstacles = Math.max(soak.peakObstacles, game.gen.liveObstacles);
  soak.peakDecor = Math.max(soak.peakDecor, game.parallax.liveDecor());
  soak.peakParticles = Math.max(soak.peakParticles, game.sim.particleCount);
  soak.peakAltitude = Math.max(soak.peakAltitude, game.altitude);
  soak.peakDifficulty = Math.max(soak.peakDifficulty, game.difficulty);
  // A restart zeroes the counter, so accumulate the deltas instead.
  soak.streamed += Math.max(0, game.gen.chunksStreamed - soak.prevChunks);
  soak.prevChunks = game.gen.chunksStreamed;
  if (game.mode === "gameover") {
    soak.restarts++;
    dom.key("KeyR", true);
    dom.key("KeyR", false);
  }
});
// One chunk per world unit climbed; the tolerance covers the grace chunks and
// the run that was cut short by the crash.
const chunkHeight = game.sim.chunkHeight || 1;
const expectedChunks = Math.max(3, Math.floor((soak.peakAltitude - soak.startAltitude) / (mod.METRES_PER_WORLD_UNIT * chunkHeight)) - 1);
check(
  "soak keeps streaming chunks",
  soak.streamed >= expectedChunks,
  `(${soak.streamed} authored for ${(soak.peakAltitude - soak.startAltitude).toFixed(0)} m climbed, expected >= ${expectedChunks}; counter ${soak.chunks} -> ${game.gen.chunksStreamed} after ${soak.restarts} restart(s))`,
);
check(
  "pools stay inside their capacity",
  soak.peakObstacles <= game.gen.obstacles.capacity && soak.peakDecor <= game.parallax.decor.capacity,
  `(obstacles ${soak.peakObstacles}/${game.gen.obstacles.capacity}, decor ${soak.peakDecor}/${game.parallax.decor.capacity}, particles ${soak.peakParticles}/${game.sim.particleCapacity})`,
);
check("no pool exhaustion during the soak", game.gen.droppedSpawns + game.parallax.droppedSpawns === 0, `(${game.gen.droppedSpawns} obstacle, ${game.parallax.droppedSpawns} decor drops)`);
check("WASM memory stable across the soak", game.sim.exports.memory.buffer.byteLength === soak.mem, `(${(soak.mem / 1024).toFixed(0)} KB)`);
check("difficulty ramps with altitude", soak.peakAltitude > 200 && soak.peakDifficulty > 0.05, `(peak ${soak.peakAltitude.toFixed(0)} m, difficulty ${soak.peakDifficulty.toFixed(3)})`);
check("day/night cycle advanced", Math.abs(game.weather.dayPhase - soak.phase) > 0.02, `(phase ${soak.phase.toFixed(3)} -> ${game.weather.dayPhase.toFixed(3)})`);
check("the world is survivable, not a death wall", soak.restarts < 12, `(${soak.restarts} crashes in 40 s of unattended flight)`);

section("collision & lives");
if (game.mode !== "play") {
  dom.key("KeyR", true);
  dom.key("KeyR", false);
  frames(200);
}
const pool = game.gen.obstacles;
const plant = pool.obtain();
check("obstacle pool has a free slot", plant !== null && plant !== undefined);
if (plant) {
  // Sit a piece of debris exactly on the balloon and let the real collision
  // system find it (broad phase + oriented narrow phase).
  plant.type = 1;
  plant.variant = 0;
  plant.x = game.player.x;
  plant.y = game.player.y;
  plant.baseX = game.player.x;
  plant.w = 0.1;
  plant.h = 0.1;
  plant.rot = 0.4;
  plant.radius = 0.03;
  plant.vx = 0;
  plant.vy = 0;
  plant.spin = 0;
  plant.swayAmp = 0;
  plant.speedMul = 1;
  plant.armTime = -1;
  plant.hitFlash = 0;
  const livesBefore = game.player.lives;
  const event = game.collision.update(game.player, pool);
  check("overlap is detected", event !== null && event !== undefined, event ? `(type ${event.obstacleType} at x=${event.x.toFixed(3)})` : "(no event)");
  check("closest approach collapses on impact", game.collision.closestApproach < 0.06, `(${game.collision.closestApproach.toFixed(4)})`);
  game.player.invuln = 0;
  const damaged = game.player.hit(event ? event.x : 0.5);
  check("a hit costs exactly one life", damaged === true && game.player.lives === livesBefore - 1, `(lives ${game.player.lives}/${game.player.maxLives})`);
  check("the hit kicks off a spark burst", game.sim.particleCount > 0);
  pool.release(plant);
}

// Drain the rest of the lives: the run must end, bank the score, and restart.
const altitudeAtDeath = game.altitude;
for (let i = 0; i < game.player.maxLives + 1 && game.mode === "play"; i++) {
  game.player.invuln = 0;
  game.player.hit(game.player.x + 0.1);
  frames(4);
}
// The wreck lingers for DEATH_LINGER seconds before the card appears.
for (let i = 0; i < 180 && game.mode !== "gameover"; i++) frames(1);
check("losing every life ends the run", game.mode === "gameover", `(mode=${game.mode}, phase=${game.player.phase})`);
check("the score is banked", game.ui.score > 0 && game.ui.best >= game.ui.score, `(score ${game.ui.score}, best ${game.ui.best})`);
check("altitude stopped at the death mark", Math.abs(game.altitude - altitudeAtDeath) < 40, `(${altitudeAtDeath.toFixed(0)} m -> ${game.altitude.toFixed(0)} m)`);
dom.key("KeyR", true);
dom.key("KeyR", false);
frames(8);
check("restart relaunches the balloon", game.mode === "launch" || game.mode === "play", `(mode=${game.mode})`);
check("restart resets the run", game.altitude === 0 && game.player.lives === game.player.maxLives, `(altitude ${game.altitude.toFixed(0)} m, lives ${game.player.lives})`);
frames(200);
check("the relaunched run flies", game.mode === "play" && game.altitude > 0, `(mode=${game.mode}, ${game.altitude.toFixed(0)} m)`);

section("gpu contract");
check("every uploaded vertex is finite", rec.nonFiniteUploads.length === 0, rec.nonFiniteUploads.length ? `(first: frame ${rec.nonFiniteUploads[0].frame} index ${rec.nonFiniteUploads[0].index} = ${rec.nonFiniteUploads[0].value})` : `(${rec.uploads} uploads, ${(rec.uploadFloats / 1000).toFixed(0)}k floats)`);
check("every uniform value is finite", rec.nonFiniteUniforms.length === 0, rec.nonFiniteUniforms.length ? `(first: ${JSON.stringify(rec.nonFiniteUniforms[0])})` : `(${rec.uniformLookups.length} lookups)`);

const badUniforms = [];
for (const { program, name } of rec.uniformLookups) {
  const base = name.replace(/\[\d+\]$/, "");
  if (!(program.all ?? "").includes(base)) badUniforms.push(`${name} [${program.tag ?? "?"}]`);
}
check("uniform names exist in their shaders", badUniforms.length === 0, badUniforms.length ? `(${[...new Set(badUniforms)].join(", ")})` : `(${new Set(rec.uniformLookups.map((u) => u.name)).size} unique)`);

const badAttribs = [];
for (const { program, name } of rec.attribLookups) {
  if (!(program.vs ?? "").includes(name)) badAttribs.push(name);
}
const attribNames = [...new Set(rec.attribLookups.map((a) => a.name))];
check(
  "attribute names exist in the vertex shader",
  badAttribs.length === 0,
  badAttribs.length
    ? `(${badAttribs.join(", ")})`
    : attribNames.length
      ? `(${attribNames.join(", ")})`
      : "(vertex inputs use explicit GLSL locations - nothing queried by name)",
);

const hudEl = dom.canvas && globalThis.document.getElementById("hud");
check("dev HUD reports stats", typeof hudEl?.textContent === "string" && hudEl.textContent.length > 10, `(${(hudEl?.textContent ?? "").split("\n")[0]})`);

section("teardown");
let stopError = null;
try {
  game.stop();
} catch (err) {
  stopError = err;
}
check("stop() tears down cleanly", stopError === null, stopError ? `(${stopError.message})` : `(${rec.deletedPrograms} programs, ${rec.deletedTextures} textures released)`);
check("frame loop halted", dom.raf.cb === null);

section("determinism");
/**
 * A fresh boot + scripted run, sampled every 6 frames. Two runs of the same
 * seed must produce byte-identical traces: the world stream is only drained by
 * fixed-timestep simulation, so frame pacing and particle churn cannot leak
 * into gameplay.
 */
async function playRun(seed, totalFrames) {
  const dom2 = installDom(wasmBytes);
  const run = await mod.Game.create(dom2.canvas, { seed, weather: 3 });
  run.start();
  const press = (code) => {
    dom2.key(code, true);
    dom2.key(code, false);
  };
  const trace = [];
  for (let i = 0; i < totalFrames; i++) {
    if (i === 30) press("Space"); // leave the title
    if (i === 120) dom2.key("ArrowRight", true);
    if (i === 180) dom2.key("ArrowRight", false);
    if (i === 300) dom2.key("ArrowLeft", true);
    if (i === 360) dom2.key("ArrowLeft", false);
    if (i === 500) press("KeyW"); // cycle the weather mid-run
    if (run.mode === "gameover") press("KeyR");
    dom2.clock.now += 1000 / 60;
    rec.frame++;
    const cb = dom2.raf.cb;
    dom2.raf.cb = null;
    if (!cb) throw new Error("run stopped arming requestAnimationFrame");
    cb(dom2.clock.now);
    if (i % 6 === 0) {
      trace.push(
        [run.altitude, run.player.x, run.player.y, run.gen.chunksStreamed, run.sim.particleCount, run.weather.dayPhase, run.player.lives]
          .map((v) => (typeof v === "number" ? v.toFixed(5) : String(v)))
          .join(","),
      );
    }
  }
  run.stop();
  return trace;
}

const traceA = await playRun(90210, 900);
const traceB = await playRun(90210, 900);
const firstDiff = traceA.findIndex((line, i) => line !== traceB[i]);
check(
  "the same seed replays the same run",
  firstDiff === -1,
  firstDiff === -1
    ? `(${traceA.length} sampled frames identical)`
    : `(diverged at sample ${firstDiff}: "${traceA[firstDiff]}" vs "${traceB[firstDiff]}")`,
);
const traceC = await playRun(90211, 900);
check("a different seed plays a different world", traceC.some((line, i) => line !== traceA[i]));
const lastSample = traceA[traceA.length - 1].split(",");
check("the scripted run really played", Number(lastSample[0]) > 50 && Number(lastSample[3]) > 2, `(altitude ${Number(lastSample[0]).toFixed(0)} m, ${lastSample[3]} chunks, lives ${lastSample[6]})`);

section("scene report");
// Informational: the numeric scale of what the renderer was asked to draw. A
// sprite an order of magnitude out would still pass every check above.
const cam = game.camera;
const ppu = cam.pixelsPerWorldUnit;
const px = (worldUnits) => `${(worldUnits * ppu).toFixed(0)}px`;
const balloonRegion = game.atlas.region(`balloon_${game.player.variant}`);
const bw = (balloonRegion.w * mod.PIXEL_DENSITY) / ppu;
const bh = (balloonRegion.h * mod.PIXEL_DENSITY) / ppu;
const live = game.gen.obstacles.items.filter((o) => o.active);
const sizes = live.map((o) => Math.max(o.w, o.h));
const report = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);
report("internal resolution", `${cam.internalW}x${cam.internalH} (pixel scale ${cam.pixelScale}, framebuffer ${cam.fbWidth}x${cam.fbHeight})`);
report("world viewport", `1.000 x ${cam.viewH.toFixed(3)} units, ${ppu.toFixed(0)} px per world unit`);
report("balloon", `${balloonRegion.w}x${balloonRegion.h} atlas px -> ${bw.toFixed(3)}x${bh.toFixed(3)} world = ${px(bw)}x${px(bh)} (${((bh / cam.viewH) * 100).toFixed(0)}% of screen height)`);
report("hit radius", `${game.player.HIT_RADIUS ?? 0.062} world = ${px(0.062)} (forgiving vs ${px(bw)} wide art)`);
report("anchor", `y=${game.player.anchorY.toFixed(3)} of ${cam.viewH.toFixed(3)} (${((game.player.anchorY / cam.viewH) * 100).toFixed(0)}% down)`);
report("obstacles live", `${live.length}${sizes.length ? `, ${Math.min(...sizes).toFixed(3)}-${Math.max(...sizes).toFixed(3)} world = ${px(Math.min(...sizes))}-${px(Math.max(...sizes))}` : ""}`);
report("decor live", `${game.parallax.liveDecor()} pooled + ${game.parallax.bandCount ?? 4} far bands`);
report("particles", `${game.particles.drawn} drawn of ${game.sim.particleCount} live (cap ${game.sim.particleCapacity})`);
report("weather", `${game.weather.stateName} (blend ${game.weather.stateBlend.toFixed(2)}), wind ${game.weather.windForce.toFixed(2)}, flash ${game.weather.flash.toFixed(3)}`);
report("time of day", `phase ${game.weather.dayPhase.toFixed(3)} = ${game.weather.clockLabel}`);
report("draw calls / frame", `${(rec.draws.length / Math.max(1, rec.frame)).toFixed(1)} (max ${rec.maxInstances} instances in one call)`);
report("atlas", `${game.atlas.names.length} regions, ${rec.textures} GPU textures`);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} headless checks passed (${rec.frame} frames)`);
process.exit(failures === 0 ? 0 : 1);
