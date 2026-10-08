// Region algorithms for the fill tools: pure functions over a MeshTopology that return the
// triangles to paint. Tools paint the result with Project.paintTriangles; the hover
// preview calls the same functions without painting.
import { neighborFlipped, neighborTri, NEIGHBOR_NON_MANIFOLD, type MeshTopology } from "./meshTopology";

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

interface Scratch {
  stamp: Uint32Array;
  queue: Uint32Array;
  epoch: number;
}
const scratchOf = new WeakMap<MeshTopology, Scratch>();

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
 * Cost is proportional to the filled region (the visited stamps are reused between calls).
 */
export function smartFill(topology: MeshTopology, seed: number, angleDeg: number, display: DisplayView): Uint32Array {
  const shell = topology.shellOfTri[seed];
  if (shell === undefined || shell < 0) return NONE;
  const n = topology.triCount;
  const normals = topology.faceNormals();
  const { neighbors, duplicateOf, duplicateGroups, nonManifoldLinks } = topology;
  const { painted, triPart, baseOfPart } = display;
  const angle = Number.isFinite(angleDeg) ? Math.min(180, Math.max(0, angleDeg)) : 0;
  const cosThreshold = Math.cos((angle * Math.PI) / 180) - 1e-6; // slack for float32 normals at 0 degrees

  let sc = scratchOf.get(topology);
  if (!sc) scratchOf.set(topology, (sc = { stamp: new Uint32Array(n), queue: new Uint32Array(n), epoch: 0 }));
  if (++sc.epoch === 0xffffffff) { sc.stamp.fill(0); sc.epoch = 1; }
  const { stamp, queue, epoch } = sc;

  const stateOf = (t: number): number => (painted[t] > 0 ? painted[t] : baseOfPart[triPart[t]]);
  const seedState = stateOf(seed);
  let head = 0, tail = 0;
  queue[tail++] = seed;
  stamp[seed] = epoch;

  /** Cosine of the angle between the faces, honoring winding; 1 when either has no normal. */
  const cosBetween = (src: number, u: number, flipped: boolean): number => {
    const nx = normals[src * 3], ny = normals[src * 3 + 1], nz = normals[src * 3 + 2];
    const mx = normals[u * 3], my = normals[u * 3 + 1], mz = normals[u * 3 + 2];
    if ((nx === 0 && ny === 0 && nz === 0) || (mx === 0 && my === 0 && mz === 0)) return 1;
    const dot = nx * mx + ny * my + nz * mz;
    return flipped ? -dot : dot;
  };
  const visit = (u: number): void => {
    stamp[u] = epoch;
    queue[tail++] = u;
  };

  while (head < tail) {
    const t = queue[head++];
    if (duplicateGroups) {
      const group = duplicateGroups.get(t);
      if (group) for (const m of group) if (stamp[m] !== epoch && stateOf(m) === seedState) visit(m);
    }
    const src = duplicateOf && duplicateOf[t] >= 0 ? duplicateOf[t] : t; // duplicates have no edges of their own
    for (let k = 0; k < 3; k++) {
      const code = neighbors[src * 3 + k];
      if (code >= 0) {
        const u = neighborTri(code);
        if (stamp[u] !== epoch && stateOf(u) === seedState && cosBetween(src, u, neighborFlipped(code)) >= cosThreshold) visit(u);
      } else if (code === NEIGHBOR_NON_MANIFOLD) {
        const links = nonManifoldLinks?.get(src * 3 + k);
        if (!links) continue;
        let best = -Infinity, bestTri = -1;
        for (const link of links) {
          const c = cosBetween(src, neighborTri(link), neighborFlipped(link));
          if (c > best) { best = c; bestTri = neighborTri(link); }
        }
        if (bestTri >= 0 && stamp[bestTri] !== epoch && stateOf(bestTri) === seedState && best >= cosThreshold) visit(bestTri);
      }
    }
  }
  return queue.slice(0, tail);
}
