import type { Point } from "./dabs";

/** A press that moves farther than this many pixels is a drag, not a click. */
export const CLICK_MOVE_PX = 4;

/**
 * Tells a click from a drag for gestures that share a button: Alt+click is the eyedropper,
 * Alt+drag orbits. Feed it the press, the moves and the release.
 */
export class ClickDetector {
  private start: Point | null = null;
  private moved = false;

  press(at: Point): void {
    this.start = at;
    this.moved = false;
  }

  move(at: Point): void {
    if (this.start && Math.hypot(at.x - this.start.x, at.y - this.start.y) > CLICK_MOVE_PX) this.moved = true;
  }

  /** True if the gesture that just ended was a click (it never moved beyond the threshold). */
  release(): boolean {
    const click = this.start !== null && !this.moved;
    this.cancel();
    return click;
  }

  cancel(): void {
    this.start = null;
    this.moved = false;
  }

  get active(): boolean {
    return this.start !== null;
  }
}
