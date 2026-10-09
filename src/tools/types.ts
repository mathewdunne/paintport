import type { ImageCamera, SamImage, Visibility } from "../sam/types";
import type { State, Vec3 } from "../doc/paintField";

export type ToolId = "brush" | "shellFill" | "smartFill" | "guidedFill" | "aiPaint" | "eraser" | "eyedropper";

/** Everything the paint tools need from the UI. */
export interface PaintSettings {
  tool: ToolId;
  /** Design state the brush and fills paint with (index into the palette). */
  activeState: State;
  /** Brush radius in world millimetres. */
  radius: number;
  /** Paint everything inside the brush sphere, not only surface visible from the camera. */
  paintThrough: boolean;
  /** Smart fill stops at edges sharper than this many degrees. */
  smartAngle: number;
  /**
   * Smart fill measures the bend over this size (world millimetres) so finer surface texture is
   * ignored; 0 compares neighboring faces; null picks a size per mesh (`Project.autoFeatureScale`).
   */
  smartScale: number | null;
}

/** A surface point under the cursor. `object` and `tri` are document indices. */
export interface PickHit {
  object: number;
  tri: number;
  /** World space. */
  point: Vec3;
  /** Unit face normal in world space, facing the camera. */
  normal: Vec3;
  /** Distance from the camera. */
  distance: number;
}

/** A guided fill mark to draw: inside (paint here) or outside (keep out). World space. */
/** What AI Paint needs from the current camera pose (spec Q10). */
export interface SamCapture {
  /** Equal for two captures exactly when they would render the same image: camera, viewport, scene, colors. */
  key: string;
  camera: ImageCamera;
  /** Whether a surface point is visible in this pose (the visible-only brush's depth test). */
  visibility: Visibility;
  /** Renders the model, without overlays or highlight, at the capture's image size. */
  render(): SamImage;
}

export interface ViewMark {
  point: Vec3;
  inside: boolean;
}

/** The triangles of one object a brush dab may paint. */
export interface BrushTarget {
  object: number;
  tris: Uint32Array;
}

/**
 * What the paint controller needs from the 3D view. `ModelViewer` implements it, a test
 * double stands in for it in Node.
 */
export interface PaintView {
  /** The element that receives the pointer events. */
  readonly element: HTMLElement;
  /** The front surface under a screen position (client coordinates), or null. */
  pick(clientX: number, clientY: number): PickHit | null;
  /** Triangles near the brush sphere at `hit`: visible ones only, or all of them. */
  brushCandidates(hit: PickHit, radius: number, visibleOnly: boolean): BrushTarget[];
  /** World size of one screen pixel at a distance from the camera. */
  pixelSizeAt(distance: number): number;
  showBrushCursor(hit: PickHit, radius: number, erase: boolean): void;
  hideBrushCursor(): void;
  /** Highlights a region of triangles (a fill preview); null clears it. */
  setRegionHighlight(object: number, tris: Uint32Array | null): void;
  isRegionHighlighted(object: number, tri: number): boolean;
  /** Draws the guided fill marks; an empty list clears them. */
  setMarks(marks: readonly ViewMark[]): void;
  /** The current pose for SAM, with an image whose long side is `size`; null without a model. */
  captureSam(size: number): SamCapture | null;
  /** Calls the listener when the camera moves, the viewport resizes or the scene changes. Returns the unsubscribe function. */
  onViewChange(listener: () => void): () => void;
  /** CSS cursor over the canvas. */
  setCursor(cursor: string): void;
}
