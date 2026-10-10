// Guided fill: smart fill steered by marks. The user clicks inside the area to paint and
// Shift+clicks where it must not go; the region is recomputed after every mark.
//
// The marks race: one flood grows from the inside marks and one from the outside marks along
// the cheapest paths, and every triangle goes to the flood that reaches it first. A step costs
// its length, weighted by how sharply the surface bends there: about 1 up to half the edge
// angle (surface texture), rising steeply toward the edge angle and beyond. So the floods meet
// on the creases between the marks, and where there is none, halfway between them. The inside
// flood moves like smart fill (same state, below the edge angle or up into a crease band), so
// with no outside marks the region is the union of the smart fills from the inside marks. The
// outside flood may cross anything of its own state: it takes away whatever it reaches first.
// Over a PieceGraph the floods move piece by piece through split triangles (spec Q12.3).
import { featureBend } from "./featureField";
import { featureFillNodes, fillSmallHoles, smartFillNodes, triangleGraph, type DisplayView } from "./fill";
import { neighborFlipped, neighborTri, type MeshTopology } from "./meshTopology";
import { NodeBuffer, type PieceGraph } from "./pieces";

/** Bends below this share of the edge angle cost nothing extra; above it the weight rises quadratically. */
const FREE_SHARE = 0.5;
/** Step weight at the edge angle (the weight keeps rising beyond it). */
const CREASE_WEIGHT = 50;

const NONE = new Uint32Array(0);
const INSIDE = 1, OUTSIDE = 2;

/**
 * The triangles a guided fill paints: grown from the `inside` triangles, kept away from what
 * the `outside` triangles reach first (see the file comment). `angleDeg` and `scale` are the
 * smart fill settings (`scale` in object units, 0 = edge by edge). Existing paint stops both
 * floods. Empty without a paintable inside triangle. Does not paint. On a mesh without trees;
 * see `guidedFillNodes`.
 */
export function guidedFill(
  topology: MeshTopology, inside: readonly number[], outside: readonly number[], angleDeg: number, scale: number, display: DisplayView,
): Uint32Array {
  const graph = triangleGraph(topology, display);
  const nodes = (tris: readonly number[]) => tris.map((tri) => graph.nodeOf({ tri }));
  return guidedFillNodes(graph, nodes(inside), nodes(outside), angleDeg, scale);
}

/** `guidedFill` over a `PieceGraph`: marks are nodes (-1 = not paintable, ignored); returns node ids, ascending. */
export function guidedFillNodes(
  graph: PieceGraph, inside: readonly number[], outside: readonly number[], angleDeg: number, scale: number,
): Uint32Array {
  const seeds = inside.filter((t) => t >= 0);
  if (seeds.length === 0) return NONE;
  const topology = graph.topology;
  const bend = scale > 0 ? featureBend(topology, scale) : null;
  const outs = outside.filter((t) => t >= 0);
  if (outs.length === 0) return unionOfFills(graph, seeds, angleDeg, scale);

  const normals = topology.faceNormals();
  const { duplicateGroups } = topology;
  const angle = Number.isFinite(angleDeg) ? Math.min(180, Math.max(0, angleDeg)) : 0;
  const limit = (angle * Math.PI) / 180;
  const free = limit * FREE_SHARE;
  const weightOf = (crease: number) => {
    const over = limit > free ? Math.max(0, (crease - free) / (limit - free)) : crease > limit ? 1 : 0;
    return 1 + (CREASE_WEIGHT - 1) * over * over;
  };
  const from = new Float64Array(3), to = new Float64Array(3);
  const stepLength = (t: number, u: number) => {
    graph.centroid(t, from);
    graph.centroid(u, to);
    return Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
  };
  /** The crease between face `src` and node `u` across `code`: u's bend, or (edge by edge) the angle between the faces; 0 inside one triangle. */
  const creaseTo = (src: number, u: number, code: number): number => {
    if (bend) return bend[graph.triOf(u)];
    if (code < 0) return 0;
    const v = neighborTri(code);
    let dot = normals[src * 3] * normals[v * 3] + normals[src * 3 + 1] * normals[v * 3 + 1] + normals[src * 3 + 2] * normals[v * 3 + 2];
    if (neighborFlipped(code)) dot = -dot;
    const zero = normals[src * 3] === 0 && normals[src * 3 + 1] === 0 && normals[src * 3 + 2] === 0;
    return zero || (normals[v * 3] === 0 && normals[v * 3 + 1] === 0 && normals[v * 3 + 2] === 0) ? 0 : Math.acos(Math.max(-1, Math.min(1, dot)));
  };
  /** Whether the inside flood may step from face `src` into node `u`, as smart fill would. */
  const insideMay = (src: number, u: number, code: number, crease: number): boolean => {
    if (code < 0) return true; // the same plane
    if (!bend) return crease <= limit + 1e-6;
    const theirs = bend[graph.triOf(u)];
    return theirs < limit ? bend[src] < limit : theirs >= bend[src];
  };

  // Dijkstra over both floods at once; a node is labeled when it is first taken off the heap.
  const heap = new CostHeap();
  let label = new Uint8Array(Math.max(16, graph.nodeCount));
  const ensure = () => {
    if (graph.nodeCount <= label.length) return;
    let n = label.length;
    while (n < graph.nodeCount) n *= 2;
    const bigger = new Uint8Array(n);
    bigger.set(label);
    label = bigger;
  };
  let pendingInside = 0;
  const push = (cost: number, t: number, lab: number) => {
    heap.push(cost, t * 4 + lab);
    if (lab === INSIDE) pendingInside++;
  };
  for (const t of seeds) push(0, t, INSIDE);
  for (const t of outs) push(0, t, OUTSIDE);
  const buf = new NodeBuffer();
  while (pendingInside > 0 && heap.size > 0) {
    const cost = heap.topCost();
    const entry = heap.pop();
    const t = Math.floor(entry / 4), lab = entry % 4;
    if (lab === INSIDE) pendingInside--;
    if (label[t] !== 0) continue;
    label[t] = lab;
    const state = graph.stateOf(t);
    const group = t < graph.triCount ? duplicateGroups?.get(t) : undefined;
    if (group) for (const m of group) if (!graph.isSplit(m) && label[m] === 0 && graph.stateOf(m) === state) push(cost, m, lab);
    const src = graph.faceOf(t);
    const count = graph.neighbors(t, buf);
    ensure();
    for (let k = 0; k < count; k++) {
      const u = buf.nodes[k], code = buf.codes[k];
      if (label[u] !== 0 || graph.stateOf(u) !== state) continue;
      const crease = creaseTo(src, u, code);
      if (lab === INSIDE && !insideMay(src, u, code, crease)) continue;
      push(cost + stepLength(t, u) * weightOf(crease), u, lab);
    }
  }

  const region: number[] = [];
  for (let t = 0; t < graph.nodeCount; t++) if (label[t] === INSIDE) region.push(t);
  if (bend) {
    // Holes the inside region surrounds, as in smart fill; what the outside flood claimed is a wall.
    const size = region.length;
    const added = new Set<number>();
    const seedStates = new Set(seeds.map((s) => graph.stateOf(s)));
    fillSmallHoles(graph, region, size, Math.PI * scale * scale,
      (t) => (t >= label.length || label[t] === 0) && !added.has(t) && seedStates.has(graph.stateOf(t)),
      (t) => { added.add(t); region.push(t); });
  }
  return Uint32Array.from(region);
}

/** The union of the smart fills from each seed, ascending. */
function unionOfFills(graph: PieceGraph, seeds: readonly number[], angleDeg: number, scale: number): Uint32Array {
  const taken = new Set<number>();
  for (const seed of seeds) {
    if (taken.has(seed)) continue;
    const part = scale > 0 ? featureFillNodes(graph, seed, angleDeg, scale) : smartFillNodes(graph, seed, angleDeg);
    for (const t of part) taken.add(t);
  }
  return Uint32Array.from(taken).sort();
}

/** A binary min-heap of (cost, value) pairs in typed arrays; ties come out in insertion order. */
class CostHeap {
  private cost = new Float64Array(1024);
  private value = new Float64Array(1024);
  private order = new Float64Array(1024);
  private count = 0;
  private next = 0;

  get size(): number {
    return this.count;
  }

  topCost(): number {
    return this.cost[0];
  }

  push(cost: number, value: number): void {
    if (this.count === this.cost.length) this.grow();
    let i = this.count++;
    const order = this.next++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(cost, order, this.cost[parent], this.order[parent])) break;
      this.cost[i] = this.cost[parent]; this.value[i] = this.value[parent]; this.order[i] = this.order[parent];
      i = parent;
    }
    this.cost[i] = cost; this.value[i] = value; this.order[i] = order;
  }

  pop(): number {
    const top = this.value[0];
    const last = --this.count;
    const cost = this.cost[last], value = this.value[last], order = this.order[last];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= last) break;
      if (child + 1 < last && this.before(this.cost[child + 1], this.order[child + 1], this.cost[child], this.order[child])) child++;
      if (!this.before(this.cost[child], this.order[child], cost, order)) break;
      this.cost[i] = this.cost[child]; this.value[i] = this.value[child]; this.order[i] = this.order[child];
      i = child;
    }
    this.cost[i] = cost; this.value[i] = value; this.order[i] = order;
    return top;
  }

  private before(costA: number, orderA: number, costB: number, orderB: number): boolean {
    return costA < costB || (costA === costB && orderA < orderB);
  }

  private grow(): void {
    const size = this.cost.length * 2;
    for (const key of ["cost", "value", "order"] as const) {
      const bigger = new Float64Array(size);
      bigger.set(this[key]);
      this[key] = bigger;
    }
  }
}
