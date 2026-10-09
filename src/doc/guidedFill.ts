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
import { featureBend, edgeNeighbors } from "./featureField";
import { featureFill, fillSmallHoles, smartFill, type DisplayView } from "./fill";
import { neighborFlipped, neighborTri, type MeshTopology } from "./meshTopology";

/** Bends below this share of the edge angle cost nothing extra; above it the weight rises quadratically. */
const FREE_SHARE = 0.5;
/** Step weight at the edge angle (the weight keeps rising beyond it). */
const CREASE_WEIGHT = 50;

const NONE = new Uint32Array(0);
const INSIDE = 1, OUTSIDE = 2;

const paintable = (topology: MeshTopology, t: number) => Number.isInteger(t) && t >= 0 && t < topology.triCount && topology.shellOfTri[t] >= 0;

/**
 * The triangles a guided fill paints: grown from the `inside` triangles, kept away from what
 * the `outside` triangles reach first (see the file comment). `angleDeg` and `scale` are the
 * smart fill settings (`scale` in object units, 0 = edge by edge). Existing paint stops both
 * floods. Empty without a paintable inside triangle. Does not paint.
 */
export function guidedFill(
  topology: MeshTopology, inside: readonly number[], outside: readonly number[], angleDeg: number, scale: number, display: DisplayView,
): Uint32Array {
  const seeds = inside.filter((t) => paintable(topology, t));
  if (seeds.length === 0) return NONE;
  const bend = scale > 0 ? featureBend(topology, scale) : null;
  const n = topology.triCount;
  const outs = outside.filter((t) => paintable(topology, t));
  if (outs.length === 0) return unionOfFills(topology, seeds, angleDeg, scale, display);

  const normals = topology.faceNormals();
  const { duplicateOf, duplicateGroups } = topology;
  const { painted, triPart, baseOfPart } = display;
  const stateOf = (t: number): number => (painted[t] > 0 ? painted[t] : baseOfPart[triPart[t]]);
  const srcOf = (t: number) => (duplicateOf && duplicateOf[t] >= 0 ? duplicateOf[t] : t);
  const angle = Number.isFinite(angleDeg) ? Math.min(180, Math.max(0, angleDeg)) : 0;
  const limit = (angle * Math.PI) / 180;
  const free = limit * FREE_SHARE;
  const weightOf = (crease: number) => {
    const over = limit > free ? Math.max(0, (crease - free) / (limit - free)) : crease > limit ? 1 : 0;
    return 1 + (CREASE_WEIGHT - 1) * over * over;
  };
  const { vertices, tris } = topology.mesh;
  const centroid = (t: number, i: number) => (vertices[tris[t * 3] * 3 + i] + vertices[tris[t * 3 + 1] * 3 + i] + vertices[tris[t * 3 + 2] * 3 + i]) / 3;
  const stepLength = (t: number, u: number) =>
    Math.hypot(centroid(t, 0) - centroid(u, 0), centroid(t, 1) - centroid(u, 1), centroid(t, 2) - centroid(u, 2));
  /** The crease between `src` and its neighbor: the neighbor's bend, or (edge by edge) the angle between the faces. */
  const creaseTo = (src: number, code: number): number => {
    const u = neighborTri(code);
    if (bend) return bend[u];
    let dot = normals[src * 3] * normals[u * 3] + normals[src * 3 + 1] * normals[u * 3 + 1] + normals[src * 3 + 2] * normals[u * 3 + 2];
    if (neighborFlipped(code)) dot = -dot;
    const zero = normals[src * 3] === 0 && normals[src * 3 + 1] === 0 && normals[src * 3 + 2] === 0;
    return zero || (normals[u * 3] === 0 && normals[u * 3 + 1] === 0 && normals[u * 3 + 2] === 0) ? 0 : Math.acos(Math.max(-1, Math.min(1, dot)));
  };
  /** Whether the inside flood may step from `src` across `code`, as smart fill would. */
  const insideMay = (src: number, code: number, crease: number): boolean => {
    if (!bend) return crease <= limit + 1e-6;
    const u = neighborTri(code);
    return bend[u] < limit ? bend[src] < limit : bend[u] >= bend[src];
  };

  // Dijkstra over both floods at once; a triangle is labeled when it is first taken off the heap.
  const heap = new CostHeap();
  const label = new Uint8Array(n);
  let pendingInside = 0;
  const push = (cost: number, t: number, lab: number) => {
    heap.push(cost, t * 4 + lab);
    if (lab === INSIDE) pendingInside++;
  };
  for (const t of seeds) push(0, t, INSIDE);
  for (const t of outs) push(0, t, OUTSIDE);
  const buf = new Int32Array(3);
  while (pendingInside > 0 && heap.size > 0) {
    const cost = heap.topCost();
    const entry = heap.pop();
    const t = Math.floor(entry / 4), lab = entry % 4;
    if (lab === INSIDE) pendingInside--;
    if (label[t] !== 0) continue;
    label[t] = lab;
    const state = stateOf(t);
    const group = duplicateGroups?.get(t);
    if (group) for (const m of group) if (label[m] === 0 && stateOf(m) === state) push(cost, m, lab);
    const src = srcOf(t);
    const count = edgeNeighbors(topology, normals, src, buf);
    for (let k = 0; k < count; k++) {
      const u = neighborTri(buf[k]);
      if (label[u] !== 0 || stateOf(u) !== state) continue;
      const crease = creaseTo(src, buf[k]);
      if (lab === INSIDE && !insideMay(src, buf[k], crease)) continue;
      push(cost + stepLength(src, u) * weightOf(crease), u, lab);
    }
  }

  const region: number[] = [];
  for (let t = 0; t < n; t++) if (label[t] === INSIDE) region.push(t);
  if (bend) {
    // Holes the inside region surrounds, as in smart fill; what the outside flood claimed is a wall.
    const size = region.length;
    const inRegion = new Uint8Array(n);
    for (const t of region) inRegion[t] = 1;
    const seedStates = new Set(seeds.map(stateOf));
    fillSmallHoles(topology, region, size, Math.PI * scale * scale,
      (t) => inRegion[t] === 0 && label[t] !== OUTSIDE && seedStates.has(stateOf(t)),
      (t) => { inRegion[t] = 1; region.push(t); });
  }
  return Uint32Array.from(region);
}

/** The union of the smart fills from each seed, ascending. */
function unionOfFills(topology: MeshTopology, seeds: readonly number[], angleDeg: number, scale: number, display: DisplayView): Uint32Array {
  const taken = new Uint8Array(topology.triCount);
  for (const seed of seeds) {
    if (taken[seed]) continue;
    const part = scale > 0 ? featureFill(topology, seed, angleDeg, scale, display) : smartFill(topology, seed, angleDeg, display);
    for (const t of part) taken[t] = 1;
  }
  const out: number[] = [];
  taken.forEach((v, t) => { if (v) out.push(t); });
  return Uint32Array.from(out);
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
