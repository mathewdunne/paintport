import { VertexWelder } from "../formats/weld";
import type { EditableMesh } from "./paintField";

/** `MeshTopology.neighbors` value for a boundary edge (used by one triangle only). */
export const NEIGHBOR_NONE = -1;
/** `MeshTopology.neighbors` value for an edge shared by three or more triangles (see `nonManifoldLinks`). */
export const NEIGHBOR_NON_MANIFOLD = -2;

/** Triangle across a neighbor code (>= 0). */
export const neighborTri = (code: number): number => code >> 1;
/** True if the neighbor is wound against its neighbour, so its normal must be flipped to compare. */
export const neighborFlipped = (code: number): boolean => (code & 1) === 1;

export interface TopologyStats {
  /** Edges used by exactly two triangles (duplicate faces not counted). */
  manifoldEdges: number;
  /** Edges used by exactly one triangle. */
  boundaryEdges: number;
  /** Edges used by three or more distinct triangles. */
  nonManifoldEdges: number;
  /** Triangles that repeat another triangle's three vertices (they are linked to it, not to the surface). */
  duplicateFaces: number;
  shells: number;
  /** Vertices merged into another one at identical coordinates (within a part). */
  weldedVertices: number;
}

/** A triangle range that is welded on its own (a part). */
export interface TopologySpan {
  firstTri: number;
  triCount: number;
}

/**
 * Edge adjacency and connected shells of an indexed mesh, restricted to paintable
 * triangles (non-paintable ones are ignored entirely: no neighbors, no shell).
 *
 * Adjacency is computed on welded vertices: within each part (`spans`), vertices at exactly
 * equal coordinates count as one, so a mesh whose triangles carry their own copies of
 * shared corners (triangle soup, or seams duplicated by an exporter) still connects. The
 * mesh itself is not changed, and parts are never welded to each other.
 *
 * Edge cases:
 * - Duplicate faces (a triangle repeating another's three vertices) are not part of the
 *   surface graph: they would turn every edge into a non-manifold one. Each is linked to
 *   its twin instead (`duplicateOf`, `duplicateGroups`): a fill that reaches one reaches
 *   them all, as long as they show the same state.
 * - Non-manifold edges (three or more faces) have no single neighbor, so `neighbors` holds
 *   NEIGHBOR_NON_MANIFOLD there and `nonManifoldLinks` lists the faces on that edge. Smart
 *   fill continues into the one with the smallest dihedral angle; shells connect through them.
 *
 * Geometry never changes in v1, so a topology is built once per object and cached.
 */
export class MeshTopology {
  /**
   * Three codes per triangle; code `3 * t + k` describes the edge from corner k to corner
   * (k + 1) % 3. A code >= 0 is a neighboring triangle (`neighborTri`) with a winding flag
   * (`neighborFlipped`); NEIGHBOR_NONE and NEIGHBOR_NON_MANIFOLD are negative.
   */
  readonly neighbors: Int32Array;
  /** Shell id per triangle, -1 for non-paintable triangles. Ids number shells by their lowest triangle. */
  readonly shellOfTri: Int32Array;
  /** Triangles of shell s are `shellTris[shellStart[s] .. shellStart[s + 1])`, ascending. */
  readonly shellStart: Uint32Array;
  readonly shellTris: Uint32Array;
  /** For a duplicate face, the lowest-numbered triangle with the same vertices; -1 otherwise. Null if there are no duplicates. */
  readonly duplicateOf: Int32Array | null;
  /** Every member of a duplicate group (the twin and its copies) to the whole group, ascending. Null if there are no duplicates. */
  readonly duplicateGroups: Map<number, number[]> | null;
  /** Half-edge slot (`3 * t + k`) of a non-manifold edge to the neighbor codes of the OTHER faces on it. Null if there are none. */
  readonly nonManifoldLinks: Map<number, number[]> | null;
  readonly stats: TopologyStats;
  private normals: Float32Array | null = null;

  constructor(readonly mesh: EditableMesh, paintable: Uint8Array, spans?: readonly TopologySpan[]) {
    const n = mesh.triCount;
    const tris = mesh.tris;
    const slots = n * 3;
    const neighbors = new Int32Array(slots).fill(NEIGHBOR_NONE);
    const stats: TopologyStats = { manifoldEdges: 0, boundaryEdges: 0, nonManifoldEdges: 0, duplicateFaces: 0, shells: 0, weldedVertices: 0 };

    // Welded vertex id per triangle corner. A source vertex is welded once per part (stamped).
    const cornerId = new Int32Array(slots);
    {
      const vertexCount = mesh.vertices.length / 3;
      const stamp = new Int32Array(vertexCount), welded = new Int32Array(vertexCount);
      let nextId = 0;
      (spans ?? [{ firstTri: 0, triCount: n }]).forEach((span, si) => {
        if (paintable[span.firstTri] !== 1) return;
        const welder = new VertexWelder(Math.max(16, span.triCount >> 1));
        let touched = 0;
        for (let t = span.firstTri; t < span.firstTri + span.triCount; t++) {
          if (paintable[t] !== 1) continue;
          for (let k = 0; k < 3; k++) {
            const v = tris[t * 3 + k];
            if (stamp[v] !== si + 1) {
              stamp[v] = si + 1;
              welded[v] = nextId + welder.add(mesh.vertices[v * 3], mesh.vertices[v * 3 + 1], mesh.vertices[v * 3 + 2]);
              touched++;
            }
            cornerId[t * 3 + k] = welded[v];
          }
        }
        nextId += welder.count;
        stats.weldedVertices += touched - welder.count;
      });
    }

    // Edge table: open addressing over the first half-edge seen per undirected edge; the
    // other half-edges of the same edge hang off it in a singly linked chain.
    let size = 16;
    while (size < slots * 1.5) size <<= 1;
    const mask = size - 1;
    const table = new Int32Array(size); // half-edge slot + 1, 0 = empty
    const chain = new Int32Array(slots);
    const nextCorner = (k: number) => (k === 2 ? 0 : k + 1);
    for (let t = 0; t < n; t++) {
      if (paintable[t] !== 1) continue;
      for (let k = 0; k < 3; k++) {
        const s = t * 3 + k;
        const a = cornerId[s], b = cornerId[t * 3 + nextCorner(k)];
        if (a === b) continue; // degenerate edge: stays a boundary
        const lo = a < b ? a : b, hi = a < b ? b : a;
        let h = (Math.imul(lo, 0x9e3779b1) + Math.imul(hi, 0x85ebca6b)) | 0;
        h ^= h >>> 16;
        h = Math.imul(h, 0x7feb352d);
        h = (h ^ (h >>> 15)) & mask;
        for (;;) {
          const e = table[h] - 1;
          if (e < 0) { table[h] = s + 1; chain[s] = -1; break; }
          const te = (e / 3) | 0;
          const ea = cornerId[e], eb = cornerId[te * 3 + nextCorner(e - te * 3)];
          if ((ea === a && eb === b) || (ea === b && eb === a)) { chain[s] = chain[e]; chain[e] = s; break; }
          h = (h + 1) & mask;
        }
      }
    }

    const parent = new Int32Array(n);
    for (let t = 0; t < n; t++) parent[t] = t;
    const find = (x: number): number => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    const union = (x: number, y: number): void => {
      const rx = find(x), ry = find(y);
      if (rx !== ry) { if (rx < ry) parent[ry] = rx; else parent[rx] = ry; } // lowest triangle stays the root
    };

    // Pass 1: duplicate faces. They show up as edges with three or more half-edges whose
    // faces have the same third vertex.
    let duplicateOf: Int32Array | null = null;
    for (let i = 0; i < size; i++) {
      const e = table[i] - 1;
      if (e < 0) continue;
      const o = chain[e];
      if (o < 0 || chain[o] < 0) continue; // at most two faces
      const lowest = new Map<number, number>(); // third vertex -> lowest triangle with it
      for (let s = e; s >= 0; s = chain[s]) {
        const t = (s / 3) | 0, third = cornerId[t * 3 + ((s - t * 3 + 2) % 3)];
        const prev = lowest.get(third);
        if (prev === undefined || t < prev) lowest.set(third, t);
      }
      for (let s = e; s >= 0; s = chain[s]) {
        const t = (s / 3) | 0, rep = lowest.get(cornerId[t * 3 + ((s - t * 3 + 2) % 3)])!;
        if (rep === t) continue;
        duplicateOf ??= new Int32Array(n).fill(-1);
        if (duplicateOf[t] < 0) { duplicateOf[t] = rep; stats.duplicateFaces++; }
      }
    }
    let duplicateGroups: Map<number, number[]> | null = null;
    if (duplicateOf) {
      duplicateGroups = new Map();
      for (let t = 0; t < n; t++) {
        const rep = duplicateOf[t];
        if (rep < 0) continue;
        let group = duplicateGroups.get(rep);
        if (!group) duplicateGroups.set(rep, (group = [rep]));
        group.push(t);
        duplicateGroups.set(t, group);
        union(t, rep);
      }
    }

    // Pass 2: pair up the remaining faces of every edge.
    let nonManifoldLinks: Map<number, number[]> | null = null;
    const buf: number[] = [];
    /** Two faces share the edge: link them (unless it is one triangle glued to itself). */
    const pair = (e: number, o: number): void => {
      const te = (e / 3) | 0, to = (o / 3) | 0;
      if (te === to) { stats.boundaryEdges++; return; } // a triangle glued to itself (degenerate)
      const flip = cornerId[e] === cornerId[o] ? 1 : 0; // same start vertex = same direction = inconsistent winding
      neighbors[e] = (to << 1) | flip;
      neighbors[o] = (te << 1) | flip;
      union(te, to);
      stats.manifoldEdges++;
    };
    for (let i = 0; i < size; i++) {
      const head = table[i] - 1;
      if (head < 0) continue;
      const second = chain[head];
      // Common case (no duplicate faces, at most two faces on the edge) without gathering a list.
      if (!duplicateOf && (second < 0 || chain[second] < 0)) {
        if (second < 0) stats.boundaryEdges++; else pair(head, second);
        continue;
      }
      buf.length = 0;
      for (let s = head; s >= 0; s = chain[s]) if (!duplicateOf || duplicateOf[(s / 3) | 0] < 0) buf.push(s);
      if (buf.length <= 1) { stats.boundaryEdges++; continue; }
      if (buf.length === 2) { pair(buf[0], buf[1]); continue; }
      stats.nonManifoldEdges++;
      nonManifoldLinks ??= new Map();
      for (const s of buf) {
        const ts = (s / 3) | 0;
        neighbors[s] = NEIGHBOR_NON_MANIFOLD;
        const others: number[] = [];
        for (const q of buf) {
          const tq = (q / 3) | 0;
          if (tq === ts) continue;
          others.push((tq << 1) | (cornerId[s] === cornerId[q] ? 1 : 0));
          union(ts, tq);
        }
        nonManifoldLinks.set(s, others);
      }
    }

    // Shell ids and the per-shell triangle lists (counting sort).
    const shellOfTri = new Int32Array(n).fill(-1);
    const idOfRoot = new Int32Array(n).fill(-1);
    let shells = 0, paintableCount = 0;
    for (let t = 0; t < n; t++) {
      if (paintable[t] !== 1) continue;
      const r = find(t);
      let id = idOfRoot[r];
      if (id < 0) idOfRoot[r] = id = shells++;
      shellOfTri[t] = id;
      paintableCount++;
    }
    const shellStart = new Uint32Array(shells + 1);
    for (let t = 0; t < n; t++) if (shellOfTri[t] >= 0) shellStart[shellOfTri[t] + 1]++;
    for (let s = 0; s < shells; s++) shellStart[s + 1] += shellStart[s];
    const shellTris = new Uint32Array(paintableCount);
    const cursor = shellStart.slice(0, shells);
    for (let t = 0; t < n; t++) if (shellOfTri[t] >= 0) shellTris[cursor[shellOfTri[t]]++] = t;
    stats.shells = shells;

    this.neighbors = neighbors;
    this.shellOfTri = shellOfTri;
    this.shellStart = shellStart;
    this.shellTris = shellTris;
    this.duplicateOf = duplicateOf;
    this.duplicateGroups = duplicateGroups;
    this.nonManifoldLinks = nonManifoldLinks;
    this.stats = stats;
  }

  get triCount(): number {
    return this.mesh.triCount;
  }

  /**
   * Unit face normals, 3 floats per triangle (zero for degenerate triangles), computed on
   * first use. The winding decides the sign, so consumers comparing neighbors must honor
   * `neighborFlipped`.
   */
  faceNormals(): Float32Array {
    if (this.normals) return this.normals;
    const { vertices, tris, triCount } = this.mesh;
    const out = new Float32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
      const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
      const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-12) { out[t * 3] = nx / len; out[t * 3 + 1] = ny / len; out[t * 3 + 2] = nz / len; }
    }
    return (this.normals = out);
  }
}

/** Builds the topology of `mesh` over its paintable triangles (`paintable[t] === 1`), welding within each span. */
export function buildTopology(mesh: EditableMesh, paintable: Uint8Array, spans?: readonly TopologySpan[]): MeshTopology {
  return new MeshTopology(mesh, paintable, spans);
}
