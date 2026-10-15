# ASCENSION — *The Replaced Look*

An infinitely scrolling **2.5D hot air balloon** game. Pixel-art textures, but
lit like a modern renderer: normal-mapped dynamic lighting, volumetric fog,
HDR bloom, day/night cycle, living weather — and a **real WebAssembly
simulation core** that authors every chunk of the infinite world.

> **Status:** the WASM simulation core, the renderer, the procedural art
> pipeline and all gameplay systems are in. The final wiring pass (game flow +
> boot) is landing on this branch — see the checklist at the bottom.

---

## Engine recommendation (and why)

The brief asked for a recommendation between Godot 4, Three.js and Rust/Bevy for
**2.5D dynamic lighting compiled to WASM**. This project ships:

### A hand-rolled WebGL2 renderer in TypeScript + an AssemblyScript/Rust-style WASM simulation core

| Option | 2D normal mapping | Bloom / HDR in 2D | Volumetric fog | WASM payload | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Godot 4** | ✅ `CanvasItem` + `PointLight2D`/normal maps | ❌ Glow is **3D-only**; 2D needs a `SubViewport` hack | ⚠️ shader-only, no cheap raymarch hooks | ~35–45 MB `.wasm` + slow first paint | Great editor, wrong lighting model for this brief |
| **Three.js** | ⚠️ it is a 3D engine; 2.5D sprites = camera-locked quads | ✅ | ✅ | ~600 KB JS, **not WASM-first** | Over-general; pixel-art snapping and atlasing fight you |
| **Rust + Bevy** | ✅ full control | ✅ | ✅ | 3–8 MB, needs nightly-ish toolchains & a long CI | Best *ceiling*, heaviest iteration loop for a web jam-scale build |
| **This: TS + WebGL2 + WASM core** | ✅ per-sprite tangent-space normals from generated height fields | ✅ half-float HDR chain, 3-mip gaussian | ✅ 7-step march with sun/lightning in-scatter | **19.5 KB** sim core + **40 KB** gzipped JS | Full shader control, instant CI, tiny payload |

**Reasoning.** The look in the GDD — *normal-mapped pixel art + bloom +
volumetric fog + smooth dynamic shadows* — is a **rendering-pipeline** problem,
not an engine-feature problem. Godot's 2D renderer has no glow pass at all, so
the single most important requirement would be a workaround. Bevy can do
everything but pays for it in build time, payload and iteration speed on the
web. Owning the pipeline directly means:

- one instanced draw call for the entire scene (painter's order, premultiplied
  alpha, so cut-out pixel art, soft clouds and additive glows share one blend
  state),
- an HDR half-float scene target → bright pass → 3-mip separable bloom →
  ACES tonemap → time-of-day grade → ordered-dither upscale,
- **zero binary assets**: every sprite, normal map and glyph is generated in
  code at boot, so the repo stays small and CI is reproducible.

The simulation (procedural chunks, weather, time of day, ~3 000 particles) is
compiled to WebAssembly from `wasm/assembly` with AssemblyScript — a
TypeScript-syntax, Rust-shaped language. The module boundary is a flat
`Float32Array` contract (`wasm/assembly/layout.ts` mirrored in
`src/sim/layout.ts`, version-asserted at boot), so the host reads simulation
state **zero-copy**. That boundary is also what makes a later Bevy/Godot port
cheap: the WASM module already *is* the whole simulation.

---

## Run it

```bash
npm install
npm run wasm     # compile public/wasm/sim.wasm (runs automatically via predev/prebuild)
npm run dev      # http://localhost:5173
```

```bash
npm run ci             # wasm + typecheck + build + verify + headless play-through (what CI runs)
npm run verify         # simulation, art and asset invariants
npm run test:headless  # boots the real game against a mock WebGL2 and plays it
npm run preview        # serve the production build
```

**Controls** — `← →` / `A D` / drag to steer · `Space`/`Enter`/tap to launch ·
`P` pause · `R` relaunch · `M` mute · `` ` `` dev HUD · `W` force the next
weather state.

**URL parameters** — `?seed=1234` replay a deterministic run (identical world,
weather and visuals) · `?weather=calm|cloudy|windy|storm` force the opening
state · `?day=0.75` force the time of day (0.75 = midnight) · `?hud=1` show the
dev overlay (fps, sim/render ms, pools, weather, corridor).

---

## What is in the box

### 1. Visual identity — "The Replaced Look"
- **Procedural pixel art** (`src/art/Sprites.ts`): balloon with gore panels,
  wicker basket and a swinging lantern; a cloaked traveler; six hazard families
  (spike clusters, splintered debris, storm barrels, floating rock islands,
  pulsing drift mines, ice shards); cumulus in four densities; mountain ranges,
  conifer ridges, spires, islets, ruins with windows that light up at night;
  three-frame bird flocks; a 5×7 bitmap typeface.
- **Height → normal** (`src/art/NormalMap.ts`): each sprite carries a height
  field; a Sobel pass produces tangent-space normals plus a cavity/AO term baked
  into the albedo. Domes for the envelope, facets for rock, sharp normals for
  metal and ice, near-zero for clouds.
- **Lighting**: one directional key light (sun → moon, colour and intensity
  cross-faded by the core) + up to four point lights (lantern with wind
  flicker, lightning channel, burner flame). Rain raises global specularity so
  the world reads *wet*.
- **Volumetric fog**: a 7-step march with per-step parallax, height falloff,
  sun in-scattering and a full blow-out on lightning.
- **Bloom + grade**: HDR half-float chain, ACES filmic tonemap, lift/gain grade
  driven by time of day, vignette that tightens in storms, film grain and an
  ordered 4×4 dither to kill sky banding. Lightning adds a whisper of chromatic
  aberration.
- **Parallax**: seven depth bands from `0.02` (starfield) to `2.2` (foreground
  clouds). Far bands scroll ~30× slower than the play plane; camera lean and
  impact shake are attenuated per band, which is what actually sells the depth.

### 2. Core loop
- Vertical scroller, balloon **locked to a fixed Y** (`0.62` of viewport height,
  slightly below centre); the world moves down to create the ascent.
- Horizontal-only control with analogue acceleration, quadratic drag, soft
  screen edges, envelope banking and a **lagging pendulum basket**.
- Wind from the weather system pushes the balloon; gusts shove harder. Storms
  are genuinely difficult to hold a line in.
- Three hearts, an invulnerability window with a shield shimmer, knockback,
  impact sparks and camera shake.

### 3. Procedural generation (in WASM)
- Chunk-based, seeded, deterministic: the same seed + chunk index always yields
  the same level.
- **Fairness is proven, not hoped for.** Each chunk carves a *meandering* safe
  corridor whose slope is clamped below the player's lateral authority, and
  every obstacle is placed analytically outside it (shrinking if it cannot fit).
  `tools/verify.mjs` rasterises 400 chunks and flood-fills reachability with a
  conservative player speed: **400/400 survivable**.
- Object pools everywhere (`src/entities/Pools.ts`) with an index free-list —
  steady-state play allocates nothing, on either side of the WASM boundary.
- **Two RNG streams, one seed.** A *world* stream drives chunk authoring and
  weather timing and is drained only by fixed-timestep simulation; an isolated
  *fx* stream absorbs particle churn and cosmetic host dice
  (`src/core/Random.ts`). Draining the fx stream can therefore never
  re-author the level, and `?seed=` replays a run bit-for-bit — asserted by
  both harnesses.

### 4. Weather & time of day (in WASM)
- A keyframed palette table: warm morning → harsh midday → purple/orange dusk →
  lantern-lit night, sampled with smootherstep.
- A weighted state machine **Calm → Cloudy → Windy → Thunderstorm** with
  9–17 s smootherstep cross-fades and 22–46 s holds, then modulated by layered
  fbm so wind gusts, rain density and cloud cover never look switched.
- Lightning is a double-strike exponential envelope; thunder is scheduled with
  a distance-scaled delay and low-end, so the clap arrives *after* the flash.
- ~3 000 particles (rain, mist, wind streaks, dust, glow motes, sparks, embers)
  integrated in WASM and drawn as one instanced batch.

### 5. Flow & UI
- **Title**: a static morning landscape — tethered balloon, rope with catenary
  sag, ground post, traveler with a lantern, flocking birds, calm weather.
- **Cinematic start**: the UI dissolves, the rope snaps (dust + embers), the
  balloon rises on an ease-out cubic to its anchor, and only then does the
  parallax start scrolling into the run.
- **HUD**: hearts top-left, high score top-right, weather state + in-world clock
  top-centre, altitude bottom-left — all rendered with the generated bitmap
  font *inside* the same pipeline, so the UI blooms with the world.

### 6. Audio
Fully procedural WebAudio (no sample files): filtered brown-noise wind whose
band-pass follows gust strength, rain beds, a drone whose pitch drops at night,
burner whooshes, thunder with a sub-body thump, impacts and UI blips.

---

## Architecture

```
wasm/assembly/          WebAssembly simulation core (AssemblyScript)
  layout.ts             memory contract (mirrored + version-asserted)
  math.ts               world + fx xorshift streams, hashed value noise, fbm
  weather.ts            day/night palette + weather state machine
  chunks.ts             chunk generation + provably-fair corridor
  particles.ts          3072-particle pool, swap-remove compaction
  index.ts              exported ABI

src/
  sim/                  SimCore.ts (loader, zero-copy views) + layout.ts
  core/                 Time (fixed 60 Hz), Input, Storage, Audio, Random
  main.ts               boot: progress overlay, URL parameters, error surface
  art/                  PixelCanvas, NormalMap, Atlas, Sprites, Font
  render/               GL, RenderTarget, SpriteBatch, Camera, Pipeline, shaders
  systems/              PlayerController, ProceduralGenManager, ParallaxManager,
                        WeatherTimeManager, CollisionSystem, UIManager,
                        ParticleManager
  entities/             Pools (Obstacle, Decor)
  flow/                 Game (state machine + frame loop)
tools/
  verify.mjs            simulation + art + asset invariants (39 checks)
  artcheck.mjs          bakes the atlas headlessly, proves every sprite name,
                        entity id and glyph resolves (10 checks)
  headless.mjs          boots the real game against a mock DOM/WebGL2 and plays
                        it for ~60 s: flow, controls, collisions, soak, leak and
                        determinism checks (60 checks)
.github/workflows/      build → typecheck → verify → play → GitHub Pages deploy
```

## Testing

There is no browser in CI, so the game is verified three ways in Node instead:

| harness | what it proves |
| --- | --- |
| `npm run verify` | the WASM core: 400 chunks are flood-fill survivable, pools never overflow, weather visits all four states, lightning/thunder fire, particles stay finite, **and** cosmetic churn cannot re-author a seeded world |
| `npm run verify:art` | the generated art: the atlas bakes, every sprite name / entity id / bitmap-font glyph the code asks for actually exists, normal maps carry relief, 16 sprites glow |
| `npm run test:headless` | the assembled game: it boots, the ABI matches the binary, title → launch → play → pause → gameover → restart all work, steering and wind fight each other correctly, collisions cost exactly one life, a 40 s soak leaks nothing (WASM memory flat, zero dropped spawns), no NaN ever reaches a vertex buffer or a uniform, every uniform name exists in the shader it is set on, and two runs of one seed produce identical traces |

Together that is 109 automated checks; `npm run ci` runs all of them plus
typecheck and the production build.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data-flow diagram,
the frame budget and the WASM ABI.

## CI/CD

`.github/workflows/ci.yml` runs on every push and PR:
`npm ci` → compile WASM → `tsc --noEmit` → `vite build` → verify the simulation,
art and asset invariants → **play the game headlessly** against a mock WebGL2,
then publishes `dist/` to **GitHub Pages** (`main` only). No binary assets are
committed; the `.wasm` is rebuilt from source on every run.

Once this branch is merged, the game is live at
`https://rohanroor.github.io/playTest/` (the build uses relative paths, so any
static host works).

## Checklist

- [x] WASM simulation core (weather, time of day, chunks, particles) + verify harness
- [x] Renderer: instanced normal-mapped sprite batch, sky, volumetric fog, bloom, grade
- [x] Procedural art pipeline: sprites, height→normal, atlas, bitmap font
- [x] Systems: player, procedural generation, parallax, weather/time, collision, UI
- [x] Flow: `flow/Game.ts` state machine + fixed-timestep loop, `main.ts` boot
- [x] ParticleManager: velocity-aligned rain, additive sparks/embers/motes, depth parallax
- [x] Test harnesses: simulation invariants, headless art bake, mock-WebGL2 play-through
- [x] CI/CD: build, typecheck, verify, headless play-through, GitHub Pages deploy
- [x] Determinism: split world/fx RNG streams, seeded host dice, `?seed=` replay
