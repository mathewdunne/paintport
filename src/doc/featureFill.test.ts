import { describe, expect, it } from "vitest";
import { cubeMesh, makeModel, type MeshSpec } from "../../test/support/docFixtures";
import { makeRng } from "../../test/support/prng";
import { autoFeatureScale, featureBend } from "./featureField";
import { createProject, type Project } from "./project";

const SPACING = 0.05;
const SIZE = 120; // cells per side: a 6 x 6 mm plate

/**
 * A plate like a sculpted surface: every vertex is jittered up or down (texture that bends
 * single edges by up to ~40 degrees), and a soft groove about 0.4 mm wide runs along x = 3.
 * `crater` raises a small square ring of vertices (Chebyshev distance 4 around a vertex).
 */
function texturedPlate(crater?: [number, number]): MeshSpec {
  const rng = makeRng(20261009, "texturedPlate");
  const vertices: number[] = [], tris: number[] = [];
  for (let j = 0; j <= SIZE; j++) {
    for (let i = 0; i <= SIZE; i++) {
      const x = i * SPACING, y = j * SPACING;
      let z = (rng.next() - 0.5) * 0.024 - 0.12 * Math.exp(-(((x - 3) / 0.15) ** 2));
      if (crater && Math.max(Math.abs(i - crater[0]), Math.abs(j - crater[1])) === 4) z += 0.3;
      vertices.push(x, y, z);
    }
  }
  const v = (i: number, j: number) => j * (SIZE + 1) + i;
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) tris.push(v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i, j + 1));
  return { vertices, tris };
}

function projectOf(mesh: MeshSpec): Project {
  const p = createProject(makeModel(mesh));
  p.addColor("#336699");
  return p;
}

/** Centroid x of each triangle. */
function centroidX(mesh: MeshSpec): Float64Array {
  const out = new Float64Array(mesh.tris.length / 3);
  for (let t = 0; t < out.length; t++) out[t] = (mesh.vertices[mesh.tris[t * 3] * 3] + mesh.vertices[mesh.tris[t * 3 + 1] * 3] + mesh.vertices[mesh.tris[t * 3 + 2] * 3]) / 3;
  return out;
}

/** Share of the triangles with centroid x in [from, to) that are in `region`. */
function coverage(region: Uint32Array, xs: Float64Array, from: number, to: number): number {
  const inside = new Set(region);
  let total = 0, hit = 0;
  xs.forEach((x, t) => {
    if (x < from || x >= to) return;
    total++;
    if (inside.has(t)) hit++;
  });
  return hit / total;
}

/** A triangle near (x, y) on the plate. */
const triAt = (x: number, y: number) => (Math.floor(y / SPACING) * SIZE + Math.floor(x / SPACING)) * 2;

describe("smart fill with a feature size", () => {
  const mesh = texturedPlate();
  const xs = centroidX(mesh);

  it("crosses surface texture that stops the edge-by-edge fill, and stops at the groove", () => {
    const p = projectOf(mesh);
    const seed = triAt(1, 3);
    const plain = p.smartFillRegion(0, seed, 20);
    expect(coverage(plain, xs, 0, 2.5)).toBeLessThan(0.5); // the texture breaks it up

    const region = p.smartFillRegion(0, seed, 20, 0.3);
    expect(coverage(region, xs, 0, 2.6)).toBe(1);
    expect(coverage(region, xs, 3.4, 6)).toBe(0);
  });

  it("stops in the middle of the groove, where a fill from the other side stops too", () => {
    const p = projectOf(mesh);
    const left = p.smartFillRegion(0, triAt(1, 3), 20, 0.3);
    p.paintTriangles(0, left, 2);
    const right = p.smartFillRegion(0, triAt(5, 3), 20, 0.3);
    expect(coverage(left, xs, 2.75, 2.95)).toBeGreaterThan(0.9);
    expect(coverage(right, xs, 3.05, 3.25)).toBeGreaterThan(0.9);
    // Together they leave at most a thin seam unpainted.
    const both = new Uint32Array([...left, ...right]);
    expect(coverage(both, xs, 0, 6)).toBeGreaterThan(0.98);
  });

  it("fills a hole smaller than the feature size that the region surrounds", () => {
    const p = projectOf(texturedPlate([20, 60]));
    const region = new Set(p.smartFillRegion(0, triAt(0.5, 0.5), 20, 0.3));
    // The crater floor: the 6 x 6 cells inside the ring.
    for (let j = 57; j < 63; j++) for (let i = 17; i < 23; i++) for (const t of [0, 1]) expect(region.has((j * SIZE + i) * 2 + t)).toBe(true);
  });

  it("stops at existing paint", () => {
    const p = projectOf(mesh);
    const wall = Array.from({ length: mesh.tris.length / 3 }, (_, t) => t).filter((t) => xs[t] >= 1.5 && xs[t] < 1.6);
    p.paintTriangles(0, wall, 2);
    const region = p.smartFillRegion(0, triAt(0.5, 3), 20, 0.3);
    expect(coverage(region, xs, 0, 1.45)).toBe(1);
    expect(coverage(region, xs, 1.5, 6)).toBe(0);
  });

  it("is the edge-by-edge fill on a mesh whose triangles are as big as the feature size", () => {
    const p = projectOf(cubeMesh());
    for (const angle of [30, 100]) expect(Array.from(p.smartFillRegion(0, 0, angle, 0.3))).toEqual(Array.from(p.smartFillRegion(0, 0, angle)));
    expect(featureBend(p.topology(0), 0.3)).toBeNull();
  });

  it("picks a feature size a few triangles wide on a textured mesh, and none on flat facets", () => {
    const textured = projectOf(mesh).topology(0);
    const scale = autoFeatureScale(textured);
    expect(scale).toBeGreaterThan(3 * SPACING);
    expect(scale).toBeLessThan(8 * SPACING);
    expect(autoFeatureScale(textured)).toBe(scale);
    expect(autoFeatureScale(projectOf(cubeMesh()).topology(0))).toBe(0); // every face split into coplanar pairs
  });

  it("computes the bend once per feature size", () => {
    const p = projectOf(mesh);
    const topology = p.topology(0);
    const bend = featureBend(topology, 0.3);
    expect(featureBend(topology, 0.3)).toBe(bend);
    expect(featureBend(topology, 0.2)).not.toBe(bend);
  });
});
