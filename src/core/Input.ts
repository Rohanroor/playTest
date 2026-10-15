/**
 * Input - keyboard + pointer/touch unified into one analogue axis.
 *
 * The player only ever moves horizontally, so everything collapses into a
 * single `axis` in [-1, 1] plus a couple of edge-triggered actions. Pointer
 * input is *absolute* (drag to position) while keys are *rate* based; the
 * player controller blends them so neither feels bolted on.
 */

export type Action = "start" | "pause" | "hud" | "mute" | "restart" | "debugWeather";

const KEY_AXIS: Record<string, number> = {
  ArrowLeft: -1,
  KeyA: -1,
  ArrowRight: 1,
  KeyD: 1,
};

const KEY_ACTION: Record<string, Action> = {
  Space: "start",
  Enter: "start",
  NumpadEnter: "start",
  KeyP: "pause",
  Escape: "pause",
  Backquote: "hud",
  KeyM: "mute",
  KeyR: "restart",
  KeyW: "debugWeather",
};

export class Input {
  /** -1..1 analogue horizontal intent from the keyboard. */
  keyAxis = 0;
  /** -1..1 analogue horizontal intent from pointer drag (absolute position). */
  pointerAxis = 0;
  /** Normalised pointer target in [0,1] screen width, or null if unused. */
  pointerTarget: number | null = null;
  pointerActive = false;
  /** True on the frame an action was first pressed. */
  private pressed = new Set<Action>();
  private consumed = new Set<Action>();
  enabled = true;

  private downKeys = new Set<string>();
  private detach: (() => void)[] = [];

  attach(target: HTMLElement): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) {
        if (KEY_AXIS[e.code] !== undefined) e.preventDefault();
        return;
      }
      this.downKeys.add(e.code);
      const action = KEY_ACTION[e.code];
      if (action) {
        this.pressed.add(action);
        // Space/arrows would scroll the page in a browser.
        e.preventDefault();
      }
      if (KEY_AXIS[e.code] !== undefined) e.preventDefault();
      this.recomputeKeyAxis();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.downKeys.delete(e.code);
      this.recomputeKeyAxis();
    };
    const onBlur = () => {
      this.downKeys.clear();
      this.keyAxis = 0;
      this.pointerActive = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!this.enabled) return;
      this.pointerActive = true;
      this.updatePointer(e, target);
      this.pressed.add("start"); // tap anywhere also confirms on the title screen
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!this.pointerActive || !this.enabled) return;
      this.updatePointer(e, target);
    };
    const onPointerUp = () => {
      this.pointerActive = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    target.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    this.detach.push(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      target.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    });
  }

  private updatePointer(e: PointerEvent, target: HTMLElement): void {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const nx = (e.clientX - rect.left) / rect.width;
    this.pointerTarget = Math.min(1, Math.max(0, nx));
    this.pointerAxis = Math.min(1, Math.max(-1, (nx - 0.5) * 2));
    if (e.pointerType !== "mouse") e.preventDefault();
  }

  private recomputeKeyAxis(): void {
    let axis = 0;
    for (const code of this.downKeys) {
      const v = KEY_AXIS[code];
      if (v !== undefined) axis += v;
    }
    this.keyAxis = Math.min(1, Math.max(-1, axis));
  }

  /** Edge-triggered query; each press is consumed once per frame. */
  justPressed(action: Action): boolean {
    if (this.pressed.has(action) && !this.consumed.has(action)) {
      this.consumed.add(action);
      return true;
    }
    return false;
  }

  /** Call at the end of every frame. */
  endFrame(): void {
    this.consumed.clear();
    this.pressed.clear();
  }

  detachAll(): void {
    for (const fn of this.detach) fn();
    this.detach.length = 0;
  }
}
