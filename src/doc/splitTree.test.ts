import { describe, expect, it } from "vitest";
import {
  addLeafStates, childCorners, emitTree, leafIndexAt, MAX_TREE_LEAVES, paintSphereTree, paintTreeLeaves, parseTree, ROOT_BARY,
  stateAtBary, treeDominant, treeLeaves, type Bary, type BaryTri, type TreeNode,
} from "./splitTree";
import type { Vec3 } from "./paintField";

const leaf = (state: number): TreeNode => ({ state });
const split = (splitSides: number, special: number, children: TreeNode[]): TreeNode => ({ splitSides, special, children });
const centroid = ([a, b, c]: BaryTri): Bary => [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3) as Bary;
const A: Bary = [1, 0, 0], B: Bary = [0, 1, 0], C: Bary = [0, 0, 1];
const mid = (p: Bary, q: Bary): Bary => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];

// The tree the spike sliced with PrusaSlicer 2.9.6: its top layer was printed exactly where these
// leaves lie (docs/plans/2026-10-09-subtriangle-spike.md). Child order.
const SLAB = split(3, 0, [
  leaf(2),
  split(1, 1, [leaf(1), leaf(2)]),
  split(2, 2, [leaf(2), leaf(1), split(1, 0, [leaf(2), leaf(1)])]),
  leaf(1),
]);

describe("split geometry (FORMAT.md 2a)", () => {
  it("cuts the side opposite the special corner for one split side", () => {
    expect(childCorners(ROOT_BARY, 1, 0)).toEqual([[A, B, mid(B, C)], [mid(B, C), C, A]]);
    expect(childCorners(ROOT_BARY, 1, 1)).toEqual([[B, C, mid(C, A)], [mid(C, A), A, B]]);
  });

  it("cuts the two sides at the special corner for two split sides", () => {
    const m1 = mid(B, C), m2 = mid(B, A);
    expect(childCorners(ROOT_BARY, 2, 1)).toEqual([[B, m1, m2], [m1, C, m2], [C, A, m2]]);
  });

  it("cuts all sides with the centre last for three", () => {
    const ab = mid(A, B), bc = mid(B, C), ca = mid(C, A);
    expect(childCorners(ROOT_BARY, 3, 0)).toEqual([[A, ab, ca], [ab, B, bc], [bc, C, ca], [ab, bc, ca]]);
  });

  it("reads the string's children in reverse (the PrusaSlicer-verified slab tree)", () => {
    expect(emitTree(SLAB)).toBe("848584841A43");
    expect(parseTree("848584841A43")).toEqual(SLAB);
  });

  it("finds every leaf's state and index at its centroid", () => {
    treeLeaves(SLAB).forEach((l, i) => {
      expect(stateAtBary(SLAB, centroid(l.tri))).toBe(l.state);
      expect(leafIndexAt(SLAB, centroid(l.tri))).toBe(i);
    });
    expect(treeLeaves(SLAB)).toHaveLength(8);
    expect(stateAtBary(leaf(5), [0.2, 0.3, 0.5])).toBe(5);
  });
});

describe("tree edits", () => {
  const corners: [Vec3, Vec3, Vec3] = [[0, 0, 0], [100, 0, 0], [0, 100, 0]];
  const at = (b: Bary): Vec3 => [b[1] * 100, b[2] * 100, 0];
  const dist = (b: Bary, c: Vec3) => Math.hypot(at(b)[0] - c[0], at(b)[1] - c[1]);

  it("paints a sphere's inside, exact up to the limit at its surface", () => {
    const center: Vec3 = [30, 30, 0], radius = 10, limit = 1;
    const t = paintSphereTree(leaf(0), corners, center, radius, 2, limit);
    expect(treeLeaves(t).length).toBeGreaterThan(4);
    let checked = 0;
    for (let i = 0; i <= 60; i++) for (let j = 0; i + j <= 60; j++) {
      const b: Bary = [1 - (i + j) / 60, i / 60, j / 60];
      const d = dist(b, center);
      if (Math.abs(d - radius) <= limit) continue;
      expect(stateAtBary(t, b), `at ${at(b)}`).toBe(d < radius ? 2 : 0);
      checked++;
    }
    expect(checked).toBeGreaterThan(1500);
  });

  it("returns the same node when nothing changes", () => {
    const t = leaf(3);
    expect(paintSphereTree(t, corners, [500, 500, 0], 5, 2, 1)).toBe(t); // misses
    expect(paintSphereTree(t, corners, [30, 30, 0], 10, 3, 1)).toBe(t); // same state
    const s = paintSphereTree(leaf(0), corners, [30, 30, 0], 10, 2, 1);
    expect(paintSphereTree(s, corners, [30, 30, 0], 10, 2, 1)).toBe(s);
  });

  it("paints a triangle inside the sphere whole", () => {
    expect(paintSphereTree(SLAB, corners, [30, 30, 0], 500, 4, 1)).toEqual(leaf(4));
  });

  it("merges back to one leaf when a stroke is erased", () => {
    let t: TreeNode = leaf(0);
    for (let i = 0; i < 20; i++) t = paintSphereTree(t, corners, [10 + i * 2, 10 + i, 0], 3, 2, 0.5);
    expect(treeLeaves(t).length).toBeGreaterThan(50);
    for (let i = 0; i < 20; i++) t = paintSphereTree(t, corners, [10 + i * 2, 10 + i, 0], 3.6, 0, 0.5);
    expect(t).toEqual(leaf(0));
  });

  it("stops splitting at the leaf budget, below the sidecar's tree limit", () => {
    let t: TreeNode = leaf(0);
    for (let i = 0; i < 40; i++) t = paintSphereTree(t, corners, [5 + i * 2, 20, 0], 4, 2, 0.001);
    expect(treeLeaves(t).length).toBeLessThanOrEqual(MAX_TREE_LEAVES);
    expect(emitTree(t).length).toBeLessThan(65536);
  });

  it("paints chosen leaves and merges equal siblings", () => {
    const leaves = treeLeaves(SLAB);
    const ones = new Set(leaves.flatMap((l, i) => (l.state === 1 ? [i] : [])));
    expect(paintTreeLeaves(SLAB, ones, 2)).toEqual(leaf(2));
    const t = paintTreeLeaves(SLAB, new Set([0]), 7);
    expect(treeLeaves(t).map((l) => l.state)).toEqual([7, ...leaves.slice(1).map((l) => l.state)]);
    expect(paintTreeLeaves(SLAB, new Set(), 7)).toBe(SLAB);
  });

  it("reports the dominant state and leaf states", () => {
    expect(treeDominant(split(3, 0, [leaf(1), leaf(1), leaf(2), leaf(2)]))).toBe(2);
    expect(treeDominant(SLAB)).toBe(2); // 4 x state 2, 4 x state 1
    const into = new Set<number>();
    addLeafStates(split(1, 0, [leaf(0), leaf(6)]), into);
    expect([...into]).toEqual([6]);
  });
});
