// AI Paint (spec Q10): turning a render into the SAM encoder's input. DOM-free.
import type { SamImage } from "./types";

export interface Normalization {
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
}

/** The ImageNet mean and deviation (of 0..1 values) SAM's encoders were trained with. */
export const IMAGENET: Normalization = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };

/** An image size with the viewport's aspect and a long side of exactly `size` pixels. */
export function fitLongSide(width: number, height: number, size: number): { width: number; height: number } {
  if (width >= height) return { width: size, height: Math.max(1, Math.round((height * size) / width)) };
  return { width: Math.max(1, Math.round((width * size) / height)), height: size };
}

/** A `readPixels` result (row 0 at the bottom) as a `SamImage` (row 0 at the top). */
export function flipRows(data: Uint8Array, width: number, height: number): SamImage {
  const row = width * 4;
  const out = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) out.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return { width, height, data: out };
}

/**
 * The encoder input: 1 x 3 x size x size floats, one channel plane after the other. The image
 * sits in the top-left corner; the rest is 0, which is what the reference processor pads with
 * after normalizing. The image's long side must be `size` (see `fitLongSide`), so no resampling
 * is needed: the viewer renders at that size directly.
 */
export function toPixelValues(image: SamImage, size: number, norm: Normalization = IMAGENET): Float32Array {
  if (Math.max(image.width, image.height) !== size || Math.min(image.width, image.height) < 1) {
    throw new Error(`SAM image must have a long side of ${size} px, got ${image.width} x ${image.height}`);
  }
  const plane = size * size;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4, o = y * size + x;
      for (let c = 0; c < 3; c++) out[c * plane + o] = (image.data[i + c] / 255 - norm.mean[c]) / norm.std[c];
    }
  }
  return out;
}
