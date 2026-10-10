// Phase 5 spike: split trees flattened into one Uint32 array a shader can walk.
//
// Node word: leaf = state (bit 31 clear); split = bit 31 | sides << 29 | special << 27 | first child
// index (27 bits). A split's children are stored next to each other in child order (PrusaSlicer's,
// i.e. the string's order reversed).
import type { PaintNode } from "../../src/core/paint/codec";
import { childCorners, ROOT, PRUSA, type Bary, type BaryTri } from "./splitGeometry";

export const SPLIT_BIT = 0x80000000;
const CHILD_MASK = (1 << 27) - 1;

/** Appends the tree (given in string order) and returns its root index. */
export function appendTree(nodes: number[], root: PaintNode): number {
  const rootIndex = nodes.length;
  nodes.push(0);
  const queue: [PaintNode, number][] = [[root, rootIndex]];
  while (queue.length) {
    const [n, at] = queue.pop()!;
    if (!("children" in n)) { nodes[at] = n.state; continue; }
    const kids = [...n.children].reverse(); // string order -> child order
    const first = nodes.length;
    for (let i = 0; i < kids.length; i++) nodes.push(0);
    if (first > CHILD_MASK) throw new Error("tree buffer too large");
    nodes[at] = (SPLIT_BIT | (n.splitSides << 29) | (n.special << 27) | first) >>> 0;
    kids.forEach((k, i) => queue.push([k, first + i]));
  }
  return rootIndex;
}

/** The walk the fragment shader does, on the CPU (to test the layout against `stateAt`). */
export function walk(nodes: Uint32Array | number[], rootIndex: number, p: Bary): number {
  let word = nodes[rootIndex] >>> 0, v: BaryTri = ROOT;
  for (let depth = 0; depth < 32 && (word & SPLIT_BIT); depth++) {
    const sides = (word >>> 29) & 3, special = (word >>> 27) & 3, first = word & CHILD_MASK;
    const corners = childCorners(v, sides, special, { ...PRUSA, reversed: false });
    let best = 0, bestMin = -Infinity;
    corners.forEach((t, i) => {
      const m = minLocal(p, t);
      if (m > bestMin) { bestMin = m; best = i; }
    });
    v = corners[best];
    word = nodes[first + best] >>> 0;
  }
  return word;
}

function minLocal(p: Bary, [a, b, c]: BaryTri): number {
  const v0x = b[1] - a[1], v0y = b[2] - a[2], v1x = c[1] - a[1], v1y = c[2] - a[2];
  const px = p[1] - a[1], py = p[2] - a[2];
  const den = v0x * v1y - v1x * v0y;
  const u = (px * v1y - v1x * py) / den, w = (v0x * py - px * v0y) / den;
  return Math.min(1 - u - w, u, w);
}
