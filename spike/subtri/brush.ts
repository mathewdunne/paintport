// Phase 5 spike: a sphere brush that paints below triangle resolution by growing the triangle's split
// tree. Trees here are in child order (the codec's string order reversed, see toChildOrder).
import type { PaintNode, PaintSplit } from "../../src/core/paint/codec";
import { childCorners, PRUSA, type Bary, type BaryTri } from "./splitGeometry";

export type V3 = [number, number, number];
const isSplit = (n: PaintNode): n is PaintSplit => !!(n as PaintSplit).children;

/** Codec (string) order <-> child order: PrusaSlicer writes children last to first. */
export const toChildOrder = (n: PaintNode): PaintNode =>
  isSplit(n) ? { ...n, children: [...n.children].reverse().map(toChildOrder) } : n;
export const toStringOrder = toChildOrder;

const CHILD_ORDER = { ...PRUSA, reversed: false };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const d2 = (a: V3, b: V3) => { const d = sub(a, b); return dot(d, d); };

/** Squared distance from p to triangle abc (closest point by region tests). */
export function sqDistToTri(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2_ = dot(ac, ap);
  if (d1 <= 0 && d2_ <= 0) return d2(p, a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return d2(p, b);
  const vc = d1 * d4 - d3 * d2_;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return d2(p, [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return d2(p, c);
  const vb = d5 * d2_ - d1 * d6;
  if (vb <= 0 && d2_ >= 0 && d6 <= 0) { const w = d2_ / (d2_ - d6); return d2(p, [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return d2(p, [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return d2(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

const at = (corners: [V3, V3, V3], b: Bary): V3 => [0, 1, 2].map((k) =>
  corners[0][k] * b[0] + corners[1][k] * b[1] + corners[2][k] * b[2]) as V3;

/**
 * Paints the sphere into one triangle's tree. Leaves fully inside take `state`; leaves the sphere's
 * surface crosses are split (all three sides) until their longest side is at most `limit`, and then
 * take `state` if their centroid is inside. Children that end up equal merge back into one leaf.
 */
export function paintSphereTree(root: PaintNode, corners: [V3, V3, V3], center: V3, radius: number, state: number, limit: number): PaintNode {
  const r2 = radius * radius, limit2 = limit * limit;
  function walk(n: PaintNode, v: BaryTri): PaintNode {
    const p = v.map((b) => at(corners, b)) as [V3, V3, V3];
    if (sqDistToTri(center, p[0], p[1], p[2]) > r2) return n;
    if (p.every((q) => d2(q, center) <= r2)) return { state };
    let node = n;
    if (!isSplit(node)) {
      const longest = Math.max(d2(p[0], p[1]), d2(p[1], p[2]), d2(p[2], p[0]));
      if (longest <= limit2) {
        const g: V3 = [0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3) as V3;
        return d2(g, center) <= r2 ? { state } : n;
      }
      node = { splitSides: 3, special: 0, children: [0, 1, 2, 3].map(() => ({ state: (n as { state: number }).state })) };
    }
    const kids = childCorners(v, node.splitSides, node.special, CHILD_ORDER);
    const children = node.children.map((c, i) => walk(c, kids[i]));
    const first = children[0];
    if (!isSplit(first) && children.every((c) => !isSplit(c) && c.state === first.state)) return { state: first.state };
    return { ...node, children };
  }
  return walk(root, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
}

export function countLeaves(n: PaintNode): number {
  return isSplit(n) ? n.children.reduce((s, c) => s + countLeaves(c), 0) : 1;
}
