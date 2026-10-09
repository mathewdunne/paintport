// Synthetic "sculpted" plates for the fill tests: a 6 x 6 mm grid whose vertices are jittered
// like sculpt texture, with a soft groove along x = 3.
import { makeRng } from "./prng";
import type { MeshSpec } from "./docFixtures";

export const PLATE_SPACING = 0.05;
export const PLATE_SIZE = 120; // cells per side

export interface PlateOptions {
  /** Raises a small square ring of vertices (Chebyshev distance 4 around this vertex). */
  crater?: [number, number];
  /** The groove fades out around y = 3 over about this width (mm), leaving a gap a fill leaks through. */
  gap?: number;
  /** No groove at all. */
  flat?: boolean;
}

/**
 * Every vertex is jittered up or down (texture that bends single edges by up to ~40 degrees),
 * and a soft groove about 0.4 mm wide runs along x = 3.
 */
export function texturedPlate(options: PlateOptions = {}): MeshSpec {
  const rng = makeRng(20261009, "texturedPlate");
  const vertices: number[] = [], tris: number[] = [];
  for (let j = 0; j <= PLATE_SIZE; j++) {
    for (let i = 0; i <= PLATE_SIZE; i++) {
      const x = i * PLATE_SPACING, y = j * PLATE_SPACING;
      const depth = options.flat ? 0 : options.gap ? 0.12 * (1 - Math.exp(-(((y - 3) / options.gap) ** 2))) : 0.12;
      let z = (rng.next() - 0.5) * 0.024 - depth * Math.exp(-(((x - 3) / 0.15) ** 2));
      if (options.crater && Math.max(Math.abs(i - options.crater[0]), Math.abs(j - options.crater[1])) === 4) z += 0.3;
      vertices.push(x, y, z);
    }
  }
  const v = (i: number, j: number) => j * (PLATE_SIZE + 1) + i;
  for (let j = 0; j < PLATE_SIZE; j++) for (let i = 0; i < PLATE_SIZE; i++) tris.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
  return { vertices, tris };
}

/** Centroid x of each triangle. */
export function centroidX(mesh: MeshSpec): Float64Array {
  const out = new Float64Array(mesh.tris.length / 3);
  for (let t = 0; t < out.length; t++) out[t] = (mesh.vertices[mesh.tris[t * 3] * 3] + mesh.vertices[mesh.tris[t * 3 + 1] * 3] + mesh.vertices[mesh.tris[t * 3 + 2] * 3]) / 3;
  return out;
}

/** Share of the triangles with centroid x in [from, to) that are in `region`. */
export function coverage(region: ArrayLike<number>, xs: Float64Array, from: number, to: number): number {
  const inside = new Set(Array.from(region));
  let total = 0, hit = 0;
  xs.forEach((x, t) => {
    if (x < from || x >= to) return;
    total++;
    if (inside.has(t)) hit++;
  });
  return hit / total;
}

/** A triangle near (x, y) on the plate. */
export const plateTriAt = (x: number, y: number) => (Math.floor(y / PLATE_SPACING) * PLATE_SIZE + Math.floor(x / PLATE_SPACING)) * 2;
