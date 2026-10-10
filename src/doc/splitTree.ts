// Sub-triangle paint (spec Q12): TriangleSelector trees in CHILD order, the order PrusaSlicer
// numbers a split's children in. The paint string holds them in reverse (docs/FORMAT.md 2a), so
// `parseTree` and `emitTree` reverse every split's children; everything else here works in child
// order. Points inside a triangle are barycentric coordinates relative to its three corners in
// the order the mesh lists them.
import { emitPaintTree, parsePaintTree, type PaintNode } from "../core";
import type { Vec3 } from "./paintField";
import { INTERNAL_DIALECT } from "./paintTree";
import { sqDistPointCorners } from "./triangleMath";

export type Bary = [number, number, number];
export type BaryTri = [Bary, Bary, Bary];
export interface TreeLeaf { state: number }
export interface TreeSplit { splitSides: number; special: number; children: TreeNode[] }
export type TreeNode = TreeLeaf | TreeSplit;

export const isLeaf = (n: TreeNode): n is TreeLeaf => !(n as TreeSplit).children;

/**
 * The brush stops cutting a tree that has this many leaves: its string then stays well below the
 * design sidecar's 65,536-character limit per tree (a leaf costs 1–2 characters, a split 1).
 */
export const MAX_TREE_LEAVES = 16384;

export const ROOT_BARY: BaryTri = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

const reverseChildren = (n: PaintNode | TreeNode): TreeNode =>
  isLeaf(n as TreeNode) ? { state: (n as TreeLeaf).state } : { ...(n as TreeSplit), children: [...(n as TreeSplit).children].reverse().map(reverseChildren) };

/** A stored tree (internal dialect) in child order. Throws a CoreError for an invalid string. */
export function parseTree(str: string): TreeNode {
  return reverseChildren(parsePaintTree(str, INTERNAL_DIALECT));
}

/** The paint string (internal dialect) of a tree in child order. */
export function emitTree(node: TreeNode): string {
  return emitPaintTree(reverseChildren(node), INTERNAL_DIALECT);
}

const mid = (a: Bary, b: Bary): Bary => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/**
 * The corners of each child, in child order, of a triangle with corners `v` split on `sides`
 * sides with special side `special` (FORMAT.md 2a, verified against PrusaSlicer 2.9.6).
 */
export function childCorners(v: BaryTri, sides: number, special: number): BaryTri[] {
  const r0 = v[special % 3], r1 = v[(special + 1) % 3], r2 = v[(special + 2) % 3];
  if (sides === 1) {
    const m = mid(r1, r2);
    return [[r0, r1, m], [m, r2, r0]];
  }
  if (sides === 2) {
    const m1 = mid(r0, r1), m2 = mid(r0, r2);
    return [[r0, m1, m2], [m1, r1, m2], [r1, r2, m2]];
  }
  const m01 = mid(r0, r1), m12 = mid(r1, r2), m20 = mid(r2, r0);
  return [[r0, m01, m20], [m01, r1, m12], [m12, r2, m20], [m01, m12, m20]];
}

/** Every leaf with its corners and state; the array index is the leaf index (depth first, child order). */
export function treeLeaves(root: TreeNode): { tri: BaryTri; state: number }[] {
  const out: { tri: BaryTri; state: number }[] = [];
  (function walk(n: TreeNode, v: BaryTri) {
    if (isLeaf(n)) { out.push({ tri: v, state: n.state }); return; }
    const corners = childCorners(v, n.splitSides, n.special);
    n.children.forEach((c, i) => walk(c, corners[i]));
  })(root, ROOT_BARY);
  return out;
}

export function countLeaves(n: TreeNode): number {
  return isLeaf(n) ? 1 : n.children.reduce((s, c) => s + countLeaves(c), 0);
}

/** The smallest barycentric coordinate of p in triangle t (both relative to the root; coordinates 1 and 2 as a plane). */
function minLocal(p: Bary, [a, b, c]: BaryTri): number {
  const v0x = b[1] - a[1], v0y = b[2] - a[2], v1x = c[1] - a[1], v1y = c[2] - a[2];
  const px = p[1] - a[1], py = p[2] - a[2];
  const den = v0x * v1y - v1x * v0y;
  const u = (px * v1y - v1x * py) / den, w = (v0x * py - px * v0y) / den;
  return Math.min(1 - u - w, u, w);
}

/** Walks to the leaf containing p (the child it lies deepest inside, so a point on a shared side picks one). */
function walkTo(root: TreeNode, p: Bary): { node: TreeLeaf; index: number } {
  let n = root, v = ROOT_BARY, index = 0;
  while (!isLeaf(n)) {
    const corners = childCorners(v, n.splitSides, n.special);
    let best = 0, bestMin = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      const m = minLocal(p, corners[i]);
      if (m > bestMin) { bestMin = m; best = i; }
    }
    for (let i = 0; i < best; i++) index += countLeaves(n.children[i]);
    n = n.children[best];
    v = corners[best];
  }
  return { node: n, index };
}

export function stateAtBary(root: TreeNode, p: Bary): number {
  return walkTo(root, p).node.state;
}

export function leafIndexAt(root: TreeNode, p: Bary): number {
  return walkTo(root, p).index;
}

/** One leaf if every child is a leaf of the same state, else the split with these children. */
function joined(n: TreeSplit, children: TreeNode[]): TreeNode {
  const first = children[0];
  if (isLeaf(first) && children.every((c) => isLeaf(c) && c.state === first.state)) return { state: first.state };
  return { splitSides: n.splitSides, special: n.special, children };
}

/**
 * Paints a sphere into a triangle's tree (the brush with "Split triangles", spec Q12.1). `corners`
 * are the triangle's corners and `center`/`radius` the sphere, all in one space. Leaves inside the
 * sphere take `state`. Leaves its surface crosses are cut on all three sides until their longest
 * side is at most `limit` (or the tree reaches MAX_TREE_LEAVES), and then take `state` if their
 * centroid is inside. Equal siblings merge. Returns `root` itself when nothing changed.
 */
export function paintSphereTree(
  root: TreeNode, corners: readonly [Vec3, Vec3, Vec3], center: Vec3, radius: number, state: number, limit: number,
): TreeNode {
  const r2 = radius * radius, limit2 = limit * limit;
  const [cx, cy, cz] = center;
  let leaves = countLeaves(root);
  const at = (b: Bary, k: number) => corners[0][k] * b[0] + corners[1][k] * b[1] + corners[2][k] * b[2];
  const point = (b: Bary): Vec3 => [at(b, 0), at(b, 1), at(b, 2)];
  const d2 = (p: Vec3, q: Vec3) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

  function walk(n: TreeNode, v: BaryTri): TreeNode {
    const p = [point(v[0]), point(v[1]), point(v[2])] as const;
    if (sqDistPointCorners(cx, cy, cz, ...p[0], ...p[1], ...p[2]) > r2) return n;
    if (d2(p[0], center) <= r2 && d2(p[1], center) <= r2 && d2(p[2], center) <= r2) {
      if (isLeaf(n)) return n.state === state ? n : { state };
      leaves -= countLeaves(n) - 1;
      return { state };
    }
    let node: TreeSplit;
    if (isLeaf(n)) {
      if (n.state === state) return n;
      const longest = Math.max(d2(p[0], p[1]), d2(p[1], p[2]), d2(p[2], p[0]));
      if (longest <= limit2 || leaves + 3 > MAX_TREE_LEAVES) {
        const g: Vec3 = [(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3, (p[0][2] + p[1][2] + p[2][2]) / 3];
        return d2(g, center) <= r2 ? { state } : n;
      }
      node = { splitSides: 3, special: 0, children: [n, n, n, n].map(() => ({ state: n.state })) };
      leaves += 3;
    } else node = n;
    const corners4 = childCorners(v, node.splitSides, node.special);
    let changed = false;
    const children = node.children.map((c, i) => {
      const r = walk(c, corners4[i]);
      if (r !== c) changed = true;
      return r;
    });
    if (!changed) {
      if (node !== n) leaves -= 3; // a cut that painted nothing is dropped
      return n;
    }
    const out = joined(node, children);
    if (isLeaf(out)) leaves -= children.length - 1;
    return out;
  }
  return walk(root, ROOT_BARY);
}

/** Paints the leaves with the given indices (`treeLeaves` numbering) and merges equal siblings. Returns `root` when nothing changed. */
export function paintTreeLeaves(root: TreeNode, chosen: ReadonlySet<number>, state: number): TreeNode {
  let next = 0;
  function walk(n: TreeNode): TreeNode {
    if (isLeaf(n)) return chosen.has(next++) && n.state !== state ? { state } : n;
    let changed = false;
    const children = n.children.map((c) => {
      const r = walk(c);
      if (r !== c) changed = true;
      return r;
    });
    return changed ? joined(n, children) : n;
  }
  return walk(root);
}

/** The most frequent leaf state (0 counts), ties to the higher state: the rule `remapTree` and `load3MF` use. */
export function treeDominant(root: TreeNode): number {
  const counts = new Map<number, number>();
  (function walk(n: TreeNode) {
    if (isLeaf(n)) counts.set(n.state, (counts.get(n.state) ?? 0) + 1);
    else n.children.forEach(walk);
  })(root);
  let dominant = 0, best = 0;
  for (const [s, c] of counts) if (c > best || (c === best && s > dominant)) { best = c; dominant = s; }
  return dominant;
}

/** Adds every leaf state to `into`: those > 0, and 0 too with `withUnpainted`. */
export function addLeafStates(root: TreeNode, into: Set<number>, withUnpainted = false): void {
  if (isLeaf(root)) { if (root.state > 0 || withUnpainted) into.add(root.state); return; }
  root.children.forEach((c) => addLeafStates(c, into, withUnpainted));
}
