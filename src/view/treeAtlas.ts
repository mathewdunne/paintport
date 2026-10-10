import { DataTexture, NearestFilter, RedIntegerFormat, UnsignedIntType } from "three";
import { isLeaf, parseTree, type TreeNode } from "../doc/splitTree";

// The sub-triangle trees of every drawn object, flattened into one R32UI texture the surface
// shader walks (spec Q12; measured in the phase 5 spike: exact, no frame cost).
//
// Word layout (one texel per node):
//   leaf:  bit 31 clear, bit 30 = highlighted (fill preview), bits 0..15 = design state (0 = unpainted)
//   split: bit 31 set, bits 29..30 = split sides, bits 27..28 = special side, bits 0..26 = first child
// A split's children sit next to each other in child order (FORMAT.md 2a).

/** Texels per row. */
export const ATLAS_WIDTH = 4096;
export const SPLIT_BIT = 0x80000000;
export const HIGHLIGHT_BIT = 0x40000000;
const CHILD_MASK = (1 << 27) - 1;
const MIN_ROWS = 1;

interface Entry {
  tree: string;
  root: number;
  size: number;
  /** Word index of each leaf, in leaf order (`treeLeaves`). */
  leaves: Uint32Array;
  highlighted: ReadonlySet<number> | null;
}

function createTexture(data: Uint32Array, rows: number): DataTexture {
  const texture = new DataTexture(data, ATLAS_WIDTH, rows, RedIntegerFormat, UnsignedIntType);
  texture.internalFormat = "R32UI";
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Trees are appended; a replaced or removed tree leaves garbage behind, which is compacted away
 * once it is half the buffer. Compaction moves every tree, so the owner must then rewrite every
 * triangle's root (`takeCompacted`).
 */
export class TreeAtlas {
  /** The shader uniform. Its `value` is replaced when the buffer outgrows the texture. */
  readonly uniform: { value: DataTexture };
  private data: Uint32Array;
  private used = 1; // word 0 stays unused, so root + 1 = 0 can mean "no tree"
  private garbage = 0;
  private compacted = false;
  private readonly entries = new Map<number, Map<number, Entry>>();

  constructor() {
    this.data = new Uint32Array(ATLAS_WIDTH * MIN_ROWS);
    this.uniform = { value: createTexture(this.data, MIN_ROWS) };
  }

  get texture(): DataTexture {
    return this.uniform.value;
  }

  /** The node words (live; for tests and the CPU walk). */
  get words(): Uint32Array {
    return this.data;
  }

  /** Stores (or with `tree` undefined, removes) a triangle's tree. Returns its root index + 1, 0 for none. */
  set(object: number, tri: number, tree: string | undefined): number {
    const byTri = this.entries.get(object);
    const old = byTri?.get(tri);
    if (old && old.tree === tree) return old.root + 1;
    if (old) {
      this.garbage += old.size;
      byTri!.delete(tri);
    }
    if (tree === undefined) return 0;
    const root = parseTree(tree);
    if (isLeaf(root)) return 0;
    const entry = this.write(tree, root);
    let map = byTri;
    if (!map) this.entries.set(object, (map = new Map()));
    map.set(tri, entry);
    if (this.garbage > 65536 && this.garbage * 2 > this.used) this.compact();
    return this.entries.get(object)!.get(tri)!.root + 1;
  }

  /** Root index + 1 of a stored tree, 0 for none. */
  rootOf(object: number, tri: number): number {
    const e = this.entries.get(object)?.get(tri);
    return e ? e.root + 1 : 0;
  }

  /** Marks the given leaves (leaf indices) of a stored tree as highlighted; null clears. Returns false without a tree. */
  highlight(object: number, tri: number, leaves: ReadonlySet<number> | null): boolean {
    const e = this.entries.get(object)?.get(tri);
    if (!e) return false;
    e.highlighted = leaves && leaves.size > 0 ? leaves : null;
    for (let i = 0; i < e.leaves.length; i++) {
      const w = e.leaves[i];
      this.data[w] = e.highlighted?.has(i) ? (this.data[w] | HIGHLIGHT_BIT) >>> 0 : (this.data[w] & ~HIGHLIGHT_BIT) >>> 0;
    }
    this.flag(e.root, e.size);
    return true;
  }

  /** True once after a compaction moved every tree (the owner rewrites all roots). */
  takeCompacted(): boolean {
    const c = this.compacted;
    this.compacted = false;
    return c;
  }

  /** Forgets every tree (a new scene). */
  clear(): void {
    this.entries.clear();
    this.used = 1;
    this.garbage = 0;
    this.compacted = false;
  }

  dispose(): void {
    this.texture.dispose();
  }

  /** Appends a tree; children of a split are reserved together, then filled depth first. */
  private write(tree: string, root: TreeNode): Entry {
    const start = this.used;
    const size = countNodes(root);
    this.reserve(size);
    const leaves: number[] = [];
    let next = start + 1;
    const fill = (n: TreeNode, at: number) => {
      if (isLeaf(n)) {
        this.data[at] = n.state & 0xffff;
        leaves.push(at);
        return;
      }
      const first = next;
      next += n.children.length;
      this.data[at] = (SPLIT_BIT | (n.splitSides << 29) | (n.special << 27) | (first & CHILD_MASK)) >>> 0;
      n.children.forEach((c, i) => fill(c, first + i));
    };
    fill(root, start);
    this.used = start + size;
    this.flag(start, size);
    return { tree, root: start, size, leaves: Uint32Array.from(leaves), highlighted: null };
  }

  private reserve(size: number): void {
    if (this.used + size <= this.data.length) return;
    let rows = this.data.length / ATLAS_WIDTH;
    while (rows * ATLAS_WIDTH < this.used + size) rows *= 2;
    const bigger = new Uint32Array(rows * ATLAS_WIDTH);
    bigger.set(this.data.subarray(0, this.used));
    this.data = bigger;
    const old = this.uniform.value;
    this.uniform.value = createTexture(this.data, rows); // uploads whole
    old.dispose();
  }

  /** Rewrites every live tree at the start of the buffer. */
  private compact(): void {
    const all: [number, number, Entry][] = [];
    for (const [object, byTri] of this.entries) for (const [tri, e] of byTri) all.push([object, tri, e]);
    this.used = 1;
    this.garbage = 0;
    for (const [object, tri, e] of all) {
      const fresh = this.write(e.tree, parseTree(e.tree));
      this.entries.get(object)!.set(tri, fresh);
      if (e.highlighted) this.highlight(object, tri, e.highlighted);
    }
    this.texture.needsUpdate = true;
    this.texture.clearUpdateRanges(); // the whole texture uploads
    this.compacted = true;
  }

  /** Flags words for upload, one range per texture row (three.js counts 4 components per texel). */
  private flag(start: number, count: number): void {
    const texture = this.texture;
    let at = start;
    const end = start + count;
    while (at < end) {
      const rowEnd = Math.min(end, (Math.floor(at / ATLAS_WIDTH) + 1) * ATLAS_WIDTH);
      texture.addUpdateRange(at * 4, (rowEnd - at) * 4);
      at = rowEnd;
    }
    texture.needsUpdate = true;
  }
}

function countNodes(n: TreeNode): number {
  return isLeaf(n) ? 1 : 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

/** The walk the fragment shader does (material.ts), on the CPU: the state word of the leaf containing `p`. */
export function walkAtlas(words: Uint32Array, root: number, p: readonly [number, number, number]): number {
  let word = words[root] >>> 0;
  let a = [1, 0, 0], b = [0, 1, 0], c = [0, 0, 1];
  const mid = (u: number[], v: number[]) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2, (u[2] + v[2]) / 2];
  const minLocal = (t: number[][]) => {
    const [ta, tb, tc] = t;
    const v0x = tb[1] - ta[1], v0y = tb[2] - ta[2], v1x = tc[1] - ta[1], v1y = tc[2] - ta[2];
    const qx = p[1] - ta[1], qy = p[2] - ta[2];
    const den = v0x * v1y - v1x * v0y;
    const u = (qx * v1y - v1x * qy) / den, w = (v0x * qy - qx * v0y) / den;
    return Math.min(1 - u - w, u, w);
  };
  for (let depth = 0; depth < 32 && (word & SPLIT_BIT); depth++) {
    const sides = (word >>> 29) & 3, special = (word >>> 27) & 3, first = word & CHILD_MASK;
    const v = [a, b, c];
    const r0 = v[special], r1 = v[(special + 1) % 3], r2 = v[(special + 2) % 3];
    let kids: number[][][];
    if (sides === 1) { const m = mid(r1, r2); kids = [[r0, r1, m], [m, r2, r0]]; }
    else if (sides === 2) { const m1 = mid(r0, r1), m2 = mid(r0, r2); kids = [[r0, m1, m2], [m1, r1, m2], [r1, r2, m2]]; }
    else { const m01 = mid(r0, r1), m12 = mid(r1, r2), m20 = mid(r2, r0); kids = [[r0, m01, m20], [m01, r1, m12], [m12, r2, m20], [m01, m12, m20]]; }
    let best = 0, bestMin = -Infinity;
    kids.forEach((k, i) => { const m = minLocal(k); if (m > bestMin) { bestMin = m; best = i; } });
    [a, b, c] = kids[best];
    word = words[first + best] >>> 0;
  }
  return word;
}
