// AI Paint (spec Q10): the shapes the Segment Anything model works with. DOM-free.

/** An RGBA image, row 0 at the top. */
export interface SamImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A prompt point in image pixels (x to the right, y down): on the part (positive) or not. */
export interface SamPoint {
  x: number;
  y: number;
  positive: boolean;
}

/**
 * One candidate mask over the whole image: logits (> 0 = inside) on a grid coarser than the
 * image. Grid cell (i, j) covers image columns [i, i + 1) * imageWidth / width and rows
 * [j, j + 1) * imageHeight / height.
 */
export interface SamMask {
  width: number;
  height: number;
  /** Row-major, row 0 at the top. */
  logits: Float32Array;
  /** The model's estimate of this mask's quality (predicted IoU). */
  score: number;
}

/** An encoded image. Owned by the segmenter that made it. */
export interface SamEmbedding {
  readonly width: number;
  readonly height: number;
  dispose(): void;
}

/** A Segment Anything model: encode an image once (slow), then decode masks for prompts (fast). */
export interface Segmenter {
  /** The encoder's input side: images must have exactly this long side. */
  readonly inputSize: number;
  encode(image: SamImage): Promise<SamEmbedding>;
  /** Candidate masks for the points, in the model's order. */
  decode(embedding: SamEmbedding, points: readonly SamPoint[]): Promise<SamMask[]>;
  dispose(): void;
}

/** The camera a SAM image was rendered with. Matrices are column-major (three.js `elements`). */
export interface ImageCamera {
  /** World to camera. */
  view: ArrayLike<number>;
  /** Camera to clip space (perspective). */
  proj: ArrayLike<number>;
  eye: readonly [number, number, number];
  /** Image size in pixels. */
  width: number;
  height: number;
}

/** Whether a surface point (with its face normal, any length) can be seen. `VisibilityTest` implements it. */
export interface Visibility {
  isVisible(x: number, y: number, z: number, nx: number, ny: number, nz: number): boolean;
}
