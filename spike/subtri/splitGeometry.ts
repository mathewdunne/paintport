// Phase 5 spike: where the leaves of a TriangleSelector paint tree lie on their triangle.
// Reimplemented from a prose description of PrusaSlicer's TriangleSelector (see REPORT.md),
// with the uncertain conventions as parameters so real files can decide between them.
import type { PaintNode, PaintSplit } from "../../src/core/paint/codec";

/** Barycentric point relative to the root triangle's corners. */
export type Bary = [number, number, number];
export type BaryTri = [Bary, Bary, Bary];

export interface Convention {
  /** Children appear in the string in reverse child order (PrusaSlicer serializes children[n] first). */
  reversed: boolean;
  /** The rotation start is `special + offset` (mod 3). PrusaSlicer: 0. */
  offset: 0 | 1 | 2;
  /** Overrides `offset` for nodes with 1 or 2 split sides (to test those rules on their own). */
  offsetBySides?: Partial<Record<1 | 2, 0 | 1 | 2>>;
}

export const PRUSA: Convention = { reversed: true, offset: 0 };

export const ALL_CONVENTIONS: Convention[] = [false, true].flatMap((reversed) =>
  ([0, 1, 2] as const).map((offset) => ({ reversed, offset })),
);

export const conventionName = (c: Convention) =>
  `${c.reversed ? "rev" : "fwd"}+${c.offset}${c.offsetBySides ? ` (1:${c.offsetBySides[1] ?? c.offset} 2:${c.offsetBySides[2] ?? c.offset})` : ""}`;

/** Reversed order with every pair of offsets for 1- and 2-side splits. */
export const SIDE_VARIANTS: Convention[] = ([0, 1, 2] as const).flatMap((o1) =>
  ([0, 1, 2] as const).map((o2) => ({ reversed: true, offset: 0 as const, offsetBySides: { 1: o1, 2: o2 } })),
);

const mid = (a: Bary, b: Bary): Bary => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

const isSplit = (n: PaintNode): n is PaintSplit => !!(n as PaintSplit).children;

/** The corners of each child of a split triangle with corners `v`, in child order. */
export function childCorners(v: BaryTri, splitSides: number, special: number, c: Convention): BaryTri[] {
  const s = (special + (c.offsetBySides?.[splitSides as 1 | 2] ?? c.offset)) % 3;
  const r0 = v[s], r1 = v[(s + 1) % 3], r2 = v[(s + 2) % 3];
  if (splitSides === 1) {
    const m = mid(r1, r2); // the side opposite the special corner
    return [[r0, r1, m], [m, r2, r0]];
  }
  if (splitSides === 2) {
    const m1 = mid(r0, r1), m2 = mid(r0, r2); // the two sides at the special corner
    return [[r0, m1, m2], [m1, r1, m2], [r1, r2, m2]];
  }
  // Three sides: the special side is always 0 in PrusaSlicer, but rotate anyway.
  const m01 = mid(r0, r1), m12 = mid(r1, r2), m20 = mid(r2, r0);
  return [[r0, m01, m20], [m01, r1, m12], [m12, r2, m20], [m01, m12, m20]];
}

/** The tree's children in child order. */
export function orderedChildren(n: PaintSplit, c: Convention): PaintNode[] {
  return c.reversed ? [...n.children].reverse() : n.children;
}

export const ROOT: BaryTri = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Every leaf as a barycentric triangle with its state. */
export function leaves(root: PaintNode, c: Convention, out: { tri: BaryTri; state: number; depth: number }[] = []) {
  (function walk(n: PaintNode, v: BaryTri, depth: number) {
    if (!isSplit(n)) { out.push({ tri: v, state: n.state, depth }); return; }
    const corners = childCorners(v, n.splitSides, n.special, c);
    orderedChildren(n, c).forEach((child, i) => walk(child, corners[i], depth + 1));
  })(root, ROOT, 0);
  return out;
}

/** p's barycentric coordinates relative to triangle t (all in root barycentrics, using coordinates 1 and 2 as a plane). */
function local(p: Bary, t: BaryTri): Bary {
  const [a, b, c] = t;
  const v0x = b[1] - a[1], v0y = b[2] - a[2], v1x = c[1] - a[1], v1y = c[2] - a[2];
  const px = p[1] - a[1], py = p[2] - a[2];
  const den = v0x * v1y - v1x * v0y;
  const u = (px * v1y - v1x * py) / den, w = (v0x * py - px * v0y) / den;
  return [1 - u - w, u, w];
}

/** The state of the leaf containing p (the first child that contains it, with a small tolerance). */
export function stateAt(root: PaintNode, p: Bary, c: Convention): number {
  let n = root, v = ROOT;
  while (isSplit(n)) {
    const corners = childCorners(v, n.splitSides, n.special, c);
    const kids = orderedChildren(n, c);
    let best = 0, bestMin = -Infinity;
    for (let i = 0; i < corners.length; i++) {
      const l = local(p, corners[i]);
      const m = Math.min(l[0], l[1], l[2]);
      if (m > bestMin) { bestMin = m; best = i; }
    }
    n = kids[best];
    v = corners[best];
  }
  return n.state;
}
