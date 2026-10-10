// The surface the fills flood (spec Q12.3): triangles, where a split triangle is replaced by the
// pieces (leaves) of its tree. Pieces link to the pieces of the same tree they share a stretch of
// side with, and across the triangle's sides to the neighbor (or the neighbor's pieces) on the
// matching stretch of the shared edge. So a fill stops exactly at a brushed line.
//
// Node ids: 0..triCount-1 are triangles; ids from triCount up are pieces, numbered as the graph
// first reaches their triangle (a graph lives for one fill computation).
import type { Region } from "./paintField";
import type { DisplayView } from "./fill";
import { neighborFlipped, neighborTri, NEIGHBOR_NON_MANIFOLD, type MeshTopology } from "./meshTopology";
import { childCorners, isLeaf, leafIndexAt, parseTree, ROOT_BARY, treeLeaves, type Bary, type TreeNode } from "./splitTree";

/** Where a fill starts: a triangle, and for a split triangle the point (barycentric) that picks the piece. */
export interface Seed {
  tri: number;
  bary?: readonly [number, number, number];
}

/** Neighbor nodes and, per neighbor, the topology neighbor code of the crossing (-1 inside one triangle). */
export class NodeBuffer {
  nodes = new Int32Array(16);
  codes = new Int32Array(16);
  length = 0;

  push(node: number, code: number): void {
    if (this.length === this.nodes.length) {
      const n = new Int32Array(this.length * 2), c = new Int32Array(this.length * 2);
      n.set(this.nodes); c.set(this.codes);
      this.nodes = n; this.codes = c;
    }
    this.nodes[this.length] = node;
    this.codes[this.length++] = code;
  }
}

/** One tree's pieces, independent of where the triangle is. */
export interface TreePieces {
  count: number;
  states: Uint16Array;
  /** Centroid per leaf (barycentric, 3 numbers each). */
  centroids: Float32Array;
  /** Share of the triangle's area per leaf. */
  areaShare: Float32Array;
  /** Leaves sharing a stretch of side: `adjacent[adjacentStart[i] .. adjacentStart[i + 1])`. */
  adjacentStart: Uint32Array;
  adjacent: Uint32Array;
  /** Stretches of the root's sides per leaf: `side[j]`, `from[j]`..`to[j]` (measured from corner `side` toward the next), j in `contactStart[i] ..`. */
  contactStart: Uint32Array;
  side: Uint8Array;
  from: Float64Array;
  to: Float64Array;
  /** The same stretches by root side, sorted by `from`: side s is `bySide*[bySideStart[s] .. bySideStart[s + 1])`. */
  bySideStart: Uint32Array;
  bySideLeaf: Uint32Array;
  bySideFrom: Float64Array;
  bySideTo: Float64Array;
}

/** Trees whose pieces stay cached per object (goldfish: 77k trees, about 30 leaves each). */
const MAX_CACHED_TREES = 40000;
const pieceCache = new WeakMap<MeshTopology, Map<number, { tree: string; pieces: TreePieces }>>();

/** The pieces of a tree string (internal dialect), cached per triangle while its string is unchanged. */
function piecesOf(topology: MeshTopology, tri: number, tree: string): TreePieces {
  let byTri = pieceCache.get(topology);
  if (!byTri) pieceCache.set(topology, (byTri = new Map()));
  const hit = byTri.get(tri);
  if (hit && hit.tree === tree) return hit.pieces;
  const pieces = buildPieces(parseTree(tree));
  if (byTri.size >= MAX_CACHED_TREES) byTri.clear(); // bounds the memory on files with very many trees
  byTri.set(tri, { tree, pieces });
  return pieces;
}

/** How a split's children lie in it: which child sides cover each of its sides, and which child sides meet inside. */
interface SplitLayout {
  /** Per side k of the parent, in order from corner k: child, child side, and where it starts and ends along side k (0..1). */
  onSide: { child: number; side: number; from: number; to: number }[][];
  /** Child sides that coincide inside the parent (run in opposite directions). */
  inner: { a: number; sideA: number; b: number; sideB: number }[];
}

const layouts = new Map<number, SplitLayout>();

/** The layout of a split (cached per kind), derived from `childCorners` in the parent's own barycentrics. */
function layoutOf(sides: number, special: number): SplitLayout {
  const key = sides * 4 + special;
  let layout = layouts.get(key);
  if (layout) return layout;
  const kids = childCorners(ROOT_BARY, sides, special);
  const same = (p: Bary, q: Bary) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
  const onSide: SplitLayout["onSide"] = [[], [], []];
  const inner: SplitLayout["inner"] = [];
  kids.forEach((t, c) => {
    for (let e = 0; e < 3; e++) {
      const p = t[e], q = t[(e + 1) % 3];
      let outer = false;
      for (let k = 0; k < 3; k++) {
        const zero = (k + 2) % 3, along = (k + 1) % 3;
        if (p[zero] === 0 && q[zero] === 0) {
          onSide[k].push({ child: c, side: e, from: p[along], to: q[along] });
          outer = true;
        }
      }
      if (outer) continue;
      kids.forEach((u, d) => {
        if (d <= c) return;
        for (let f = 0; f < 3; f++) if (same(u[f], q) && same(u[(f + 1) % 3], p)) inner.push({ a: c, sideA: e, b: d, sideB: f });
      });
    }
  });
  for (const list of onSide) list.sort((x, y) => Math.min(x.from, x.to) - Math.min(y.from, y.to));
  layouts.set(key, (layout = { onSide, inner }));
  return layout;
}

/**
 * Leaf adjacency and side contacts of a tree, from its structure: every node lists the leaves along
 * each of its sides in order (a leaf: itself, end to end). A split concatenates its children's lists
 * onto its own sides and matches the lists of child sides that meet inside it, so two leaves touch
 * exactly when their stretches of a shared side overlap. Exact (all positions are dyadic) and linear
 * in the tree's size.
 */
export function buildPieces(root: TreeNode): TreePieces {
  const leaves = treeLeaves(root);
  const count = leaves.length;
  const states = new Uint16Array(count), centroids = new Float32Array(count * 3), areaShare = new Float32Array(count);
  leaves.forEach((l, i) => {
    states[i] = l.state;
    for (let k = 0; k < 3; k++) centroids[i * 3 + k] = (l.tri[0][k] + l.tri[1][k] + l.tri[2][k]) / 3;
    const [a, b, c] = l.tri;
    areaShare[i] = Math.abs((b[1] - a[1]) * (c[2] - a[2]) - (c[1] - a[1]) * (b[2] - a[2])); // the root has area 1/2 in this plane
  });

  // A side list: leaf, from, to triples, ordered along the side.
  type SideList = number[];
  const pairs: number[] = [];
  let nextLeaf = 0;
  const walk = (n: TreeNode): [SideList, SideList, SideList] => {
    if (isLeaf(n)) {
      const i = nextLeaf++;
      return [[i, 0, 1], [i, 0, 1], [i, 0, 1]];
    }
    const kids = n.children.map(walk);
    const layout = layoutOf(n.splitSides, n.special);
    for (const { a, sideA, b, sideB } of layout.inner) {
      // B runs the shared side the other way: s -> 1 - s, read backwards.
      const la = kids[a][sideA], lb = kids[b][sideB];
      let i = 0, j = lb.length - 3;
      while (i < la.length && j >= 0) {
        const aFrom = la[i + 1], aTo = la[i + 2], bFrom = 1 - lb[j + 2], bTo = 1 - lb[j + 1];
        if (Math.min(aTo, bTo) - Math.max(aFrom, bFrom) > EPS) pairs.push(la[i], lb[j]);
        if (aTo < bTo) i += 3; else j -= 3;
      }
    }
    return layout.onSide.map((segments) => {
      const out: SideList = [];
      for (const { child, side, from, to } of segments) {
        const list = kids[child][side], span = to - from;
        if (span > 0) for (let i = 0; i < list.length; i += 3) out.push(list[i], from + span * list[i + 1], from + span * list[i + 2]);
        else for (let i = list.length - 3; i >= 0; i -= 3) out.push(list[i], from + span * list[i + 2], from + span * list[i + 1]);
      }
      return out;
    }) as [SideList, SideList, SideList];
  };
  const rootSides = isLeaf(root) ? [[0, 0, 1], [0, 0, 1], [0, 0, 1]] : walk(root);

  // Adjacency as CSR (each pair once per direction; a pair can only meet along one stretch).
  const degree = new Uint32Array(count + 1);
  for (let k = 0; k < pairs.length; k += 2) { degree[pairs[k] + 1]++; degree[pairs[k + 1] + 1]++; }
  for (let i = 0; i < count; i++) degree[i + 1] += degree[i];
  const adjacentStart = degree.slice();
  const adjacent = new Uint32Array(pairs.length);
  const fill = degree.slice(0, count);
  for (let k = 0; k < pairs.length; k += 2) {
    adjacent[fill[pairs[k]]++] = pairs[k + 1];
    adjacent[fill[pairs[k + 1]]++] = pairs[k];
  }

  // Contacts with the root's sides, by side (already ordered along it) and by leaf.
  const contacts = (rootSides[0].length + rootSides[1].length + rootSides[2].length) / 3;
  const bySideStart = new Uint32Array(4), bySideLeaf = new Uint32Array(contacts), bySideFrom = new Float64Array(contacts), bySideTo = new Float64Array(contacts);
  const contactStart = new Uint32Array(count + 1);
  let at = 0;
  for (let s = 0; s < 3; s++) {
    const list = rootSides[s];
    for (let i = 0; i < list.length; i += 3, at++) {
      bySideLeaf[at] = list[i]; bySideFrom[at] = list[i + 1]; bySideTo[at] = list[i + 2];
      contactStart[list[i] + 1]++;
    }
    bySideStart[s + 1] = at;
  }
  for (let i = 0; i < count; i++) contactStart[i + 1] += contactStart[i];
  const side = new Uint8Array(contacts), from = new Float64Array(contacts), to = new Float64Array(contacts);
  const next = contactStart.slice(0, count);
  for (let s = 0; s < 3; s++) {
    for (let c = bySideStart[s]; c < bySideStart[s + 1]; c++) {
      const k = next[bySideLeaf[c]]++;
      side[k] = s; from[k] = bySideFrom[c]; to[k] = bySideTo[c];
    }
  }
  return { count, states, centroids, areaShare, adjacentStart, adjacent, contactStart, side, from, to, bySideStart, bySideLeaf, bySideFrom, bySideTo };
}

const EPS = 1e-12;

export const EMPTY_REGION: Region = { tris: new Uint32Array(0), pieces: new Map() };

/** How many triangles a region touches: its whole triangles and the split ones it paints pieces of. */
export function regionSize(region: Region): number {
  return region.tris.length + region.pieces.size;
}

/**
 * The fill surface of one object for one computation: the topology, the displayed states and the
 * object's trees. Expands split triangles into pieces as the flood reaches them.
 */
export class PieceGraph {
  readonly triCount: number;
  readonly topology: MeshTopology;
  private readonly painted: Readonly<Uint16Array>;
  private readonly triPart: Uint32Array;
  private readonly baseOfPart: ArrayLike<number>;
  private readonly trees: ReadonlyMap<number, string>;
  /** False when the object has no trees: the graph is then the triangle graph, on a fast path. */
  readonly hasTrees: boolean;
  private readonly normals: Float32Array;
  private readonly edges: Int32Array;
  private readonly duplicateOf: Int32Array | null;
  /** First piece node of an expanded split triangle. */
  private readonly firstNode = new Map<number, number>();
  private readonly expanded: { tri: number; first: number; pieces: TreePieces }[] = [];
  /** Which side of the neighbor a triangle side is, by `3 * tri + side`: `side * 2 + reversed`, -1 when none matches. */
  private readonly sharedCache = new Map<number, number>();
  private pieceTri = new Int32Array(64);
  private pieceLeaf = new Int32Array(64);
  private pieceOwner = new Int32Array(64); // index into `expanded`
  private pieceCount = 0;

  constructor(topology: MeshTopology, display: DisplayView, trees: ReadonlyMap<number, string>) {
    this.topology = topology;
    this.triCount = topology.triCount;
    this.painted = display.painted;
    this.triPart = display.triPart;
    this.baseOfPart = display.baseOfPart;
    this.trees = trees;
    this.hasTrees = trees.size > 0;
    this.normals = topology.faceNormals();
    this.edges = topology.neighbors;
    this.duplicateOf = topology.duplicateOf;
  }

  /** Node ids handed out so far (triangles plus expanded pieces). */
  get nodeCount(): number {
    return this.triCount + this.pieceCount;
  }

  /** True if the triangle is split (it is then never a node itself; its pieces are). */
  isSplit(tri: number): boolean {
    return this.hasTrees && this.trees.has(tri);
  }

  /** The node a fill starts at: the triangle, or its piece at the seed's point (the centroid without one); -1 if not paintable. */
  nodeOf(seed: Seed): number {
    const t = seed.tri;
    if (!Number.isInteger(t) || t < 0 || t >= this.triCount || this.topology.shellOfTri[t] < 0) return -1;
    if (!this.isSplit(t)) return t;
    const p: Bary = seed.bary ? [seed.bary[0], seed.bary[1], seed.bary[2]] : [1 / 3, 1 / 3, 1 / 3];
    return this.expand(t) + leafIndexAt(parseTree(this.trees.get(t)!), p);
  }

  triOf(node: number): number {
    return node < this.triCount ? node : this.pieceTri[node - this.triCount];
  }

  /** The state the node shows: its paint, or its part's base when unpainted. */
  stateOf(node: number): number {
    if (node < this.triCount) {
      const s = this.painted[node];
      return s > 0 ? s : this.baseOfPart[this.triPart[node]];
    }
    const i = node - this.triCount;
    const s = this.expanded[this.pieceOwner[i]].pieces.states[this.pieceLeaf[i]];
    return s > 0 ? s : this.baseOfPart[this.triPart[this.pieceTri[i]]];
  }

  /** Area in object units². */
  area(node: number): number {
    const t = this.triOf(node);
    const whole = triangleArea(this.topology, t);
    if (node < this.triCount) return whole;
    const i = node - this.triCount;
    return whole * this.expanded[this.pieceOwner[i]].pieces.areaShare[this.pieceLeaf[i]];
  }

  /** Writes the node's centroid (object space) to `out`. */
  centroid(node: number, out: Float64Array): void {
    const t = this.triOf(node);
    const { vertices, tris } = this.topology.mesh;
    let w0 = 1 / 3, w1 = 1 / 3, w2 = 1 / 3;
    if (node >= this.triCount) {
      const i = node - this.triCount;
      const c = this.expanded[this.pieceOwner[i]].pieces.centroids, o = this.pieceLeaf[i] * 3;
      w0 = c[o]; w1 = c[o + 1]; w2 = c[o + 2];
    }
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, cc = tris[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) out[k] = vertices[a + k] * w0 + vertices[b + k] * w1 + vertices[cc + k] * w2;
  }

  /** The triangle whose face (and edges) a node uses: a duplicate face uses its twin's. */
  faceOf(node: number): number {
    if (node >= this.triCount) return this.pieceTri[node - this.triCount];
    const dup = this.duplicateOf;
    return dup && dup[node] >= 0 ? dup[node] : node;
  }

  /**
   * Fills `out` with the node's neighbors. Across an edge a split neighbor stands for its pieces on
   * the matching stretch; at a non-manifold edge the flattest face stands for the edge, as in
   * `edgeNeighbors`. Inside a split triangle the code is -1 (the same plane).
   */
  neighbors(node: number, out: NodeBuffer): number {
    out.length = 0;
    if (node < this.triCount) {
      const dup = this.duplicateOf;
      const src = dup && dup[node] >= 0 ? dup[node] : node;
      const edges = this.edges;
      if (!this.hasTrees) { // the triangle graph: at most 3 neighbors, written straight in (the buffer holds 16)
        let n = 0;
        for (let k = 0; k < 3; k++) {
          let code = edges[src * 3 + k];
          if (code === NEIGHBOR_NON_MANIFOLD) code = this.edgeCode(src, k);
          if (code < 0) continue;
          out.nodes[n] = code >> 1;
          out.codes[n++] = code;
        }
        return (out.length = n);
      }
      for (let k = 0; k < 3; k++) {
        let code = edges[src * 3 + k];
        if (code === NEIGHBOR_NON_MANIFOLD) code = this.edgeCode(src, k);
        if (code < 0) continue;
        if (this.trees.has(code >> 1)) this.across(src, k, code, 0, 1, out);
        else out.push(code >> 1, code);
      }
      return out.length;
    }
    const i = node - this.triCount;
    const owner = this.expanded[this.pieceOwner[i]];
    const { pieces } = owner;
    const leaf = this.pieceLeaf[i];
    const first = owner.first;
    for (let a = pieces.adjacentStart[leaf]; a < pieces.adjacentStart[leaf + 1]; a++) out.push(first + pieces.adjacent[a], -1);
    for (let c = pieces.contactStart[leaf]; c < pieces.contactStart[leaf + 1]; c++) {
      const k = pieces.side[c];
      const code = this.edgeCode(owner.tri, k);
      if (code >= 0) this.across(owner.tri, k, code, pieces.from[c], pieces.to[c], out);
    }
    return out.length;
  }

  /** The fill's region: whole triangles (in the nodes' order) and the pieces of split ones. */
  toRegion(nodes: Uint32Array): Region {
    if (this.pieceCount === 0) return { tris: nodes, pieces: new Map() };
    let whole = 0;
    for (let k = 0; k < nodes.length; k++) if (nodes[k] < this.triCount) whole++;
    const tris = new Uint32Array(whole);
    const pieces = new Map<number, number[]>();
    let at = 0;
    for (let k = 0; k < nodes.length; k++) {
      const node = nodes[k];
      if (node < this.triCount) { tris[at++] = node; continue; }
      const i = node - this.triCount;
      const tri = this.pieceTri[i];
      let list = pieces.get(tri);
      if (!list) pieces.set(tri, (list = []));
      list.push(this.pieceLeaf[i]);
    }
    const out = new Map<number, Uint32Array>();
    for (const [tri, list] of pieces) out.set(tri, Uint32Array.from(list).sort());
    return { tris, pieces: out };
  }

  /** The neighbor code of side k of triangle t, -1 for none (a non-manifold edge picks its flattest face). */
  private edgeCode(t: number, k: number): number {
    const code = this.edges[t * 3 + k];
    if (code !== NEIGHBOR_NON_MANIFOLD) return code;
    const links = this.topology.nonManifoldLinks?.get(t * 3 + k);
    if (!links) return -1;
    const n = this.normals;
    let best = -Infinity, bestCode = -1;
    for (const link of links) {
      const u = neighborTri(link);
      let dot = n[t * 3] * n[u * 3] + n[t * 3 + 1] * n[u * 3 + 1] + n[t * 3 + 2] * n[u * 3 + 2];
      if (neighborFlipped(link)) dot = -dot;
      if (dot > best) { best = dot; bestCode = link; }
    }
    return bestCode;
  }

  /** Pushes what lies across side k of t on the stretch from..to: the neighbor, or its pieces there. */
  private across(t: number, k: number, code: number, from: number, to: number, out: NodeBuffer): void {
    const u = neighborTri(code);
    if (!this.isSplit(u)) { out.push(u, code); return; }
    const first = this.expand(u);
    const pieces = this.expanded[this.pieceOwner[first - this.triCount]].pieces;
    const shared = this.sharedSideCached(t, k, u);
    if (!shared) { // no side matches exactly: every piece on a side stands in
      for (let leaf = 0; leaf < pieces.count; leaf++) if (pieces.contactStart[leaf + 1] > pieces.contactStart[leaf]) out.push(first + leaf, code);
      return;
    }
    const lo = shared.reversed ? 1 - to : from, hi = shared.reversed ? 1 - from : to;
    const { bySideStart, bySideLeaf, bySideFrom, bySideTo } = pieces;
    for (let c = bySideStart[shared.side]; c < bySideStart[shared.side + 1]; c++) {
      if (bySideFrom[c] >= hi - EPS) break; // sorted by where they start
      if (Math.min(hi, bySideTo[c]) - Math.max(lo, bySideFrom[c]) > EPS) out.push(first + bySideLeaf[c], code);
    }
  }

  /** Which side of u is side k of t, and whether u runs it the other way; null if no side matches (welded corners that differ). */
  private sharedSideCached(t: number, k: number, u: number): { side: number; reversed: boolean } | null {
    let code = this.sharedCache.get(t * 3 + k);
    if (code === undefined) {
      const found = this.sharedSide(t, k, u);
      this.sharedCache.set(t * 3 + k, (code = found ? found.side * 2 + (found.reversed ? 1 : 0) : -1));
    }
    return code < 0 ? null : { side: code >> 1, reversed: (code & 1) === 1 };
  }

  private sharedSide(t: number, k: number, u: number): { side: number; reversed: boolean } | null {
    const { vertices, tris } = this.topology.mesh;
    const same = (a: number, b: number) => a === b || (vertices[a * 3] === vertices[b * 3] && vertices[a * 3 + 1] === vertices[b * 3 + 1] && vertices[a * 3 + 2] === vertices[b * 3 + 2]);
    const p = tris[t * 3 + k], q = tris[t * 3 + (k + 1) % 3];
    for (let s = 0; s < 3; s++) {
      const a = tris[u * 3 + s], b = tris[u * 3 + (s + 1) % 3];
      if (same(a, p) && same(b, q)) return { side: s, reversed: false };
      if (same(a, q) && same(b, p)) return { side: s, reversed: true };
    }
    return null;
  }

  /** Assigns node ids to a split triangle's pieces (once); returns the first. */
  private expand(tri: number): number {
    const known = this.firstNode.get(tri);
    if (known !== undefined) return known;
    const pieces = piecesOf(this.topology, tri, this.trees.get(tri)!);
    const owner = this.expanded.length;
    this.expanded.push({ tri, first: this.triCount + this.pieceCount, pieces });
    const first = this.triCount + this.pieceCount;
    if (this.pieceCount + pieces.count > this.pieceTri.length) {
      let size = this.pieceTri.length;
      while (size < this.pieceCount + pieces.count) size *= 2;
      for (const key of ["pieceTri", "pieceLeaf", "pieceOwner"] as const) {
        const bigger = new Int32Array(size);
        bigger.set(this[key]);
        this[key] = bigger;
      }
    }
    for (let i = 0; i < pieces.count; i++) {
      this.pieceTri[this.pieceCount] = tri;
      this.pieceLeaf[this.pieceCount] = i;
      this.pieceOwner[this.pieceCount++] = owner;
    }
    this.firstNode.set(tri, first);
    return first;
  }
}

function triangleArea(topology: MeshTopology, t: number): number {
  const { vertices, tris } = topology.mesh;
  const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
  const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
  const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}
