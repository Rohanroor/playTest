/**
 * Pools - fixed-capacity object pools for every gameplay entity.
 *
 * An infinite runner must never allocate during play: a single un-collected
 * reference in a WASM/WebGL app shows up as a stutter or a growing heap. Every
 * obstacle, decor sprite and effect is pre-allocated at boot and recycled
 * through an index free-list, so steady-state play is allocation-free.
 */

export interface Poolable {
  active: boolean;
  poolIndex: number;
}

export class ObjectPool<T extends Poolable> {
  readonly items: T[];
  private free: number[];
  private live = 0;

  constructor(capacity: number, factory: (index: number) => T) {
    this.items = new Array<T>(capacity);
    this.free = new Array<number>(capacity);
    for (let i = 0; i < capacity; i++) {
      this.items[i] = factory(i);
      this.free[i] = capacity - 1 - i;
    }
  }

  get capacity(): number {
    return this.items.length;
  }

  get activeCount(): number {
    return this.live;
  }

  get available(): number {
    return this.free.length;
  }

  obtain(): T | null {
    const idx = this.free.pop();
    if (idx === undefined) return null;
    const item = this.items[idx];
    item.active = true;
    this.live++;
    return item;
  }

  release(item: T): void {
    if (!item.active) return;
    item.active = false;
    this.live--;
    this.free.push(item.poolIndex);
  }

  releaseAll(): void {
    for (const item of this.items) {
      if (item.active) {
        item.active = false;
        this.free.push(item.poolIndex);
      }
    }
    this.live = 0;
  }

  /** Iterate live items. The callback may release the item it is given. */
  each(fn: (item: T) => void): void {
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (item.active) fn(item);
    }
  }
}

// --- Obstacles --------------------------------------------------------------
export interface Obstacle extends Poolable {
  type: number;
  variant: number;
  /** Screen-space world position (y down) and size (world units). */
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  /** Sinusoidal sway around baseX. */
  baseX: number;
  swayAmp: number;
  swayPhase: number;
  swaySpeed: number;
  speedMul: number;
  value: number;
  /** 0..1 white flash when grazed/hit, decays per frame. */
  hitFlash: number;
  /** Atlas region name. */
  sprite: string;
  /** Collision radius (world units) - the forgiving inner hitbox. */
  radius: number;
  /** Frames of grace after spawning so nothing can hit the player instantly. */
  armTime: number;
}

function makeObstacle(i: number): Obstacle {
  return {
    active: false,
    poolIndex: i,
    type: 0,
    variant: 0,
    x: 0,
    y: 0,
    w: 0.1,
    h: 0.1,
    vx: 0,
    vy: 0,
    rot: 0,
    spin: 0,
    baseX: 0,
    swayAmp: 0,
    swayPhase: 0,
    swaySpeed: 1,
    speedMul: 1,
    value: 1,
    hitFlash: 0,
    sprite: "spike_0",
    radius: 0.05,
    armTime: 0,
  };
}

export class ObstaclePool extends ObjectPool<Obstacle> {
  constructor(capacity = 128) {
    super(capacity, makeObstacle);
  }
}

// --- Decor (parallax scenery) ----------------------------------------------
export interface Decor extends Poolable {
  type: number;
  variant: number;
  x: number;
  y: number;
  scale: number;
  parallax: number;
  phase: number;
  tint: number;
  spin: number;
  layer: number;
  sprite: string;
  vx: number;
  /** Animation frame timer (birds flap, ruins flicker). */
  anim: number;
  flip: boolean;
  alpha: number;
}

function makeDecor(i: number): Decor {
  return {
    active: false,
    poolIndex: i,
    type: 0,
    variant: 0,
    x: 0,
    y: 0,
    scale: 1,
    parallax: 1,
    phase: 0,
    tint: 0,
    spin: 0,
    layer: 1,
    sprite: "cloud_0",
    vx: 0,
    anim: 0,
    flip: false,
    alpha: 1,
  };
}

export class DecorPool extends ObjectPool<Decor> {
  constructor(capacity = 220) {
    super(capacity, makeDecor);
  }
}
