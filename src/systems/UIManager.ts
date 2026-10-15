/**
 * UIManager - heads-up display, drawn with the same instanced sprite batch as
 * the world so it picks up bloom and sits inside the same colour pipeline.
 *
 *   top-left      lives (Mario-style hearts, with a pop when one is lost)
 *   top-right     high score
 *   top-centre    weather state + in-world clock
 *   bottom        altitude / score readout
 *   overlays      title, cinematic prompts, pause, game over
 *
 * `alpha` is the master fade used by the launch cinematic: the UI dissolves as
 * the rope is cut and returns once the balloon reaches its anchor.
 */

import type { Atlas, AtlasRegion } from "../art/Atlas";
import type { Font } from "../art/Font";
import type { Camera } from "../render/Camera";
import type { SpriteBatch } from "../render/SpriteBatch";
import type { WeatherTimeManager } from "./WeatherTimeManager";

export type UiMode = "title" | "launch" | "play" | "paused" | "gameover";

const INK: [number, number, number] = [1.0, 0.96, 0.88];
const INK_SHADOW: [number, number, number] = [0.06, 0.07, 0.13];
const ACCENT: [number, number, number] = [1.0, 0.78, 0.45];
const COOL: [number, number, number] = [0.68, 0.82, 1.0];

export class UIManager {
  alpha = 1;
  mode: UiMode = "title";
  score = 0;
  best = 0;
  lives = 3;
  maxLives = 3;
  newBest = false;
  /** Set by the game when a life is lost, drives the heart pop. */
  private lifeLostTimer = 0;
  private bestFlash = 0;
  private promptTimer = 0;
  /** UI pixel scale relative to the atlas' 5x7 glyph grid. */
  private textScale = 2;

  constructor(
    private atlas: Atlas,
    private font: Font,
    private camera: Camera,
  ) {}

  reset(mode: UiMode, best: number): void {
    this.mode = mode;
    this.best = best;
    this.score = 0;
    this.lives = this.maxLives;
    this.newBest = false;
    this.lifeLostTimer = 0;
    this.bestFlash = 0;
    this.alpha = mode === "launch" ? 0 : 1;
  }

  setMode(mode: UiMode): void {
    this.mode = mode;
  }

  onLifeLost(): void {
    this.lifeLostTimer = 1;
  }

  onNewBest(): void {
    this.newBest = true;
    this.bestFlash = 1;
  }

  update(dt: number): void {
    this.promptTimer += dt;
    if (this.lifeLostTimer > 0) this.lifeLostTimer = Math.max(0, this.lifeLostTimer - dt * 2.2);
    if (this.bestFlash > 0) this.bestFlash = Math.max(0, this.bestFlash - dt * 0.8);
  }

  private px(pixels: number): number {
    return pixels / this.camera.pixelsPerWorldUnit;
  }

  /** Draw a string. align: 0 left, 0.5 centre, 1 right. */
  /** Reused per glyph: text is drawn twice per string (shadow + face). */
  private readonly glyphRegion: AtlasRegion = {
    name: "font-glyph",
    u0: 0,
    v0: 0,
    u1: 0,
    v1: 0,
    w: 5,
    h: 7,
    x: 0,
    y: 0,
    pivotX: 0,
    pivotY: 0,
  };

  private text(
    batch: SpriteBatch,
    str: string,
    x: number,
    y: number,
    scale: number,
    align: number,
    color: [number, number, number],
    alpha: number,
    shadow = true,
    emissive = 0.15,
  ): void {
    if (alpha <= 0.01) return;
    const cellW = this.px(6 * scale);
    const glyphW = this.px(5 * scale);
    const glyphH = this.px(7 * scale);
    const width = str.length * cellW;
    const startX = x - width * align;
    const shadowOff = this.px(scale * 0.9);

    for (let pass = 0; pass < (shadow ? 2 : 1); pass++) {
      const isShadow = pass === 0 && shadow;
      const col = isShadow ? INK_SHADOW : color;
      const a = isShadow ? alpha * 0.75 : alpha;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === " ") continue;
        const g = this.font.glyph(ch);
        if (!g) continue;
        const r = this.glyphRegion;
        r.u0 = g.u0;
        r.v0 = g.v0;
        r.u1 = g.u1;
        r.v1 = g.v1;
        batch.push(
          r,
          startX + i * cellW + (isShadow ? shadowOff : 0),
          y + (isShadow ? shadowOff : 0),
          glyphW,
          glyphH,
          0,
          col[0],
          col[1],
          col[2],
          a,
          isShadow ? 0 : emissive,
          0.35,
          0,
          0,
          false,
        );
      }
    }
  }

  private sprite(batch: SpriteBatch, name: string, x: number, y: number, pixels: number, color: [number, number, number], alpha: number, emissive = 0): void {
    const region = this.atlas.region(name);
    const aspect = region.w / Math.max(1, region.h);
    const h = this.px(pixels);
    batch.push(region, x, y, h * aspect, h, 0, color[0], color[1], color[2], alpha, emissive, 0.6, 0.25, 0, false);
  }

  render(batch: SpriteBatch, weather: WeatherTimeManager, time: number): void {
    const viewW = this.camera.viewW;
    const viewH = this.camera.viewH;
    const margin = Math.max(0.018, this.px(10));

    if (this.mode === "title") {
      this.renderTitle(batch, viewW, viewH, margin, time);
      return;
    }

    const a = this.alpha;
    if (a <= 0.01 && this.mode !== "gameover") return;

    // --- lives (top-left) ----------------------------------------------------
    const heartPx = 13 * this.textScale * 0.95;
    const heartW = this.px(heartPx) * 1.08;
    for (let i = 0; i < this.maxLives; i++) {
      const filled = i < this.lives;
      const pop = filled && this.lifeLostTimer > 0 && i === this.lives ? this.lifeLostTimer : 0;
      const scale = 1 + pop * 0.35;
      const x = margin + heartW * (i + 0.5) * scale;
      const y = margin + this.px(heartPx) * 0.5;
      const region = this.atlas.region(filled ? "heart_full" : "heart_empty");
      const h = this.px(heartPx * scale);
      const aspect = region.w / region.h;
      batch.push(
        region,
        x,
        y,
        h * aspect,
        h,
        0,
        filled ? 1 : 0.45,
        filled ? 1 : 0.42,
        filled ? 1 : 0.55,
        a * (filled ? 1 : 0.55),
        filled ? 0.18 : 0,
        0.7,
        0.3,
        0,
        false,
      );
    }

    // --- high score (top-right) ---------------------------------------------
    const bestStr = padScore(Math.max(this.best, this.score));
    this.text(batch, "BEST", viewW - margin, margin + this.px(4), this.textScale * 0.82, 1, COOL, a * 0.7, true, 0.05);
    this.text(
      batch,
      bestStr,
      viewW - margin,
      margin + this.px(12),
      this.textScale,
      1,
      this.bestFlash > 0 ? mixColor(INK, ACCENT, this.bestFlash) : INK,
      a,
      true,
      0.2 + this.bestFlash * 0.5,
    );

    // --- weather + clock (top-centre) ----------------------------------------
    const label = `${weather.stateName.toUpperCase()}  ${weather.clockLabel}`;
    this.text(batch, label, viewW * 0.5, margin + this.px(3), this.textScale * 0.78, 0.5, mixColor(COOL, INK, 0.25), a * 0.62, true, 0.06);

    // --- altitude (bottom-left) ----------------------------------------------
    const alt = `${padScore(this.score)} M`;
    this.text(batch, alt, margin, viewH - margin - this.px(10), this.textScale * 1.35, 0, INK, a * 0.95, true, 0.22);
    this.text(batch, "ALTITUDE", margin, viewH - margin - this.px(2), this.textScale * 0.7, 0, COOL, a * 0.5, true, 0.04);

    if (this.newBest && a > 0.05) {
      const pulse = 0.7 + 0.3 * Math.sin(time * 6);
      this.text(batch, "NEW RECORD", viewW - margin, viewH - margin - this.px(6), this.textScale * 0.85, 1, ACCENT, a * pulse, true, 0.5);
    }

    if (this.mode === "paused") {
      this.dim(batch, viewW, viewH, 0.55);
      this.text(batch, "PAUSED", viewW * 0.5, viewH * 0.44, this.textScale * 3, 0.5, INK, 1, true, 0.3);
      this.text(batch, "P TO RESUME", viewW * 0.5, viewH * 0.56, this.textScale, 0.5, COOL, 0.8, true, 0.1);
    }

    if (this.mode === "gameover") {
      this.dim(batch, viewW, viewH, 0.5);
      const y = viewH * 0.36;
      this.text(batch, "RUN ENDED", viewW * 0.5, y, this.textScale * 2.4, 0.5, INK, 1, true, 0.28);
      this.text(batch, `${padScore(this.score)} M`, viewW * 0.5, y + this.px(26), this.textScale * 1.6, 0.5, ACCENT, 1, true, 0.35);
      this.text(batch, `BEST ${padScore(Math.max(this.best, this.score))} M`, viewW * 0.5, y + this.px(44), this.textScale, 0.5, COOL, 0.9, true, 0.12);
      const blink = 0.45 + 0.55 * Math.abs(Math.sin(this.promptTimer * 2.1));
      this.text(batch, "R  RELAUNCH", viewW * 0.5, y + this.px(66), this.textScale * 1.1, 0.5, INK, blink, true, 0.25);
      this.text(batch, "ESC  RETURN TO THE FIELD", viewW * 0.5, y + this.px(82), this.textScale * 0.85, 0.5, COOL, 0.7, true, 0.08);
    }
  }

  private renderTitle(batch: SpriteBatch, viewW: number, viewH: number, margin: number, time: number): void {
    const a = this.alpha;
    const cx = viewW * 0.5;

    // Title lockup, high in the frame so the landscape stays visible.
    const titleY = viewH * 0.16;
    this.text(batch, "ASCENSION", cx, titleY, this.textScale * 5.2, 0.5, INK, a, true, 0.35);
    this.text(batch, "A BALLOON ODYSSEY", cx, titleY + this.px(46), this.textScale * 1.05, 0.5, ACCENT, a * 0.9, true, 0.2);

    // Rules line - thin and quiet, pixel-art credits style.
    this.text(batch, "WEATHER THAT MOVES. LIGHT THAT ANSWERS.", cx, titleY + this.px(62), this.textScale * 0.72, 0.5, COOL, a * 0.55, true, 0.05);

    // Prompt, breathing.
    const blink = 0.4 + 0.6 * Math.abs(Math.sin(this.promptTimer * 1.9));
    this.text(batch, "PRESS SPACE OR TAP TO LAUNCH", cx, viewH * 0.52, this.textScale * 1.25, 0.5, INK, a * blink, true, 0.3);

    // Controls block.
    const cy = viewH - margin - this.px(30);
    this.text(batch, "MOVE   ARROWS / A D / DRAG", cx, cy, this.textScale * 0.82, 0.5, COOL, a * 0.72, true, 0.06);
    this.text(batch, "PAUSE  P        SOUND  M        STATS  `", cx, cy + this.px(11), this.textScale * 0.82, 0.5, COOL, a * 0.55, true, 0.06);

    if (this.best > 0) {
      this.text(batch, `BEST ALTITUDE  ${padScore(this.best)} M`, cx, viewH - margin - this.px(6), this.textScale * 0.95, 0.5, ACCENT, a * 0.85, true, 0.22);
    }

    // Little decorative pips flanking the prompt.
    const pip = 0.5 + 0.5 * Math.sin(time * 2.4);
    this.sprite(batch, "pip", cx - this.px(122), viewH * 0.52 + this.px(3), 5, ACCENT, a * (0.35 + pip * 0.5), 0.6);
    this.sprite(batch, "pip", cx + this.px(122), viewH * 0.52 + this.px(3), 5, ACCENT, a * (0.35 + (1 - pip) * 0.5), 0.6);
  }

  private dim(batch: SpriteBatch, viewW: number, viewH: number, amount: number): void {
    const soft = this.atlas.region("p_soft");
    batch.pushRect(soft, viewW * 0.5, viewH * 0.5, viewW * 1.05, viewH * 1.05, 0.02, 0.03, 0.07, amount, 0, 0, 0, 0);
  }
}

function padScore(n: number): string {
  const s = Math.max(0, Math.floor(n)).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function mixColor(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
