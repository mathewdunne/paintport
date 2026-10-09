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

/** A mask at image resolution as the signed distance to its edge in pixels: > 0 inside, < 0 outside. */
export interface MaskField {
  width: number;
  height: number;
  /** Row-major, row 0 at the top. The image border is not an edge. */
  distance: Float32Array;
  /** The largest inside distance: how far the middle of the mask is from its edge. */
  depth: number;
}

/**
 * Rasterizes a mask at image resolution, keeping only the parts that hold one of the `keep`
 * points (image pixels). SAM's masks often come with small islands away from the click, which
 * would otherwise be painted as stray patches. If no part holds a point, the whole mask is kept.
 */
export function maskField(mask: SamMask, image: { width: number; height: number }, keep: readonly { x: number; y: number }[]): MaskField {
  const { width, height } = image, n = width * height;
  const inside = new Uint8Array(n);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) inside[y * width + x] = maskLogit(mask, image, x + 0.5, y + 0.5) > 0 ? 1 : 0;

  // Label the 4-connected parts and drop those that hold no point.
  const part = new Int32Array(n), stack: number[] = [];
  let parts = 0;
  for (let i = 0; i < n; i++) {
    if (!inside[i] || part[i]) continue;
    part[i] = ++parts;
    stack.push(i);
    while (stack.length > 0) {
      const p = stack.pop()!, x = p % width;
      if (x > 0 && inside[p - 1] && !part[p - 1]) { part[p - 1] = parts; stack.push(p - 1); }
      if (x < width - 1 && inside[p + 1] && !part[p + 1]) { part[p + 1] = parts; stack.push(p + 1); }
      if (p >= width && inside[p - width] && !part[p - width]) { part[p - width] = parts; stack.push(p - width); }
      if (p < n - width && inside[p + width] && !part[p + width]) { part[p + width] = parts; stack.push(p + width); }
    }
  }
  const kept = new Set<number>();
  for (const { x, y } of keep) {
    const px = Math.floor(x), py = Math.floor(y);
    if (px >= 0 && py >= 0 && px < width && py < height && part[py * width + px]) kept.add(part[py * width + px]);
  }
  if (kept.size > 0) for (let i = 0; i < n; i++) if (inside[i] && !kept.has(part[i])) inside[i] = 0;

  const toOutside = distanceTo(inside, 0, width, height), toInside = distanceTo(inside, 1, width, height);
  const distance = new Float32Array(n);
  let depth = 0;
  for (let i = 0; i < n; i++) {
    distance[i] = inside[i] ? toOutside[i] : -toInside[i];
    if (inside[i]) depth = Math.max(depth, toOutside[i]);
  }
  return { width, height, distance, depth };
}

/** The field at image position (x, y); -Infinity outside the image. */
export function fieldAt(field: MaskField, x: number, y: number): number {
  if (!(x >= 0 && y >= 0 && x < field.width && y < field.height)) return -Infinity;
  return field.distance[Math.floor(y) * field.width + Math.floor(x)];
}

/** Per pixel, the chamfer distance (steps of 1 and √2) to the nearest pixel whose value is `target`; Infinity if there is none. */
function distanceTo(values: Uint8Array, target: number, width: number, height: number): Float32Array {
  const d = new Float32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = values[i] === target ? 0 : Infinity;
  const r = Math.SQRT2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - width] + 1);
        if (x > 0) v = Math.min(v, d[i - width - 1] + r);
        if (x < width - 1) v = Math.min(v, d[i - width + 1] + r);
      }
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i];
      if (x < width - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < height - 1) {
        v = Math.min(v, d[i + width] + 1);
        if (x < width - 1) v = Math.min(v, d[i + width + 1] + r);
        if (x > 0) v = Math.min(v, d[i + width - 1] + r);
      }
      d[i] = v;
    }
  }
  return d;
}
