/**
 * ASCENSION - boot.
 *
 * Query parameters (handy for testing and for CI screenshots):
 *   ?seed=1234        deterministic world seed
 *   ?hud=1            show the dev HUD overlay (also toggled with `)
 *   ?weather=storm    calm | cloudy | windy | storm - force the opening weather
 *   ?day=0.75         0..1 - force the opening time of day (0.75 = midnight)
 */

import { Game } from "./flow/Game";

const WEATHER_BY_NAME: Record<string, number> = {
  calm: 0,
  cloudy: 1,
  windy: 2,
  storm: 3,
  thunderstorm: 3,
};

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function main(): Promise<void> {
  const canvas = el<HTMLCanvasElement>("game");
  const boot = el<HTMLDivElement>("boot");
  const bootMsg = el<HTMLParagraphElement>("boot-msg");
  const barFill = el<HTMLElement>("bar-fill");
  const bootErr = el<HTMLPreElement>("boot-err");

  if (!canvas) throw new Error("Missing #game canvas");

  const params = new URLSearchParams(window.location.search);
  const seedParam = params.get("seed");
  const weatherParam = (params.get("weather") ?? "").toLowerCase();
  const dayParam = params.get("day");

  const onProgress = (progress: number, message: string): void => {
    if (barFill) barFill.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
    if (bootMsg) bootMsg.textContent = message;
  };

  try {
    const game = await Game.create(canvas, {
      seed: seedParam !== null && Number.isFinite(Number(seedParam)) ? Number(seedParam) : undefined,
      hud: params.has("hud"),
      weather: weatherParam in WEATHER_BY_NAME ? WEATHER_BY_NAME[weatherParam] : undefined,
      onProgress,
    });

    if (dayParam !== null && Number.isFinite(Number(dayParam))) {
      game.sim.setDayPhase(Number(dayParam));
    }

    game.start();

    // Expose the instance for console debugging (harmless in production).
    (window as unknown as { ascension: Game }).ascension = game;

    if (boot) {
      boot.classList.add("hidden");
      window.setTimeout(() => boot.remove(), 900);
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ""}` : String(err);
    if (boot) {
      boot.classList.add("error");
      boot.classList.remove("hidden");
    }
    if (bootMsg) bootMsg.textContent = "The balloon never left the ground.";
    if (barFill) barFill.style.width = "100%";
    if (bootErr) {
      bootErr.hidden = false;
      bootErr.textContent = message;
    }
    // eslint-disable-next-line no-console
    console.error("[ascension] boot failed:", err);
  }
}

// Keep the page from scrolling/zooming under touch input.
window.addEventListener(
  "touchmove",
  (e) => {
    if (e.cancelable) e.preventDefault();
  },
  { passive: false },
);
window.addEventListener("contextmenu", (e) => e.preventDefault());

void main();
