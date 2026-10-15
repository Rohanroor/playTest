/**
 * Font - a 5x7 pixel bitmap typeface generated into the atlas.
 *
 * The UI needs exactly one thing from typography: to look like it belongs to
 * the same pixel-art world as the balloon. Glyphs are 5x7 in a 6x8 cell, drawn
 * emissive so the bloom pass makes the score and hearts glow gently at night.
 */

import { PixelCanvas, hex } from "./PixelCanvas";
import { Atlas } from "./Atlas";
import type { AtlasRegion } from "./Atlas";

const CELL_W = 6;
const CELL_H = 8;
const COLS = 16;

/** 7 rows of 5 bits per glyph, top row first. */
const GLYPHS: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10011, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  ".": [0, 0, 0, 0, 0, 0b01100, 0b01100],
  ",": [0, 0, 0, 0, 0b01100, 0b00100, 0b01000],
  ":": [0, 0b01100, 0b01100, 0, 0b01100, 0b01100, 0],
  "!": [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
  "?": [0b01110, 0b10001, 0b00001, 0b00110, 0b00100, 0, 0b00100],
  "'": [0b00100, 0b00100, 0, 0, 0, 0, 0],
  "-": [0, 0, 0, 0b11111, 0, 0, 0],
  "+": [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
  "/": [0b00001, 0b00010, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000],
  "%": [0b11001, 0b11010, 0b00010, 0b00100, 0b01000, 0b01011, 0b10011],
  "(": [0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010],
  ")": [0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000],
  "<": [0b00010, 0b00100, 0b01000, 0b10000, 0b01000, 0b00100, 0b00010],
  ">": [0b01000, 0b00100, 0b00010, 0b00001, 0b00010, 0b00100, 0b01000],
  "*": [0, 0b10101, 0b01110, 0b11111, 0b01110, 0b10101, 0],
  "#": [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010],
  "=": [0, 0, 0b11111, 0, 0b11111, 0, 0],
  m: [0, 0, 0b10001, 0b10101, 0b10101, 0b10001, 0b10001], // lowercase for "m" in units
};

export interface GlyphMetrics {
  char: string;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export class Font {
  readonly region: AtlasRegion;
  private glyphs = new Map<string, GlyphMetrics>();
  readonly cellW = CELL_W;
  readonly cellH = CELL_H;

  constructor(region: AtlasRegion, atlasSize: number, chars: string[]) {
    this.region = region;
    chars.forEach((char, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const px = region.x + col * CELL_W;
      const py = region.y + row * CELL_H;
      this.glyphs.set(char, {
        char,
        u0: px / atlasSize,
        v0: py / atlasSize,
        u1: (px + 5) / atlasSize,
        v1: (py + 7) / atlasSize,
      });
    });
  }

  glyph(char: string): GlyphMetrics | undefined {
    return this.glyphs.get(char) ?? this.glyphs.get(char.toUpperCase());
  }

  /** Width of a string in glyph cells (5px glyph + 1px tracking). */
  measure(text: string, scale: number): number {
    return text.length * CELL_W * scale;
  }

  static get chars(): string[] {
    return Object.keys(GLYPHS);
  }
}

/** Paints the whole typeface into one atlas-sized canvas. */
export function buildFontAtlas(atlas: Atlas): string {
  const chars = Font.chars;
  const rows = Math.ceil(chars.length / COLS);
  const pc = new PixelCanvas(COLS * CELL_W, rows * CELL_H);
  const ink = hex(0xfff4e0);
  const inkCool = hex(0xd8e8ff);

  chars.forEach((char, i) => {
    const bits = GLYPHS[char];
    if (!bits) return;
    const ox = (i % COLS) * CELL_W;
    const oy = Math.floor(i / COLS) * CELL_H;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if ((bits[r] >> (4 - c)) & 1) {
          // Slight top-light so the type has body under the normal map.
          const col = r < 3 ? ink : inkCool;
          pc.px(ox + c, oy + r, col, 255, 0.85 - r * 0.05, 0.55);
        }
      }
    }
  });

  atlas.add("font", pc, { strength: 1.1, ao: 0.2, pivot: [0, 0] });
  return "font";
}
