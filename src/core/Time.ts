/**
 * Time - fixed-timestep accumulator with interpolation alpha.
 *
 * The simulation (WASM) runs at a locked 60 Hz so gameplay is identical on a
 * 30 fps phone and a 240 Hz monitor; the renderer interpolates with `alpha`
 * and can spin faster or slower than the sim.
 */

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
/** Never simulate more than this many steps in one frame (spiral-of-death guard). */
export const MAX_STEPS_PER_FRAME = 5;

export class Time {
  /** Seconds since the page became interactive. */
  now = 0;
  /** Raw frame delta, clamped. */
  frameDelta = 0;
  /** Fixed sim delta. */
  readonly dt = SIM_DT;
  /** 0..1 interpolation factor between the last and next sim step. */
  alpha = 0;
  /** Frame counter. */
  frames = 0;
  /** Smoothed frames-per-second. */
  fps = 60;
  /** Smoothed simulation cost in milliseconds. */
  simMs = 0;
  /** Smoothed render cost in milliseconds. */
  renderMs = 0;
  /** Global time scale (used by the cinematic slow-mo on launch/death). */
  scale = 1;
  /** True while the tab is hidden - the loop pauses instead of exploding. */
  paused = false;

  private accumulator = 0;
  private last = 0;
  private started = false;

  begin(timestampMs: number): void {
    this.last = timestampMs;
    this.started = true;
  }

  /** Returns the number of fixed steps to run this frame. */
  tick(timestampMs: number): number {
    if (!this.started) {
      this.begin(timestampMs);
      return 0;
    }
    const rawDelta = (timestampMs - this.last) / 1000;
    this.last = timestampMs;
    // Clamp huge deltas (tab switch, debugger pause) so we never fast-forward.
    const delta = Math.min(Math.max(rawDelta, 0), 0.25);
    this.frameDelta = delta;
    this.now += delta * this.scale;
    this.frames++;

    const fpsInstant = delta > 0 ? 1 / delta : 60;
    this.fps += (fpsInstant - this.fps) * 0.08;

    this.accumulator += delta * this.scale;
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    this.alpha = Math.min(1, this.accumulator / SIM_DT);
    return steps;
  }

  /** Eased time-scale transition for cinematic moments. */
  approachScale(target: number, dt: number, rate = 3): void {
    this.scale += (target - this.scale) * Math.min(1, dt * rate);
  }

  reset(): void {
    this.accumulator = 0;
    this.scale = 1;
  }
}
