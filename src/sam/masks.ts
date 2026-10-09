// AI Paint (spec Q10): reading SAM's mask output. DOM-free.
import type { SamMask } from "./types";

/** The candidates ranked by score, best first; ties keep the model's order. */
export function rankCandidates(masks: readonly SamMask[]): SamMask[] {
  return masks.map((mask, i) => ({ mask, i })).sort((a, b) => b.mask.score - a.mask.score || a.i - b.i).map((x) => x.mask);
}

/**
 * The decoder's low-res logits cover the padded square input (`grid` x `grid` cells for
 * `inputSize` pixels, image in the top-left corner); keeps the cells over the image.
 */
export function cropToImage(logits: Float32Array, grid: number, inputSize: number, image: { width: number; height: number }, score: number): SamMask {
  const width = Math.min(grid, Math.max(1, Math.round((grid * image.width) / inputSize)));
  const height = Math.min(grid, Math.max(1, Math.round((grid * image.height) / inputSize)));
  const out = new Float32Array(width * height);
  for (let j = 0; j < height; j++) out.set(logits.subarray(j * grid, j * grid + width), j * width);
  return { width, height, logits: out, score };
}

/** The mask's logit at image position (x, y), bilinear between cell centers and clamped at the border. */
export function maskLogit(mask: SamMask, image: { width: number; height: number }, x: number, y: number): number {
  const u = Math.min(mask.width - 1, Math.max(0, (x * mask.width) / image.width - 0.5));
  const v = Math.min(mask.height - 1, Math.max(0, (y * mask.height) / image.height - 0.5));
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const i1 = Math.min(mask.width - 1, i0 + 1), j1 = Math.min(mask.height - 1, j0 + 1);
  const fu = u - i0, fv = v - j0, w = mask.width, l = mask.logits;
  const top = l[j0 * w + i0] * (1 - fu) + l[j0 * w + i1] * fu;
  const bottom = l[j1 * w + i0] * (1 - fu) + l[j1 * w + i1] * fu;
  return top * (1 - fv) + bottom * fv;
}

/** True if the mask covers image position (x, y); false outside the image. */
export function maskCovers(mask: SamMask, image: { width: number; height: number }, x: number, y: number): boolean {
  if (!(x >= 0 && y >= 0 && x < image.width && y < image.height)) return false;
  return maskLogit(mask, image, x, y) > 0;
}
