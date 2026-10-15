/**
 * CollisionSystem - circle vs oriented-box tests for the balloon.
 *
 * The player is a circle (forgiving, and rotationally symmetric like a
 * balloon); obstacles are oriented boxes because debris tumbles. The circle is
 * transformed into each obstacle's local space before the closest-point test,
 * which keeps rotation accurate at essentially zero cost.
 *
 * A hit disarms that obstacle (armTime is pushed far into the future) so one
 * piece of debris can never drain two lives.
 */

import type { ObstaclePool } from "../entities/Pools";
import type { PlayerController } from "./PlayerController";

export interface CollisionEvent {
  x: number;
  y: number;
  obstacleType: number;
  value: number;
}

export class CollisionSystem {
  /** Nearest-miss distance this frame (used for the "graze" audio/feedback). */
  closestApproach = 1;
  /** Total collisions registered since reset. */
  totalHits = 0;

  private event: CollisionEvent = { x: 0, y: 0, obstacleType: 0, value: 1 };
  private hasEvent = false;

  reset(): void {
    this.totalHits = 0;
    this.closestApproach = 1;
    this.hasEvent = false;
  }

  /** Returns the first collision this step, or null. */
  update(player: PlayerController, obstacles: ObstaclePool): CollisionEvent | null {
    this.hasEvent = false;
    this.closestApproach = 1;
    if (player.phase !== "flying") return null;

    const px = player.x;
    const py = player.y;
    const pr = PlayerController.HIT_RADIUS;

    const items = obstacles.items;
    for (let i = 0; i < items.length; i++) {
      const o = items[i];
      if (!o.active || o.armTime > 0) continue;

      // Broad phase: cheap axis-aligned rejection in world space.
      const reach = Math.max(o.w, o.h) * 0.72 + pr;
      const dx = px - o.x;
      const dy = py - o.y;
      if (dx * dx + dy * dy > reach * reach) continue;

      // Narrow phase: rotate the circle into the obstacle's local space.
      const c = Math.cos(-o.rot);
      const s = Math.sin(-o.rot);
      const lx = dx * c - dy * s;
      const ly = dx * s + dy * c;
      const hx = o.w * 0.5;
      const hy = o.h * 0.5;
      const cx = Math.max(-hx, Math.min(hx, lx));
      const cy = Math.max(-hy, Math.min(hy, ly));
      const ddx = lx - cx;
      const ddy = ly - cy;
      const distSq = ddx * ddx + ddy * ddy;

      if (distSq < this.closestApproach * this.closestApproach) {
        this.closestApproach = Math.sqrt(distSq) - pr;
      }

      if (distSq <= pr * pr) {
        o.hitFlash = 1;
        // Disarm until it is recycled off the bottom of the screen.
        o.armTime = 60;
        this.totalHits++;
        this.event.x = o.x;
        this.event.y = o.y;
        this.event.obstacleType = o.type;
        this.event.value = o.value;
        this.hasEvent = true;
        return this.event;
      }
    }
    return null;
  }

  get collided(): boolean {
    return this.hasEvent;
  }
}
