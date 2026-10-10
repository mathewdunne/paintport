// Region algorithms for the fill tools: pure functions over a MeshTopology, or over a PieceGraph
// where split triangles stand for their pieces (spec Q12.3), that return what to paint. Tools
// paint the result with Project.paintRegion; the hover preview calls the same functions
// without painting.
import { featureBend } from "./featureField";
import { neighborFlipped, neighborTri, type MeshTopology } from "./meshTopology";
import { NodeBuffer, PieceGraph } from "./pieces";

/** What a triangle currently shows: its paint, or its part's base color if unpainted. */
export interface DisplayView {
  /** Stored state per triangle (0 = unpainted). */
  painted: Readonly<Uint16Array>;
  triPart: Uint32Array;
  /** Base state per part index. */
  baseOfPart: ArrayLike<number>;
}

const NONE = new Uint32Array(0);

/**
 * All paintable triangles connected to `seed` through shared edges (including through
 * non-manifold edges, see MeshTopology). Ascending triangle order. Empty when `seed` is
 * not a paintable triangle. Independent of the current paint.
 */
export function shellFill(topology: MeshTopology, seed: number): Uint32Array {
  const shell = topology.shellOfTri[seed];
  if (shell === undefined || shell < 0) return NONE;
  return topology.shellTris.slice(topology.shellStart[shell], topology.shellStart[shell + 1]);
}

/** Visit stamps and the flood queue per topology, reused between calls; they grow as pieces add nodes. */
interface Scratch {
  stamp: Uint32Array;
  queue: Uint32Array;
  epoch: number;
}
const scratchOf = new WeakMap<MeshTopology, Scratch>();

function scratch(topology: MeshTopology): Scratch {
  let sc = scratchOf.get(topology);
  if (!sc) scratchOf.set(topology, (sc = { stamp: new Uint32Array(topology.triCount), queue: new Uint32Array(topology.triCount), epoch: 0 }));
  if (++sc.epoch === 0xffffffff) { sc.stamp.fill(0); sc.epoch = 1; }
  return sc;
}

/** Makes room for node ids below `size`, keeping what the flood has marked so far. */
function grow(sc: Scratch, size: number): void {
  if (size <= sc.stamp.length) return;
  let n = Math.max(16, sc.stamp.length);
  while (n < size) n *= 2;
  const stamp = new Uint32Array(n), queue = new Uint32Array(n);
  stamp.set(sc.stamp);
  queue.set(sc.queue);
  sc.stamp = stamp;
  sc.queue = queue;
}

const NO_TREES: ReadonlyMap<number, string> = new Map();

/** The fill surface of a mesh without sub-triangle trees (the node ids are the triangles). */
export function triangleGraph(topology: MeshTopology, display: DisplayView): PieceGraph {
  return new PieceGraph(topology, display, NO_TREES);
}

/**
 * Smart fill: flood from `seed` across edges whose dihedral angle (the angle between the
 * two face normals) is at most `angleDeg`, and only into neighbors that currently show the
 * same state as the seed, so existing paint boundaries stop it.
 *
 * - Boundary edges never spread. At a non-manifold edge the flood continues into the face
 *   with the smallest dihedral angle (if that passes the same tests), not into all of them.
 * - Duplicate faces travel with their twin: reaching one reaches the others that show the
 *   same state.
 * - Triangles without a usable normal (zero area) do not block the flood.
 * - A non-finite angle counts as 0; angles are clamped to 0..180.
 * - The seed is always included; empty when it is not paintable.
 *
 * On a mesh without trees; see `smartFillNodes` for the pieces of split triangles.
 */
export function smartFill(topology: MeshTopology, seed: number, angleDeg: number, display: DisplayView): Uint32Array {
  const graph = triangleGraph(topology, display);
  return smartFillNodes(graph, graph.nodeOf({ tri: seed }), angleDeg);
}

/**
 * `smartFill` over a `PieceGraph`: the flood moves piece by piece through split triangles (pieces
 * of one triangle lie in one plane), so other colors stop it exactly where they are painted.
 * Returns node ids (see `PieceGraph.toRegion`); empty for a seed of -1.
 *
 * Cost is proportional to the filled region (the visited stamps are reused between calls).
 */
export function smartFillNodes(graph: PieceGraph, seed: number, angleDeg: number): Uint32Array {
  if (seed < 0) return NONE;
  const topology = graph.topology;
  const normals = topology.faceNormals();
  const { duplicateGroups } = topology;
  const angle = Number.isFinite(angleDeg) ? Math.min(180, Math.max(0, angleDeg)) : 0;
  const cosThreshold = Math.cos((angle * Math.PI) / 180) - 1e-6; // slack for float32 normals at 0 degrees

  const sc = scratch(topology);
  grow(sc, graph.nodeCount);
  const epoch = sc.epoch;
  let { stamp, queue } = sc; // replaced when pieces outgrow them
  const refresh = () => {
    grow(sc, graph.nodeCount);
    stamp = sc.stamp;
    queue = sc.queue;
  };
  const seedState = graph.stateOf(seed);
  const buf = new NodeBuffer();
  let head = 0, tail = 0;
  const visit = (u: number): void => {
    if (u >= stamp.length) refresh();
    stamp[u] = epoch;
    queue[tail++] = u;
  };

  /** Cosine of the angle between the faces, honoring winding; 1 when either has no normal. */
  const cosBetween = (src: number, u: number, flipped: boolean): number => {
    const nx = normals[src * 3], ny = normals[src * 3 + 1], nz = normals[src * 3 + 2];
    const mx = normals[u * 3], my = normals[u * 3 + 1], mz = normals[u * 3 + 2];
    if ((nx === 0 && ny === 0 && nz === 0) || (mx === 0 && my === 0 && mz === 0)) return 1;
    const dot = nx * mx + ny * my + nz * mz;
    return flipped ? -dot : dot;
  };

  visit(seed);
  while (head < tail) {
    const t = queue[head++];
    if (duplicateGroups && t < graph.triCount) {
      const group = duplicateGroups.get(t);
      if (group) for (const m of group) if (!graph.isSplit(m) && stamp[m] !== epoch && graph.stateOf(m) === seedState) visit(m);
    }
    const src = graph.faceOf(t);
    const count = graph.neighbors(t, buf);
    if (graph.hasTrees && graph.nodeCount > stamp.length) refresh();
    const nodes = buf.nodes, codes = buf.codes;
    for (let i = 0; i < count; i++) {
      const u = nodes[i], code = codes[i];
      if (stamp[u] === epoch || graph.stateOf(u) !== seedState) continue;
      if (code < 0 || cosBetween(src, neighborTri(code), neighborFlipped(code)) >= cosThreshold) visit(u);
    }
  }
  return queue.slice(0, tail);
}

interface HoleScratch {
  /** Call number per node known to lie outside any small hole (its component was too big). */
  outside: Uint32Array;
  call: number;
  /** Search id per node visited by the current hole search. */
  seen: Uint32Array;
  search: number;
  list: Uint32Array;
}
const holeScratchOf = new WeakMap<MeshTopology, HoleScratch>();

function growHoles(hs: HoleScratch, size: number): void {
  if (size <= hs.seen.length) return;
  let n = Math.max(16, hs.seen.length);
  while (n < size) n *= 2;
  for (const key of ["outside", "seen", "list"] as const) {
    const bigger = new Uint32Array(n);
    bigger.set(hs[key]);
    hs[key] = bigger;
  }
}

/**
 * Adds to a region the holes it surrounds: connected groups of nodes for which `candidate`
 * holds, smaller than `maxArea` in total, that touch the region and nothing else a search can
 * leave through (every other node is a wall). `region` holds the region's nodes in its first
 * `size` entries; `add` is called for each node of each hole. A search from the region's edge
 * gives up as soon as it is too big or reaches a node an earlier search found to be open.
 */
export function fillSmallHoles(
  graph: PieceGraph, region: ArrayLike<number>, size: number, maxArea: number,
  candidate: (t: number) => boolean, add: (t: number) => void,
): void {
  const topology = graph.topology;
  let hs = holeScratchOf.get(topology);
  const n = topology.triCount;
  if (!hs) holeScratchOf.set(topology, (hs = { outside: new Uint32Array(n), call: 0, seen: new Uint32Array(n), search: 0, list: new Uint32Array(n) }));
  growHoles(hs, graph.nodeCount);
  if (hs.search > 0xfffffff0) { hs.seen.fill(0); hs.search = 0; }
  if (++hs.call === 0xffffffff) { hs.outside.fill(0); hs.call = 1; }
  const call = hs.call;
  const edge = new NodeBuffer(), inner = new NodeBuffer();
  for (let i = 0; i < size; i++) {
    const count = graph.neighbors(region[i], edge);
    growHoles(hs, graph.nodeCount);
    for (let k = 0; k < count; k++) {
      const start = edge.nodes[k];
      if (hs.outside[start] === call || !candidate(start)) continue;
      const id = ++hs.search;
      let found = 0, area = 0, closed = true;
      hs.seen[start] = id;
      hs.list[found++] = start;
      for (let head = 0; head < found && closed; head++) {
        const t = hs.list[head];
        area += graph.area(t);
        if (area > maxArea) { closed = false; break; }
        const c = graph.neighbors(t, inner);
        growHoles(hs, graph.nodeCount);
        for (let j = 0; j < c; j++) {
          const u = inner.nodes[j];
          if (hs.seen[u] === id || !candidate(u)) continue;
          if (hs.outside[u] === call) { closed = false; break; }
          hs.seen[u] = id;
          hs.list[found++] = u;
        }
      }
      if (closed) for (let j = 0; j < found; j++) add(hs.list[j]);
      else for (let j = 0; j < found; j++) hs.outside[hs.list[j]] = call;
    }
  }
}

/**
 * Smart fill at a feature size (`scale` > 0, object units): like `smartFill`, but the bend is
 * measured on the surface smoothed over `scale` (see `featureBend`), so texture smaller than
 * that neither stops the fill nor leaves specks. A crease reads as a band of high bend:
 *
 * 1. The flood spreads through triangles whose bend is below `angleDeg` and that show the
 *    seed's state.
 * 2. From there it climbs into the crease band while the bend keeps rising, so it stops at the
 *    middle of the crease (where a fill from the other side stops too) instead of at its edge.
 * 3. Holes of the seed's state that the region surrounds and that are smaller than a disc of
 *    radius `scale` are filled: what is left inside after the climb stopped at a crest.
 *
 * Existing paint stops it as in `smartFill`. The seed is always included. On a mesh whose
 * triangles are about as big as `scale` or bigger there is nothing to smooth: this is then
 * `smartFill`. On a mesh without trees; see `featureFillNodes`.
 */
export function featureFill(topology: MeshTopology, seed: number, angleDeg: number, scale: number, display: DisplayView): Uint32Array {
  const graph = triangleGraph(topology, display);
  return featureFillNodes(graph, graph.nodeOf({ tri: seed }), angleDeg, scale);
}

/** `featureFill` over a `PieceGraph` (pieces take their triangle's bend). Returns node ids. */
export function featureFillNodes(graph: PieceGraph, seed: number, angleDeg: number, scale: number): Uint32Array {
  if (seed < 0) return NONE;
  const topology = graph.topology;
  const bend = featureBend(topology, scale);
  if (!bend) return smartFillNodes(graph, seed, angleDeg);
  const { duplicateGroups } = topology;
  const angle = Number.isFinite(angleDeg) ? Math.min(180, Math.max(0, angleDeg)) : 0;
  const limit = (angle * Math.PI) / 180;

  const sc = scratch(topology);
  grow(sc, graph.nodeCount);
  const epoch = sc.epoch;
  const seedState = graph.stateOf(seed);
  const buf = new NodeBuffer();
  let tail = 0;
  const visit = (u: number): void => {
    if (u >= sc.stamp.length) grow(sc, graph.nodeCount);
    sc.stamp[u] = epoch;
    sc.queue[tail++] = u;
  };
  const visitTwins = (t: number): void => {
    if (t >= graph.triCount) return;
    const group = duplicateGroups?.get(t);
    if (group) for (const m of group) if (!graph.isSplit(m) && sc.stamp[m] !== epoch && graph.stateOf(m) === seedState) visit(m);
  };

  // 1 + 2: flood below the limit, climb into creases while the bend rises.
  visit(seed);
  for (let head = 0; head < tail; head++) {
    const t = sc.queue[head];
    visitTwins(t);
    const own = bend[graph.faceOf(t)];
    const count = graph.neighbors(t, buf);
    grow(sc, graph.nodeCount);
    for (let k = 0; k < count; k++) {
      const u = buf.nodes[k];
      if (sc.stamp[u] === epoch || graph.stateOf(u) !== seedState) continue;
      const theirs = bend[graph.triOf(u)];
      if (theirs < limit ? own < limit : theirs >= own) visit(u);
    }
  }

  // 3: small holes.
  const filled = tail;
  fillSmallHoles(graph, sc.queue.slice(0, filled), filled, Math.PI * scale * scale,
    (t) => (t >= sc.stamp.length || sc.stamp[t] !== epoch) && graph.stateOf(t) === seedState, visit);
  for (let i = filled, end = tail; i < end; i++) visitTwins(sc.queue[i]);
  return sc.queue.slice(0, tail);
}
