/**
 * Camera - the cinematic 2.5D viewport.
 *
 * The camera never moves horizontally in world space (the balloon is locked to
 * a fixed screen Y and the world scrolls down past it); instead it owns:
 *   - the integer pixel scale that gives the render its crisp pixel-art grid
 *   - a lean that follows the player and the wind (parallax-correct per layer)
 *   - impact shake with independent horizontal/vertical decay
 *   - the accumulated world scroll used by every parallax layer
 */

import { hostRng } from "../core/Random";

export interface CameraState {
  offsetX: number;
  offsetY: number;
  shake: number;
}

export class Camera {
  /** Internal (pixel-art) resolution. */
  internalW = 480;
  internalH = 270;
  /** Integer display pixels per internal pixel. */
  pixelScale = 4;
  /** Device pixel ratio, clamped for sanity on 3x phones. */
  dpr = 1;
  /** Viewport size in world units (width is always exactly 1). */
  viewW = 1;
  viewH = 0.5625;
  /** Pixels per world unit at the internal resolution. */
  pixelsPerWorldUnit = 480;

  /** Accumulated downward world scroll (the illusion of ascent). */
  scrollY = 0;
  /** Camera lean in world units (player position + wind). */
  leanX = 0;
  private leanTarget = 0;
  /** Shake state. */
  private shakeMag = 0;
  private shakeTime = 0;
  private shakeDuration = 1;
  private shakeSeed = 12.3;
  shakeX = 0;
  shakeY = 0;

  /** Target internal height in pixels; the scale is derived from it. */
  private readonly targetInternalHeight: number;

  constructor(targetInternalHeight = 300) {
    this.targetInternalHeight = targetInternalHeight;
  }

  /**
   * Fit the internal pixel grid to the display. The scale is an integer so the
   * upscale in the composite pass lands exactly on pixel boundaries.
   */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): boolean {
    this.dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
    const fbW = Math.max(1, Math.round(cssWidth * this.dpr));
    const fbH = Math.max(1, Math.round(cssHeight * this.dpr));

    const scale = Math.max(1, Math.min(8, Math.round(fbH / this.targetInternalHeight)));
    const internalW = Math.max(64, Math.round(fbW / scale));
    const internalH = Math.max(64, Math.round(fbH / scale));

    const changed = scale !== this.pixelScale || internalW !== this.internalW || internalH !== this.internalH;
    this.pixelScale = scale;
    this.internalW = internalW;
    this.internalH = internalH;
    this.viewW = 1;
    this.viewH = internalH / internalW;
    this.pixelsPerWorldUnit = internalW;
    return changed;
  }

  /** Framebuffer size in device pixels. */
  get fbWidth(): number {
    return Math.max(1, Math.round(this.internalW * this.pixelScale));
  }

  get fbHeight(): number {
    return Math.max(1, Math.round(this.internalH * this.pixelScale));
  }

  /** Ask for an impact shake. */
  addShake(magnitude: number, duration = 0.45): void {
    this.shakeMag = Math.min(0.05, Math.max(this.shakeMag, magnitude));
    this.shakeDuration = Math.max(this.shakeDuration * (this.shakeTime / this.shakeDuration), duration);
    this.shakeTime = duration;
    this.shakeSeed = hostRng.next() * 100;
  }

  setLean(target: number): void {
    this.leanTarget = target;
  }

  update(dt: number): void {
    // Lean is critically damped so the horizon never snaps.
    const k = 1 - Math.pow(0.001, dt);
    this.leanX += (this.leanTarget - this.leanX) * k;

    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt);
      const t = this.shakeTime / Math.max(0.0001, this.shakeDuration);
      const decay = t * t;
      const s = this.shakeMag * decay;
      const p = this.shakeSeed + (this.shakeDuration - this.shakeTime) * 26;
      this.shakeX = (Math.sin(p * 2.1) * 0.6 + Math.sin(p * 5.3) * 0.4) * s;
      this.shakeY = (Math.cos(p * 1.7) * 0.5 + Math.sin(p * 6.1) * 0.5) * s * 0.7;
      if (this.shakeTime === 0) this.shakeMag = 0;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /**
   * Per-layer camera offset. `depth` is the parallax factor (0.05 for far
   * mountains .. 2.2 for foreground clouds), so distant layers barely feel the
   * lean and the shake while near layers swing hard - the core 2.5D cue.
   */
  offsetFor(depth: number): [number, number] {
    const d = Math.min(1.6, Math.max(0.05, depth));
    return [this.leanX * d + this.shakeX * d, this.shakeY * d];
  }

  /** World Y (y-down) for a piece of content at a given parallax depth. */
  scrollOffsetFor(depth: number): number {
    return this.scrollY * depth;
  }

  reset(): void {
    this.scrollY = 0;
    this.leanX = 0;
    this.leanTarget = 0;
    this.shakeMag = 0;
    this.shakeTime = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }

  state(): CameraState {
    return { offsetX: this.leanX + this.shakeX, offsetY: this.shakeY, shake: this.shakeMag };
  }
}
