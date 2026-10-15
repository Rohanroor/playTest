/**
 * Random - the host-side dice.
 *
 * Two rules keep a seeded run bit-reproducible:
 *
 *   1. Gameplay randomness lives in the WASM core's *world* stream (see
 *      `SimCore.random()`), drained only by fixed-timestep simulation code.
 *   2. Cosmetic host randomness (ember bursts, camera shake seeds, lightning
 *      placement, graze ticks) comes from this generator, never `Math.random()`.
 *
 * With both in place, `?seed=1234` replays the identical run - same world, same
 * weather, same visuals - which is what makes replays, golden screenshots and
 * the headless CI trace comparison possible. Audio noise buffers are the one
 * deliberate exception: they are textures, not gameplay, and stay on
 * `Math.random()` so every session sounds subtly different.
 */

/** Module-level generator, reseeded by `Game.create()`. */
export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** mulberry32: 32-bit state, excellent distribution, one imul per draw. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Integer in [0, n). */
  pick(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }

  reseed(seed: number): void {
    this.state = (seed >>> 0) || 0x9e3779b9;
    // Warm up so nearby seeds do not share an opening sequence.
    for (let i = 0; i < 8; i++) this.next();
  }
}

/** Shared cosmetic generator. */
export const hostRng = new Rng();

/** Seed the cosmetic stream; called once per boot with the run seed. */
export function seedHostRng(seed: number): void {
  hostRng.reseed(seed ^ 0x85ebca6b);
}
