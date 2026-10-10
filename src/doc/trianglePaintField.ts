import { emitPaintTree, remapPaintString, type PaintDialect } from "../core";
import type { BrushOpts, EditableMesh, EditRecord, PaintField, Region, State, Vec3 } from "./paintField";
import { INTERNAL_DIALECT, remapTree } from "./paintTree";
import { addLeafStates, emitTree, isLeaf, paintSphereTree, paintTreeLeaves, parseTree, stateAtBary, treeDominant, type TreeNode } from "./splitTree";
import { sqDistPointTriangle } from "./triangleMath";

export { isSplitTree } from "./paintTree";

/** Per-triangle changes. A record entry fully defines the triangle's state after the edit. */
interface DiffEdit extends EditRecord {
  kind: "diff";
  tris: Uint32Array;
  before: Uint16Array;
  /** The state after the edit per triangle, or one value when every triangle got the same (a paint). */
  after: Uint16Array | number;
  /** Preserved tree of a triangle before / after the edit; absent = none. */
  preservedBefore: Map<number, string>;
  preservedAfter: Map<number, string>;
}

/** A bijective renaming of states, stored as its two tables. */
interface RenumberEdit extends EditRecord {
  kind: "renumber";
  forward: Uint16Array;
  inverse: Uint16Array;
}

const NO_TRIS = new Uint32Array(0);
const RECORD_OVERHEAD = 96; // object, maps and typed array headers
const TREE_OVERHEAD = 56; // map entry and string header, per preserved tree

const afterAt = (after: Uint16Array | number, i: number): number => (typeof after === "number" ? after : after[i]);

function treeBytes(m: Map<number, string>): number {
  let n = 0;
  for (const s of m.values()) n += TREE_OVERHEAD + s.length;
  return n;
}

function diffEdit(tris: Uint32Array, before: Uint16Array, after: Uint16Array | number, pb: Map<number, string>, pa: Map<number, string>): DiffEdit {
  const bytes = RECORD_OVERHEAD + tris.length * 4 + before.length * 2 + (typeof after === "number" ? 0 : after.length * 2) + treeBytes(pb) + treeBytes(pa);
  return { kind: "diff", size: tris.length, bytes, tris, before, after, preservedBefore: pb, preservedAfter: pa };
}

const asDiff = (e: EditRecord): DiffEdit => {
  if ((e as DiffEdit).kind !== "diff") throw new TypeError("Not a per-triangle diff edit");
  return e as DiffEdit;
};

/**
 * One design state per triangle, plus sub-triangle trees (spec 5.3, Q12).
 *
 * `states` holds design states, 0 = unpainted. Split triangles keep their paint tree in
 * `preserved`, in design states and the internal dialect ("bbs", see paintTree.ts): trees
 * from the imported file and trees the brush grew ("Split triangles"). `states[t]` is then
 * the tree's dominant state. Painting a triangle whole sets its state and drops its tree;
 * the split brush and `paintRegion` edit trees; `remap` rewrites the trees' leaves and
 * recomputes the dominant state.
 *
 * `preserved` is a sparse map rather than an array of strings per triangle: typical
 * files have few split triangles, and a 1.3M-entry array would cost megabytes of nulls.
 */
export class TrianglePaintField implements PaintField {
  readonly mesh: EditableMesh;
  /** Design state per triangle. Live storage; edit only through the methods below. */
  readonly states: Uint16Array;
  /** Triangle -> paint tree (design states, internal dialect) for triangles with sub-triangle detail. */
  readonly preserved: Map<number, string>;
  private readonly paintable: Uint8Array;
  private mergeScratch: Uint32Array | null = null;
  /** Parsed trees and their leaf states, by triangle; an entry is valid while its string matches `preserved`. */
  private readonly parsed = new Map<number, { tree: string; root: TreeNode; states: Set<number> }>();

  /** Shares `mesh` and `paintable` (1 = ModelPart triangle) with the caller; takes ownership of `init`. */
  constructor(mesh: EditableMesh, paintable: Uint8Array, init?: { states?: Uint16Array; preserved?: Map<number, string> }) {
    this.mesh = mesh;
    this.paintable = paintable;
    this.states = init?.states ?? new Uint16Array(mesh.triCount);
    this.preserved = init?.preserved ?? new Map();
  }

  stateAt(tri: number, bary?: readonly [number, number, number]): State {
    if (bary && this.preserved.size > 0) {
      const p = this.parsedTree(tri);
      if (p) return stateAtBary(p.root, [bary[0], bary[1], bary[2]]);
    }
    return this.states[tri];
  }

  treeOf(tri: number): string | undefined {
    return this.preserved.size > 0 ? this.preserved.get(tri) : undefined;
  }

  trees(): ReadonlyMap<number, string> {
    return this.preserved;
  }

  leafStates(tri: number): ReadonlySet<number> | undefined {
    return this.parsedTree(tri)?.states;
  }

  /** The triangle's tree, parsed (cached while its string is unchanged); undefined without one. */
  private parsedTree(tri: number): { tree: string; root: TreeNode; states: Set<number> } | undefined {
    const tree = this.preserved.get(tri);
    if (tree === undefined) { this.parsed.delete(tri); return undefined; }
    let p = this.parsed.get(tri);
    if (!p || p.tree !== tree) {
      const root = parseTree(tree), states = new Set<number>();
      addLeafStates(root, states, true);
      this.parsed.set(tri, (p = { tree, root, states }));
    }
    return p;
  }

  displayStates(): Readonly<Uint16Array> {
    return this.states;
  }

  isPaintable(tri: number): boolean {
    return this.paintable[tri] === 1;
  }

  serialize(dialect: PaintDialect): { mesh: EditableMesh; paint: (string | null)[] } {
    const { states, preserved } = this;
    const paint = new Array<string | null>(states.length).fill(null);
    const leaves = new Map<number, string>(); // one shared string per state
    for (let t = 0; t < states.length; t++) {
      const tree = preserved.size > 0 ? preserved.get(t) : undefined;
      if (tree !== undefined) {
        paint[t] = dialect === INTERNAL_DIALECT ? tree : remapPaintString(tree, (s) => s, INTERNAL_DIALECT, dialect).str;
        continue;
      }
      const s = states[t];
      if (s === 0) continue;
      let leaf = leaves.get(s);
      if (leaf === undefined) leaves.set(s, (leaf = emitPaintTree({ state: s }, dialect)));
      paint[t] = leaf;
    }
    return { mesh: this.mesh, paint };
  }

  paintSphere(center: Vec3, radius: number, state: State, opts?: BrushOpts): EditRecord {
    if (!(radius >= 0) || !Number.isFinite(radius)) return diffEdit(NO_TRIS, new Uint16Array(0), state, new Map(), new Map());
    const { vertices, tris } = this.mesh;
    const { states, preserved, paintable } = this;
    const cand = opts?.candidates;
    const exact = !!cand && !!opts?.candidatesExact; // the caller already tested them
    const split = opts?.split && opts.split.limit > 0 ? opts.split : null;
    const count = cand ? cand.length : this.mesh.triCount;
    const hits = new Uint32Array(count);
    const grown: { t: number; root: TreeNode }[] = [];
    const r2 = radius * radius;
    const [cx, cy, cz] = center;
    const corner = (t: number, c: number): Vec3 => {
      const v = tris[t * 3 + c] * 3;
      return [vertices[v], vertices[v + 1], vertices[v + 2]];
    };
    const inside = (p: Vec3) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2 <= r2;
    let k = 0;
    for (let i = 0; i < count; i++) {
      const t = cand ? cand[i] : i;
      if (paintable[t] !== 1) continue;
      const tree = preserved.size > 0 ? preserved.get(t) : undefined;
      if (states[t] === state && tree === undefined) continue; // nothing to change: skip the geometry test
      if (!exact && sqDistPointTriangle(vertices, tris, t, cx, cy, cz) > r2) continue;
      if (split) {
        const c: [Vec3, Vec3, Vec3] = [corner(t, 0), corner(t, 1), corner(t, 2)];
        if (!(inside(c[0]) && inside(c[1]) && inside(c[2]))) { // crossed by the sphere's surface: grow the tree
          const before = tree !== undefined ? this.parsedTree(t)!.root : { state: states[t] };
          const after = paintSphereTree(before, c, center, radius, state, split.limit);
          if (after !== before) grown.push({ t, root: after });
          continue;
        }
      }
      hits[k++] = t;
    }
    const whole = this.paintTriangles(hits.subarray(0, k), state);
    if (grown.length === 0) return whole;
    const edited = this.applyTrees(grown);
    return whole.size === 0 ? edited : this.mergeEdits([whole, edited]);
  }

  paintRegion(region: Region, state: State): EditRecord {
    const whole = Array.from(region.tris);
    const edits: { t: number; root: TreeNode }[] = [];
    for (const [t, leaves] of region.pieces) {
      if (this.paintable[t] !== 1) continue;
      const p = this.parsedTree(t);
      if (!p) { whole.push(t); continue; }
      const after = paintTreeLeaves(p.root, new Set(leaves), state);
      if (after !== p.root) edits.push({ t, root: after });
    }
    const a = this.paintTriangles(whole, state);
    if (edits.length === 0) return a;
    const b = this.applyTrees(edits);
    return a.size === 0 ? b : this.mergeEdits([a, b]);
  }

  /** Stores new trees as one edit; a tree that is a single leaf paints its triangle whole. */
  private applyTrees(edits: readonly { t: number; root: TreeNode }[]): EditRecord {
    const { states, preserved } = this;
    const n = edits.length;
    const outTris = new Uint32Array(n), before = new Uint16Array(n), after = new Uint16Array(n);
    const pb = new Map<number, string>(), pa = new Map<number, string>();
    edits.forEach(({ t, root }, i) => {
      outTris[i] = t;
      before[i] = states[t];
      const old = preserved.get(t);
      if (old !== undefined) pb.set(t, old);
      if (isLeaf(root)) {
        preserved.delete(t);
        this.parsed.delete(t);
        states[t] = root.state;
      } else {
        const tree = emitTree(root);
        preserved.set(t, tree);
        pa.set(t, tree);
        states[t] = treeDominant(root);
        const leafStates = new Set<number>();
        addLeafStates(root, leafStates, true);
        this.parsed.set(t, { tree, root, states: leafStates });
      }
      after[i] = states[t];
    });
    return diffEdit(outTris, before, after, pb, pa);
  }

  paintTriangles(tris: ArrayLike<number>, state: State): EditRecord {
    const { states, preserved, paintable } = this;
    const n = tris.length;
    const outTris = new Uint32Array(n), outBefore = new Uint16Array(n);
    const pb = new Map<number, string>();
    const anyPreserved = preserved.size > 0;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const t = tris[i];
      if (paintable[t] !== 1) continue; // also rejects out-of-range ids
      const tree = anyPreserved ? preserved.get(t) : undefined;
      if (states[t] === state && tree === undefined) continue;
      outTris[k] = t;
      outBefore[k] = states[t];
      k++;
      if (tree !== undefined) { pb.set(t, tree); preserved.delete(t); this.parsed.delete(t); }
      states[t] = state;
    }
    return diffEdit(outTris.slice(0, k), outBefore.slice(0, k), state, pb, new Map());
  }

  remap(map: (s: State) => State): EditRecord {
    const { states, preserved } = this;
    const cache: number[] = [];
    const m = (s: number): number => {
      if (s === 0) return 0;
      let v = cache[s];
      if (v === undefined) {
        v = map(s);
        if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`remap produced an invalid state ${v} for ${s}`);
        cache[s] = v;
      }
      return v;
    };
    // Everything that can throw (the map, corrupt trees) runs before the first write.
    const n = states.length;
    const changed = new Uint32Array(n);
    let k = 0;
    const anyPreserved = preserved.size > 0;
    for (let t = 0; t < n; t++) {
      const s = states[t];
      if (s === 0 || (anyPreserved && preserved.has(t))) continue;
      if (m(s) !== s) changed[k++] = t;
    }
    const plainCount = k;
    // Preserved triangles: rewrite the tree, the dominant state follows from the new tree.
    const rewritten = new Map<number, { tree: string; dominant: number }>();
    for (const [t, tree] of preserved) {
      const r = remapTree(tree, m);
      if (r.tree !== tree || r.dominant !== states[t]) {
        rewritten.set(t, r);
        changed[k++] = t;
      }
    }
    const tris = changed.slice(0, k);
    const before = new Uint16Array(k), after = new Uint16Array(k);
    const pb = new Map<number, string>(), pa = new Map<number, string>();
    for (let i = 0; i < k; i++) {
      const t = tris[i];
      before[i] = states[t];
      const r = rewritten.get(t);
      if (r) {
        after[i] = r.dominant;
        pb.set(t, preserved.get(t)!);
        pa.set(t, r.tree);
      } else after[i] = m(states[t]);
    }
    for (let i = 0; i < plainCount; i++) states[tris[i]] = after[i];
    for (let i = plainCount; i < k; i++) {
      const t = tris[i];
      states[t] = after[i];
      preserved.set(t, pa.get(t)!);
    }
    return diffEdit(tris, before, after, pb, pa);
  }

  renumber(forward: Uint16Array, inverse: Uint16Array): EditRecord {
    let identity = true;
    for (let s = 0; s < forward.length && identity; s++) if (forward[s] !== s) identity = false;
    const edit: RenumberEdit = {
      kind: "renumber", size: identity ? 0 : this.states.length, bytes: RECORD_OVERHEAD + (forward.length + inverse.length) * 2,
      forward, inverse,
    };
    if (!identity) this.applyTable(forward);
    return edit;
  }

  mergeEdits(edits: readonly EditRecord[]): EditRecord {
    const diffs = edits.map(asDiff);
    if (diffs.length === 1) return diffs[0];
    let total = 0;
    for (const d of diffs) total += d.tris.length;
    const scratch = (this.mergeScratch ??= new Uint32Array(this.mesh.triCount)); // slot + 1 per triangle, 0 = unseen
    const tris = new Uint32Array(total), before = new Uint16Array(total), after = new Uint16Array(total);
    const pb = new Map<number, string>(), pa = new Map<number, string>();
    const anyPreserved = diffs.some((d) => d.preservedBefore.size > 0 || d.preservedAfter.size > 0);
    let k = 0;
    for (const d of diffs) {
      for (let i = 0; i < d.tris.length; i++) {
        const t = d.tris[i];
        const slot = scratch[t];
        if (slot === 0) {
          tris[k] = t; before[k] = d.before[i]; after[k] = afterAt(d.after, i);
          scratch[t] = ++k;
          if (anyPreserved) { const p = d.preservedBefore.get(t); if (p !== undefined) pb.set(t, p); }
        } else after[slot - 1] = afterAt(d.after, i);
        if (anyPreserved) {
          const p = d.preservedAfter.get(t);
          if (p !== undefined) pa.set(t, p); else pa.delete(t);
        }
      }
    }
    for (let i = 0; i < k; i++) scratch[tris[i]] = 0;
    // A stroke with one color (the common case) ends up uniform and needs no per-triangle array.
    let uniform = k > 0;
    for (let i = 1; i < k && uniform; i++) if (after[i] !== after[0]) uniform = false;
    return diffEdit(tris.slice(0, k), before.slice(0, k), uniform ? after[0] : after.slice(0, k), pb, pa);
  }

  editedTriangles(edit: EditRecord): Uint32Array {
    const e = edit as DiffEdit | RenumberEdit;
    return e.kind === "diff" ? e.tris : NO_TRIS;
  }

  undoEdit(edit: EditRecord): void {
    const e = edit as DiffEdit | RenumberEdit;
    if (e.kind === "renumber") { if (e.size > 0) this.applyTable(e.inverse); return; }
    this.applyDiff(e.tris, e.before, e.preservedAfter, e.preservedBefore);
  }

  redoEdit(edit: EditRecord): void {
    const e = edit as DiffEdit | RenumberEdit;
    if (e.kind === "renumber") { if (e.size > 0) this.applyTable(e.forward); return; }
    this.applyDiff(e.tris, e.after, e.preservedBefore, e.preservedAfter);
  }

  /** Writes `values` to `tris` and swaps the preserved trees: `from` entries out, `to` entries in. */
  private applyDiff(tris: Uint32Array, values: Uint16Array | number, from: Map<number, string>, to: Map<number, string>): void {
    const { states, preserved } = this;
    if (typeof values === "number") for (let i = 0; i < tris.length; i++) states[tris[i]] = values;
    else for (let i = 0; i < tris.length; i++) states[tris[i]] = values[i];
    for (const t of from.keys()) { preserved.delete(t); this.parsed.delete(t); }
    for (const [t, tree] of to) preserved.set(t, tree);
  }

  /** Renames every state (and tree leaf) through `table`; validates everything first, then writes. */
  private applyTable(table: Uint16Array): void {
    const { states, preserved } = this;
    const map = (s: number): number => {
      const v = table[s];
      if (v === undefined) throw new RangeError(`State ${s} is outside the renumbering table`);
      return v;
    };
    for (let i = 0; i < states.length; i++) map(states[i]);
    const trees: [number, string][] = [];
    for (const [t, tree] of preserved) trees.push([t, remapTree(tree, map).tree]);
    for (let i = 0; i < states.length; i++) states[i] = table[states[i]];
    for (const [t, tree] of trees) preserved.set(t, tree);
  }
}
