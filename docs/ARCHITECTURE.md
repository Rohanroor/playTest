# ASCENSION — Architecture

This document is the technical companion to the GDD. It covers the WASM ABI,
the frame budget, the render pipeline and the reasoning behind the module
boundaries.

---

## 1. Why the simulation lives in WebAssembly

The GDD demands an *infinite* run with no memory leaks and a WASM target. Two
systems dominate the per-frame cost and are pure arithmetic — procedural chunk
generation, weather/time-of-day, and a few thousand particles. Both were moved
into a compiled module:

- **Determinism.** A seeded `xorshift32` + hashed value noise means chunk *N* is
  identical for a given seed, on every machine and every run. That is what makes
  the fairness harness in `tools/verify.mjs` meaningful.
- **Zero-copy boundary.** The module exposes raw pointers into linear memory;
  the host wraps them in `Float32Array` views and reads simulation state without
  marshalling or allocation (`src/sim/SimCore.ts`).
- **Portability.** Because *all* gameplay state is produced by the module, a
  future Bevy/Godot port replaces the renderer, not the game rules.

The boundary is versioned: `layoutVersion()` is asserted against
`LAYOUT_VERSION` in `src/sim/layout.ts` at boot, so a stale binary fails loudly
instead of rendering garbage.

## 2. WASM ABI

| Export | Purpose |
| --- | --- |
| `simInit(seed)` / `simReset(seed)` | seed the RNG, build the palette + weather tables, clear the particle pool |
| `simDayLength(s)` / `simDayPhase(p)` | time-of-day control (title screen boots into early morning) |
| `simForceWeather(state)` | debug/attract-mode override of the state machine |
| `simWeatherStep(dt, altitude, scroll)` | advance day/night + weather, write the 40-float weather struct |
| `simGenerateChunk(index, difficulty, wind, cover, storm)` | fill the obstacle + decor manifests |
| `simObstacleCount()` / `simDecorCount()` | manifest lengths |
| `simCorridorCenter(y)` / `simCorridorHalfWidth()` | the guaranteed-safe corridor of the last chunk (debug overlay + tests) |
| `simParticlesStep(dt, view, weather…, scroll, lean, lightning, night)` | integrate + emit particles |
| `simEmitBurst(x, y, count, type, spread, speed, life, size)` | one-shot bursts (impacts, rope snap, burner) |
| `weatherPtr` / `obstaclePtr` / `decorPtr` / `particlePtr` | pointers for zero-copy views |
| `simNoise2` / `simFbm2` / `simRandom` | host access to the same noise family |

### Memory layout

Flat `Float32Array`s with fixed strides (`wasm/assembly/layout.ts`):

```
weather   : 40 floats   time of day, sun elevation/azimuth, cloud cover, wind,
                        gust, rain, fog, lightning, thunder counter, sky/sun/
                        ambient/fog/cloud RGB, exposure, lantern, state, blend,
                        storm, difficulty, star alpha, shadow softness, altitude
obstacles : 12 floats × ≤14 per chunk
decor     : 10 floats × ≤30 per chunk
particles : 12 floats × 3072 (pool, swap-remove compaction)
```

**Units.** The world is normalised so the viewport is exactly **1.0 world units
wide** (height = `1/aspect`). Fixing the *width* keeps the horizontal dodge
space — the only axis the player controls — identical on a phone and an
ultrawide. Manifest `X`, `W`, `H` are world units; `Y` is a fraction of
`CHUNK_HEIGHT`.

## 3. Fairness is a generated invariant

Each chunk carves a **meandering corridor** the player is guaranteed to be able
to follow:

```
corridorAmp  = 0.04 + difficulty·0.10 + jitter
corridorFreq = min(0.7 + difficulty·1.1 + jitter, maxSlope / (amp·2π))
corridorHalf = (0.42 − difficulty·0.10) / 2
```

The frequency is clamped from the amplitude because the corridor's steepest
slope is `amp·freq·2π`, and the player's lateral authority is
`playerSpeed / scrollSpeed ≈ 1.2` normalised-x per unit of scroll-y. A wide
sweep is therefore forced to be slow: the corridor can never outrun the player.

Obstacles are then placed **analytically** outside the corridor. Their reach
includes the player's collision radius and their own wander envelope
(`sway + |drift|·0.6`), and if neither side of the corridor can fit them they
are shrunk until they provably do.

`tools/verify.mjs` rasterises 400 chunks onto a 48×100 grid, inflates every
obstacle by the player radius, and flood-fills reachable cells row by row with a
conservative lateral budget. A chunk is fair iff the last row is reachable.
Current result: **400/400**.

## 4. Frame loop

```
requestAnimationFrame
  └─ Time.tick()                    fixed 60 Hz accumulator (max 5 steps, alpha for lerp)
       ├─ simulate(SIM_DT) × steps
       │    ├─ WeatherTimeManager.update()   simWeatherStep → LightRig, sky/fog/grade params
       │    ├─ Camera.update()               lean damping, shake decay
       │    ├─ ProceduralGenManager.update() chunk streaming, obstacle + decor integration
       │    ├─ ParallaxManager.update()      far-band recycling
       │    ├─ PlayerController.update()     input, wind, banking, pendulum, burner
       │    ├─ CollisionSystem.update()      circle vs OBB
       │    ├─ sim.stepParticles()           rain/mist/streaks/motes/sparks
       │    └─ Audio.update()                wind/rain/drone beds follow the same numbers
       └─ render(alpha)
            ├─ Pipeline.beginScene()         half-float target at internal pixel-art res
            ├─ drawSky()                     gradient, stars, sun/moon, cloud bands
            ├─ ParallaxManager.renderBands() starfield → mountains → haze → ridge
            ├─ ParallaxManager.renderDecor() mid clouds, islets, ruins (layers 0–1)
            ├─ ProceduralGen.renderObstacles()
            ├─ PlayerController.render()     envelope, flame, lantern halo, tether
            ├─ ParticleManager.render()      one instanced batch, depth-sorted
            ├─ drawFog()                     7-step march over the play plane
            ├─ renderDecor(layers 2–3)       near canopies, birds, foreground clouds
            ├─ UIManager.render()            inside the pipeline, so the HUD blooms too
            ├─ bloom()                       bright pass → 3 mips → separable blur → upsample
            └─ composite()                   ACES, grade, vignette, grain, dither, NEAREST upscale
```

Draw calls per frame are effectively constant: **1 sky + 2–4 sprite batches +
1 fog + 9 bloom + 1 composite**, regardless of entity count, because everything
worldly goes through one instanced batch.

## 5. Renderer notes

**Premultiplied alpha, one blend state.** `gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`
with the fragment shader emitting premultiplied colour means opaque cut-out
pixel art, soft cloud edges and additive glows all batch together in painter's
order. Convention: a per-instance `emissive ≥ 1.0` switches that instance to
pure additive (alpha out = 0), which is how halos, sparks, embers and glow motes
are drawn without a second pipeline.

**Pixel-art resolution.** The scene renders at an internal resolution derived
from an integer pixel scale (`Camera.resize` targets ~300 internal rows), and
the composite pass upscales with NEAREST sampling. Sprites are sized from their
atlas pixel dimensions at a constant texel density, so every sprite in the game
shares one pixel size — the thing that usually breaks "high-fidelity pixel art".

**Normal mapping in 2D.** Sprites are camera-aligned quads, so tangent space is
screen space: the decoded normal's green channel is flipped for the y-down world
and rotated by the sprite's rotation. Height fields come from the art pipeline
(`domes` for the envelope, fbm mottling for rock, low strength for clouds).

**HDR fallback.** If `EXT_color_buffer_float` is unavailable the scene target
falls back to `RGBA8` and the bloom threshold drops, so the game still runs on
older mobile drivers.

## 6. Art pipeline (no binary assets)

```
PixelCanvas  →  authored colour + height + emissive per pixel
NormalMap    →  Sobel height→normal, cavity AO baked into albedo
Atlas        →  shelf packing with 1px gutters → two textures
                (albedo NEAREST, material LINEAR so lighting stays smooth)
Sprites/Font →  ~40 sprites + a 5×7 typeface, generated at boot
```

Deterministic, tiny, and CI-reproducible: nothing is downloaded, so a fresh
clone produces byte-identical art.

## 7. Performance & memory discipline

- **No allocation in steady state.** Entity pools with index free-lists,
  pre-allocated `Float32Array` uniform blocks, particle pool in WASM with
  swap-remove compaction, per-frame parameter structs mutated in place.
- **Bounded everything.** 140 obstacles, 240 decor, 3072 particles, 4 point
  lights, 3 bloom mips, 2 queued chunks. Overflow is counted
  (`droppedSpawns`) and surfaced on the dev HUD rather than growing the heap.
- **Fixed timestep.** The simulation is frame-rate independent; the renderer
  interpolates with the accumulator alpha and can drop frames without the game
  speeding up or slowing down.

## 8. Build & CI

```bash
npm run wasm        # asc → public/wasm/sim.wasm (~19 KB, -O3, converged)
npm run typecheck   # tsc --noEmit (strict)
npm run build       # vite build → dist/
npm run verify      # instantiate the wasm in Node and assert invariants
npm run ci          # all of the above
```

`.github/workflows/ci.yml` runs that chain on every push/PR and deploys `dist/`
to GitHub Pages from `main`. The compiled `.wasm` is deliberately **not**
committed — CI rebuilds it from `wasm/assembly`, so the artifact can never drift
from the source.
