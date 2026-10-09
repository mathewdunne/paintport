import { resolveTriangleState } from "../doc/display";
import type { Project } from "../doc/project";
import { objectSpaceSphere } from "../doc/transform";
import { interpolateDabs, type Point } from "./dabs";
import { ClickDetector } from "./gesture";
import type { PaintSettings, PaintView, PickHit, ToolId } from "./types";

export interface PaintCallbacks {
  /** The eyedropper picked a design color: make it the active one. */
  onPickState(state: number): void;
  /** A color chip for the eyedropper under the cursor (client coordinates), or null to hide it. */
  onSwatch(swatch: { x: number; y: number; color: string } | null): void;
}

/** Scheduling and window hooks, replaceable in tests. */
export interface ControllerEnv {
  raf(callback: () => void): number;
  cancelRaf(id: number): void;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
  now(): number;
  /** Receives blur and Shift/Alt key changes. */
  win: EventTarget;
}

const browserEnv = (): ControllerEnv => ({
  raf: (cb) => requestAnimationFrame(cb),
  cancelRaf: (id) => cancelAnimationFrame(id),
  setTimer: (cb, ms) => window.setTimeout(cb, ms),
  clearTimer: (id) => window.clearTimeout(id),
  now: () => performance.now(),
  win: window,
});

/** Dabs are spaced this fraction of the brush radius apart (spec: about a third). */
const SPACING_OF_RADIUS = 1 / 3;
/** A fill preview that took longer than this is recomputed only after the pointer rests. */
const SLOW_FILL_MS = 8;
const FILL_DEBOUNCE_MS = 90;
/** On release, a last dab is placed if the pointer moved this far (of the spacing) past the last one. */
const FINAL_DAB_SHARE = 0.5;
/** Dabs per frame are limited so that they take about this long; a fast drag then gets wider spacing, not a stall. */
const DAB_BUDGET_MS = 10;
const MAX_DABS_PER_FRAME = 64;

type Gesture = "none" | "stroke" | "orbit";

interface Stroke {
  pointerId: number;
  last: Point | null;
  carry: number;
  spacingPx: number;
}

/**
 * Turns pointer input over the 3D view into edits of the project: brush and eraser
 * strokes, fills, the eyedropper, plus the hover feedback (brush ring, fill preview,
 * color chip). The 3D view answers "what is under the cursor" and "which triangles are
 * near the brush" (`PaintView`); the project does the editing, undo and notifications.
 *
 * Work happens at most once per animation frame. A stroke is one undo step: opened on
 * pointer down, closed on release, and also on pointer cancel, a lost pointer capture,
 * window blur, a tool change and dispose.
 *
 * Left button: the active tool. Alt+left is the eyedropper when it is a click and an
 * orbit (handled by the viewer) when it is a drag. Right and middle buttons orbit and pan
 * (also the viewer's); here they only hide the hover feedback. Shift while brushing erases.
 */
export class PaintController {
  private settings: PaintSettings;
  private pointer: { x: number; y: number; inside: boolean; shift: boolean; alt: boolean } | null = null;
  private gesture: Gesture = "none";
  private stroke: Stroke | null = null;
  private readonly altClick = new ClickDetector();
  private frame = 0;
  private strokeDirty = false;
  private hoverDirty = false;
  /** Counts document changes that alter what a fill would cover. */
  private epoch = 0;
  private fillKey = "";
  private fillObject = -1;
  private lastFillMs = 0;
  private fillReady = true;
  private fillTimer = 0;
  private warmTimer = 0;
  /** Smoothed cost of one dab, to size the per-frame dab budget. */
  private dabMs = 0.1;
  private disposed = false;
  /** False in the Print view: the controller ignores the pointer and shows nothing. */
  private enabled = true;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly project: Project,
    private readonly view: PaintView,
    private readonly callbacks: PaintCallbacks,
    settings: PaintSettings,
    private readonly env: ControllerEnv = browserEnv(),
  ) {
    this.settings = settings;
    this.warmFillData();
    const el = this.view.element;
    const listen = (target: EventTarget, type: string, handler: (e: never) => void, capture = false) => {
      target.addEventListener(type, handler as EventListener, capture);
      this.unsubscribe.push(() => target.removeEventListener(type, handler as EventListener, capture));
    };
    // Capture phase on the element itself runs before the viewer's orbit controls, which listen on the same element.
    listen(el, "pointerdown", this.onStrokePointerDown, true);
    listen(el, "pointerdown", this.onPointerDown);
    listen(el, "pointermove", this.onPointerMove);
    listen(el, "pointerup", this.onPointerUp);
    listen(el, "pointercancel", this.onPointerCancel);
    listen(el, "lostpointercapture", this.onLostCapture);
    listen(el, "pointerleave", this.onPointerLeave);
    listen(env.win, "blur", this.onBlur);
    listen(env.win, "keydown", this.onKey);
    listen(env.win, "keyup", this.onKey);
    this.unsubscribe.push(
      this.view.onViewChange(() => {
        if (this.gesture === "stroke") this.strokeDirty = true;
        else if (this.gesture === "none") this.hoverDirty = true;
        this.schedule();
      }),
      this.project.subscribe((e) => {
        if (e.kind === "history") return;
        this.epoch++;
        this.hoverDirty = true;
        this.schedule();
      }),
    );
  }

  setSettings(next: PaintSettings): void {
    const previous = this.settings;
    this.settings = next;
    if (previous.tool !== next.tool) {
      this.finishStroke();
      this.clearHover();
      this.warmFillData();
    }
    this.hoverDirty = true;
    this.schedule();
  }

  /**
   * Turns the tools on or off (off in the Print view, which is view-only). Off: an open stroke
   * ends, all hover feedback goes away and pointer input is left to the viewer (orbit and pan),
   * so a left drag does not paint and a click does not pick a color.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled || this.disposed) return;
    this.enabled = enabled;
    this.altClick.cancel();
    if (!enabled) {
      this.finishStroke();
      this.gesture = "none";
      this.clearHover();
      this.view.setCursor("");
      return;
    }
    this.hoverDirty = true;
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finishStroke();
    this.clearHover();
    this.view.setCursor("");
    this.altClick.cancel();
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.frame) this.env.cancelRaf(this.frame);
    this.env.clearTimer(this.fillTimer);
    this.env.clearTimer(this.warmTimer);
  }

  // --- pointer events --------------------------------------------------------------

  /** While a stroke is open only the left button matters: another button neither orbits nor ends the stroke. */
  private readonly onStrokePointerDown = (e: PointerEvent): void => {
    if (this.stroke && e.pointerType !== "touch") e.stopImmediatePropagation();
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "touch" || this.disposed || !this.enabled) return;
    this.track(e);
    if (this.stroke) return;
    if (e.button === 0 && !e.altKey) {
      switch (this.settings.tool) {
        case "brush":
        case "eraser":
          this.beginStroke(e);
          break;
        case "shellFill":
        case "smartFill":
          this.fillAt(e.clientX, e.clientY);
          break;
        case "eyedropper":
          this.pickColorAt(e.clientX, e.clientY);
          break;
      }
      return;
    }
    // Alt+left, middle and right drags are the viewer's (orbit, pan). Alt+left that never moves is the eyedropper.
    this.gesture = "orbit";
    this.clearHover();
    this.view.setCursor("grabbing");
    if (e.button === 0) this.altClick.press({ x: e.clientX, y: e.clientY });
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch" || this.disposed || !this.enabled) return;
    this.track(e);
    if (this.stroke) {
      if (e.pointerId !== this.stroke.pointerId) return;
      if ((e.buttons & 1) === 0) { // the button was released while another one was held: no pointerup yet
        this.release();
        return;
      }
      this.strokeDirty = true;
    } else if (this.gesture === "orbit") {
      this.altClick.move({ x: e.clientX, y: e.clientY });
      return;
    } else if (e.buttons === 0) {
      this.hoverDirty = true;
    } else {
      return;
    }
    this.schedule();
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch" || this.disposed || !this.enabled) return;
    this.track(e);
    if (this.stroke) {
      // pointerup reports the last button released: a right release must not end a stroke that the left button owns.
      if (e.pointerId === this.stroke.pointerId && e.button === 0) this.release();
    } else if (this.gesture === "orbit") {
      const wasClick = this.altClick.release();
      this.gesture = "none";
      this.view.setCursor("");
      if (wasClick) this.pickColorAt(e.clientX, e.clientY);
      this.hoverDirty = true;
      this.schedule();
    }
  };

  private readonly onPointerCancel = (): void => {
    this.altClick.cancel();
    this.endGesture();
  };

  private readonly onLostCapture = (): void => {
    if (this.gesture === "stroke") this.endGesture();
  };

  private readonly onPointerLeave = (): void => {
    if (this.pointer) this.pointer.inside = false;
    if (this.gesture === "none") this.clearHover();
  };

  private readonly onBlur = (): void => {
    this.altClick.cancel();
    this.endGesture();
  };

  /** Shift and Alt change what the cursor means (erase, eyedropper): refresh the hover. */
  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.pointer) {
      this.pointer.shift = e.shiftKey;
      this.pointer.alt = e.altKey;
    }
    if (e.key === "Shift" || e.key === "Alt") {
      this.hoverDirty = true;
      this.schedule();
    }
  };

  private track(e: PointerEvent): void {
    this.pointer = { x: e.clientX, y: e.clientY, inside: true, shift: e.shiftKey, alt: e.altKey };
  }

  // --- strokes -----------------------------------------------------------------------

  private beginStroke(e: PointerEvent): void {
    try {
      this.view.element.setPointerCapture(e.pointerId);
    } catch { /* the pointer may already be gone */ }
    this.gesture = "stroke";
    this.stroke = { pointerId: e.pointerId, last: null, carry: 0, spacingPx: 4 };
    this.project.beginStroke();
    this.clearHover();
    this.processStroke();
  }

  /** The pointer was released normally: place the last dab, then close the stroke. */
  private release(): void {
    if (this.frame) {
      this.env.cancelRaf(this.frame);
      this.frame = 0;
    }
    try {
      this.processStroke(true);
    } finally {
      this.endGesture(); // the stroke must close even if the last dab fails (e.g. a lost WebGL context)
    }
  }

  /** Closes whatever gesture is in progress, however it was interrupted. */
  private endGesture(): void {
    this.finishStroke();
    if (this.gesture !== "none") {
      this.gesture = "none";
      this.view.setCursor("");
    }
    this.hoverDirty = true;
    this.schedule();
  }

  private finishStroke(): void {
    const stroke = this.stroke;
    this.stroke = null;
    this.strokeDirty = false;
    if (stroke) {
      try {
        this.view.element.releasePointerCapture(stroke.pointerId);
      } catch { /* already released */ }
      if (this.gesture === "stroke") this.gesture = "none";
    }
    this.project.endAllStrokes();
  }

  /** Dabs from where the last frame stopped to the pointer, evenly spaced, and moves the ring. */
  private processStroke(final = false): void {
    const stroke = this.stroke, p = this.pointer;
    if (!stroke || !p) return;
    const erase = this.isErasing(p.shift);
    const hit = this.view.pick(p.x, p.y);
    if (hit) {
      const radiusPx = this.settings.radius / this.view.pixelSizeAt(hit.distance);
      stroke.spacingPx = Math.max(1, radiusPx * SPACING_OF_RADIUS);
      if (!final) this.view.showBrushCursor(hit, this.settings.radius, erase);
      this.view.setCursor("none");
    } else {
      this.view.hideBrushCursor();
      this.view.setCursor("default");
    }
    const here: Point = { x: p.x, y: p.y };
    if (!stroke.last) {
      if (hit) this.dab(hit, erase);
    } else {
      const maxDabs = Math.max(4, Math.min(MAX_DABS_PER_FRAME, Math.floor(DAB_BUDGET_MS / this.dabMs)));
      const path = interpolateDabs(stroke.last, here, stroke.spacingPx, stroke.carry, maxDabs);
      for (const point of path.points) {
        const h = this.view.pick(point.x, point.y);
        if (h) this.dab(h, erase);
      }
      stroke.carry = path.carry;
      if (final && hit && stroke.carry > stroke.spacingPx * FINAL_DAB_SHARE) this.dab(hit, erase);
    }
    stroke.last = here;
  }

  private dab(hit: PickHit, erase: boolean): void {
    const state = erase ? 0 : this.paintState();
    if (state === null) return;
    const { radius, paintThrough } = this.settings;
    const started = this.env.now();
    for (const target of this.view.brushCandidates(hit, radius, !paintThrough)) {
      // The view tested the candidates against the world-space sphere, which is what the ring shows. The object-space
      // sphere is only an approximation under a non-uniform scale, so the field must not test them again.
      const sphere = objectSpaceSphere(this.project.objects[target.object].transform, hit.point, radius);
      this.project.paintSphere(target.object, sphere.center, sphere.radius, state, { candidates: target.tris, candidatesExact: true });
    }
    this.dabMs = this.dabMs * 0.7 + Math.max(0.05, this.env.now() - started) * 0.3;
  }

  // --- fills and the eyedropper ---------------------------------------------------------

  private fillAt(x: number, y: number): void {
    const hit = this.view.pick(x, y);
    const state = this.paintState();
    if (!hit || state === null) return;
    this.project.paintTriangles(hit.object, this.fillRegion(hit), state);
  }

  private fillRegion(hit: PickHit): Uint32Array {
    return this.settings.tool === "shellFill"
      ? this.project.shellFillRegion(hit.object, hit.tri)
      : this.project.smartFillRegion(hit.object, hit.tri, this.settings.smartAngle);
  }

  private pickColorAt(x: number, y: number): void {
    const hit = this.view.pick(x, y);
    if (!hit) return;
    const state = resolveTriangleState(this.project, hit.object, hit.tri);
    if (state > 0) this.callbacks.onPickState(state);
  }

  // --- hover feedback --------------------------------------------------------------------

  private schedule(): void {
    if (this.frame || this.disposed || !this.enabled) return;
    this.frame = this.env.raf(() => {
      this.frame = 0;
      if (this.disposed || !this.enabled) return;
      try {
        if (this.stroke) {
          if (this.strokeDirty) {
            this.strokeDirty = false;
            this.processStroke();
          }
        } else if (this.hoverDirty && this.gesture === "none") {
          this.hoverDirty = false;
          this.updateHover();
        }
      } catch (error) {
        console.error("Paint tool failed", error); // one failed frame must not stop the next ones
      }
    });
  }

  private updateHover(): void {
    const p = this.pointer;
    if (!p || !p.inside) {
      this.clearHover();
      return;
    }
    const hit = this.view.pick(p.x, p.y);
    if (!hit) {
      this.clearHover();
      this.view.setCursor("default");
      return;
    }
    const tool = p.alt ? "eyedropper" : this.settings.tool;
    this.view.setCursor(tool === "brush" || tool === "eraser" ? "none" : "crosshair");
    if (tool === "brush" || tool === "eraser") {
      this.clearRegion();
      this.callbacks.onSwatch(null);
      this.view.showBrushCursor(hit, this.settings.radius, this.isErasing(p.shift));
    } else if (tool === "eyedropper") {
      this.clearRegion();
      this.view.hideBrushCursor();
      const state = resolveTriangleState(this.project, hit.object, hit.tri);
      this.callbacks.onSwatch(state > 0 ? { x: p.x, y: p.y, color: this.project.palette[state].color } : null);
    } else {
      this.view.hideBrushCursor();
      this.callbacks.onSwatch(null);
      this.previewFill(hit);
    }
  }

  /**
   * Highlights the region a fill would paint. Moving within the highlighted region costs
   * nothing (a flood from any of its triangles gives the same region); a new region is
   * computed when the seed leaves it, the angle changes or the document changes. If the
   * last computation was slow (a huge region), recomputation waits until the pointer rests.
   */
  private previewFill(hit: PickHit): void {
    const key = `${this.settings.tool}|${hit.object}|${this.settings.tool === "smartFill" ? this.settings.smartAngle : ""}|${this.epoch}`;
    if (key === this.fillKey && this.view.isRegionHighlighted(hit.object, hit.tri)) return;
    if (!this.fillReady && this.lastFillMs >= SLOW_FILL_MS) {
      this.env.clearTimer(this.fillTimer);
      this.fillTimer = this.env.setTimer(() => {
        this.fillReady = true;
        this.hoverDirty = true;
        this.schedule();
      }, FILL_DEBOUNCE_MS);
      return;
    }
    const started = this.env.now();
    const region = this.fillRegion(hit);
    this.view.setRegionHighlight(hit.object, region);
    this.lastFillMs = this.env.now() - started;
    this.fillKey = key;
    this.fillObject = hit.object;
    this.fillReady = this.lastFillMs < SLOW_FILL_MS;
  }

  /**
   * Building the mesh adjacency is slow on big meshes (about a quarter of a second at 1.3M
   * triangles) and a fill needs it: do it when a fill tool is chosen, not at the first hover.
   */
  private warmFillData(): void {
    if (this.settings.tool !== "shellFill" && this.settings.tool !== "smartFill") return;
    this.env.clearTimer(this.warmTimer);
    this.warmTimer = this.env.setTimer(() => {
      if (!this.disposed) this.project.objects.forEach((_, i) => this.project.topology(i));
    }, 0);
  }

  private clearRegion(): void {
    this.env.clearTimer(this.fillTimer);
    this.fillReady = true;
    if (this.fillKey !== "") this.view.setRegionHighlight(this.fillObject, null);
    this.fillKey = "";
  }

  private clearHover(): void {
    this.view.hideBrushCursor();
    this.clearRegion();
    this.callbacks.onSwatch(null);
  }

  // --- helpers -----------------------------------------------------------------------------

  private isErasing(shift: boolean): boolean {
    const tool: ToolId = this.settings.tool;
    return tool === "eraser" || (tool === "brush" && shift);
  }

  /** The state to paint with, or null if the active color is not in the palette. */
  private paintState(): number | null {
    const s = this.settings.activeState;
    return Number.isInteger(s) && s >= 1 && s < this.project.palette.length ? s : null;
  }
}
