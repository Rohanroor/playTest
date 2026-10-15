/**
 * Storage - high score and preferences.
 *
 * localStorage throws in sandboxed iframes and private-mode browsers, so every
 * access is guarded and mirrored in memory. The game must never crash because
 * it could not persist a number.
 */

const KEY_SCORE = "ascension.highscore";
const KEY_MUTE = "ascension.muted";
const KEY_BEST_TIME = "ascension.besttime";

let memory: Record<string, string> = {};
let available = false;

try {
  const probe = "__ascension_probe__";
  window.localStorage.setItem(probe, "1");
  window.localStorage.removeItem(probe);
  available = true;
} catch {
  available = false;
}

function read(key: string): string | null {
  if (available) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      available = false;
    }
  }
  return memory[key] ?? null;
}

function write(key: string, value: string): void {
  memory[key] = value;
  if (available) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      available = false;
    }
  }
}

export const Storage = {
  get persistent(): boolean {
    return available;
  },

  getHighScore(): number {
    const v = Number(read(KEY_SCORE));
    return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  },

  submitScore(score: number): boolean {
    const best = Storage.getHighScore();
    if (score > best) {
      write(KEY_SCORE, String(Math.floor(score)));
      return true;
    }
    return false;
  },

  getBestTime(): number {
    const v = Number(read(KEY_BEST_TIME));
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  },

  submitTime(seconds: number): boolean {
    const best = Storage.getBestTime();
    if (seconds > best) {
      write(KEY_BEST_TIME, seconds.toFixed(2));
      return true;
    }
    return false;
  },

  getMuted(): boolean {
    return read(KEY_MUTE) === "1";
  },

  setMuted(muted: boolean): void {
    write(KEY_MUTE, muted ? "1" : "0");
  },
};
