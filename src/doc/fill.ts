// Region algorithms for the fill tools: pure functions over a MeshTopology that return the
// triangles to paint. Tools paint the result with Project.paintTriangles; the hover
// preview calls the same functions without painting.
import { edgeNeighbors, featureBend } from "./featureField";
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

interface HoleScratch {
  /** Call number per triangle known to lie outside any small hole (its component was too big). */
  outside: Uint32Array;
  call: number;
  /** Search id per triangle visited by the current hole search. */
  seen: Uint32Array;
  search: number;
  list: Uint32Array;
}
const holeScratchOf = new WeakMap<MeshTopology, HoleScratch>();

/**
 * Adds to a region the holes it surrounds: connected groups of triangles for which `candidate`
 * holds, smaller than `maxArea` in total, that touch the region and nothing else a search can
 * leave through (every other triangle is a wall). `region` holds the region's triangles in its
 * first `size` entries; `add` is called for each triangle of each hole. A search from the
 * region's edge gives up as soon as it is too big or reaches a triangle an earlier search found
 * to be open.
 */
export function fillSmallHoles(
  topology: MeshTopology, region: ArrayLike<number>, size: number, maxArea: number,
  candidate: (t: number) => boolean, add: (t: number) => void,
): void {
  const n = topology.triCount;
  const normals = topology.faceNormals();
  const { duplicateOf } = topology;
  let hs = holeScratchOf.get(topology);
  if (!hs) holeScratchOf.set(topology, (hs = { outside: new Uint32Array(n), call: 0, seen: new Uint32Array(n), search: 0, list: new Uint32Array(n) }));
  if (hs.search > 0xfffffff0) { hs.seen.fill(0); hs.search = 0; }
  if (++hs.call === 0xffffffff) { hs.outside.fill(0); hs.call = 1; }
  const { outside, seen, list, call } = hs;
  const { vertices, tris } = topology.mesh;
  const srcOf = (t: number) => (duplicateOf && duplicateOf[t] >= 0 ? duplicateOf[t] : t);
  const areaOf = (t: number): number => {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
    const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  };
  const buf = new Int32Array(3), inner = new Int32Array(3);
  for (let i = 0; i < size; i++) {
    const count = edgeNeighbors(topology, normals, srcOf(region[i]), buf);
    for (let k = 0; k < count; k++) {
      const start = neighborTri(buf[k]);
      if (outside[start] === call || !candidate(start)) continue;
      const id = ++hs.search;
      let found = 0, area = 0, closed = true;
      seen[start] = id;
      list[found++] = start;
      for (let head = 0; head < found && closed; head++) {
        const t = list[head];
        area += areaOf(t);
        if (area > maxArea) { closed = false; break; }
        const c = edgeNeighbors(topology, normals, srcOf(t), inner);
        for (let j = 0; j < c; j++) {
          const u = neighborTri(inner[j]);
          if (seen[u] === id || !candidate(u)) continue;
          if (outside[u] === call) { closed = false; break; }
          seen[u] = id;
          list[found++] = u;
        }
      }
      if (closed) for (let j = 0; j < found; j++) add(list[j]);
      else for (let j = 0; j < found; j++) outside[list[j]] = call;
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
 * `smartFill`.
 */
export function featureFill(topology: MeshTopology, seed: number, angleDeg: number, scale: number, display: DisplayView): Uint32Array {
  const shell = topology.shellOfTri[seed];
  if (shell === undefined || shell < 0) return NONE;
  const bend = featureBend(topology, scale);
  if (!bend) return smartFill(topology, seed, angleDeg, display);
  const n = topology.triCount;
  const normals = topology.faceNormals();
  const { duplicateOf, duplicateGroups } = topology;
  const { painted, triPart, baseOfPart } = display;
  const angle = Number.isFinite(angleDeg) ? Math.min(180, Math.max(0, angleDeg)) : 0;
  const limit = (angle * Math.PI) / 180;

  let sc = scratchOf.get(topology);
  if (!sc) scratchOf.set(topology, (sc = { stamp: new Uint32Array(n), queue: new Uint32Array(n), epoch: 0 }));
  if (++sc.epoch === 0xffffffff) { sc.stamp.fill(0); sc.epoch = 1; }
  const { stamp, queue, epoch } = sc;

  const stateOf = (t: number): number => (painted[t] > 0 ? painted[t] : baseOfPart[triPart[t]]);
  const seedState = stateOf(seed);
  const srcOf = (t: number) => (duplicateOf && duplicateOf[t] >= 0 ? duplicateOf[t] : t); // duplicates have no edges of their own
  const buf = new Int32Array(3);
  let tail = 0;
  const visit = (u: number): void => {
    stamp[u] = epoch;
    queue[tail++] = u;
  };
  const visitTwins = (t: number): void => {
    const group = duplicateGroups?.get(t);
    if (group) for (const m of group) if (stamp[m] !== epoch && stateOf(m) === seedState) visit(m);
  };

  // 1 + 2: flood below the limit, climb into creases while the bend rises.
  visit(seed);
  for (let head = 0; head < tail; head++) {
    const t = queue[head];
    visitTwins(t);
    const src = srcOf(t);
    const count = edgeNeighbors(topology, normals, src, buf);
    for (let k = 0; k < count; k++) {
      const u = neighborTri(buf[k]);
      if (stamp[u] === epoch || stateOf(u) !== seedState) continue;
      const flat = bend[u] < limit;
      if (flat ? bend[src] < limit : bend[u] >= bend[src]) visit(u);
    }
  }

  // 3: small holes.
  const filled = tail;
  fillSmallHoles(topology, queue, filled, Math.PI * scale * scale, (t) => stamp[t] !== epoch && stateOf(t) === seedState, visit);
  for (let i = filled, end = tail; i < end; i++) visitTwins(queue[i]);
  return queue.slice(0, tail);
}
