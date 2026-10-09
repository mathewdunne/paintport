import type { State, Vec3 } from "../doc/paintField";

export type ToolId = "brush" | "shellFill" | "smartFill" | "eraser" | "eyedropper";

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
  /** Smart fill measures the bend over this size (world millimetres) so finer surface texture is ignored; 0 compares neighboring faces. */
  smartScale: number;
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
  /** Calls the listener when the camera moves, the viewport resizes or the scene changes. Returns the unsubscribe function. */
  onViewChange(listener: () => void): () => void;
  /** CSS cursor over the canvas. */
  setCursor(cursor: string): void;
}
