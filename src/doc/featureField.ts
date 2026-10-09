// Feature-scale bend for smart fill. Comparing neighboring faces only works on clean meshes:
// on a sculpted or scanned model the surface texture bends single edges more than a soft
// crease does, because the crease is spread over several triangles. Here the face normals are
// first smoothed over a feature size, and the bend is measured on that smoothed surface, so
// texture below the feature size averages out and a crease reads as one clear band.
import { NEIGHBOR_NON_MANIFOLD, neighborFlipped, neighborTri, type MeshTopology } from "./meshTopology";

/**
 * Smoothing passes are capped so tiny triangles cannot stall the fill (about a second per
 * 500,000 triangles). Beyond the cap the smoothing is narrower than asked: about 12 triangles.
 */
const MAX_PASSES = 100;
/** Below this many smoothing passes the triangles are about as big as the feature size: there is no texture to smooth away. */
const MIN_PASSES = 2;
/** Bend fields kept per topology (one per feature size). */
const CACHE_SIZE = 4;
/** A crease of total bend B, smoothed with a Gaussian of sigma = scale / 2, peaks at B / (sqrt(2 pi) sigma): this undoes that. */
const CREASE_GAIN = Math.sqrt(2 * Math.PI) / 2;

/** The automatic feature size, in triangle spacings (0.2 mm on a sculpt with 0.08 mm edges). */
const AUTO_SPACINGS = 5;
/**
 * Edges flatter than this join coplanar triangles. CAD exports split every flat face and
 * every cylinder strip into such pairs (15-50% of their edges on sample parts); sculpts and
 * scans have almost none (0.2-1.2%). A mesh with at least FLAT_SHARE of them is compared
 * edge by edge: smoothing would only blur its hard edges and small features.
 */
const FLAT_DEG = 0.05;
const FLAT_SHARE = 0.1;

const cacheOf = new WeakMap<MeshTopology, Map<number, Float32Array | null>>();
const autoOf = new WeakMap<MeshTopology, number>();

/**
 * A feature size (object units) suited to the mesh: a few triangle spacings on a sculpted or
 * scanned surface, 0 (compare neighboring faces) on a mesh made of flat facets, like most CAD
 * exports. Cached per topology.
 */
export function autoFeatureScale(topology: MeshTopology): number {
  const cached = autoOf.get(topology);
  if (cached !== undefined) return cached;
  const n = topology.triCount;
  const normals = topology.faceNormals();
  const { vertices, tris } = topology.mesh;
  const centroid = (t: number, i: number) => (vertices[tris[t * 3] * 3 + i] + vertices[tris[t * 3 + 1] * 3 + i] + vertices[tris[t * 3 + 2] * 3 + i]) / 3;
  const cosFlat = Math.cos((FLAT_DEG * Math.PI) / 180);
  let edges = 0, flat = 0, spacing = 0;
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const code = topology.neighbors[t * 3 + k];
      if (code < 0) continue;
      const u = neighborTri(code);
      if (u < t) continue; // each edge once
      let dot = normals[t * 3] * normals[u * 3] + normals[t * 3 + 1] * normals[u * 3 + 1] + normals[t * 3 + 2] * normals[u * 3 + 2];
      if (neighborFlipped(code)) dot = -dot;
      edges++;
      if (dot > cosFlat) flat++;
      spacing += Math.hypot(centroid(t, 0) - centroid(u, 0), centroid(t, 1) - centroid(u, 1), centroid(t, 2) - centroid(u, 2));
    }
  }
  const scale = edges > 0 && flat < edges * FLAT_SHARE ? (AUTO_SPACINGS * spacing) / edges : 0;
  autoOf.set(topology, scale);
  return scale;
}

/**
 * Up to three neighbor codes (as in `MeshTopology.neighbors`) of `src` written to `out`; the
 * count is returned. At a non-manifold edge the flattest face on it stands for the edge.
 */
export function edgeNeighbors(topology: MeshTopology, normals: Float32Array, src: number, out: Int32Array): number {
  let count = 0;
  for (let k = 0; k < 3; k++) {
    const code = topology.neighbors[src * 3 + k];
    if (code >= 0) {
      out[count++] = code;
    } else if (code === NEIGHBOR_NON_MANIFOLD) {
      const links = topology.nonManifoldLinks?.get(src * 3 + k);
      if (!links) continue;
      let best = -Infinity, bestCode = -1;
      for (const link of links) {
        const u = neighborTri(link);
        let dot = normals[src * 3] * normals[u * 3] + normals[src * 3 + 1] * normals[u * 3 + 1] + normals[src * 3 + 2] * normals[u * 3 + 2];
        if (neighborFlipped(link)) dot = -dot;
        if (dot > best) { best = dot; bestCode = link; }
      }
      if (bestCode >= 0) out[count++] = bestCode;
    }
  }
  return count;
}

/**
 * Per triangle, the bend (radians) of the surface around it measured over `scale` (object
 * units): roughly the total angle of a crease running through it, after texture smaller than
 * `scale` is smoothed away. A flat or gently curved area reads near 0. Cached per topology and
 * scale; computing it costs a number of passes over the mesh that grows with
 * (scale / triangle size) squared, capped at MAX_PASSES (the bend is then measured over the
 * narrower width that the passes reached).
 *
 * Null when the triangles are about as big as `scale` or bigger (a coarse CAD-style mesh):
 * comparing neighboring faces is then the better measure.
 *
 * Duplicate faces take their twin's value. Non-manifold edges link to their flattest face.
 */
export function featureBend(topology: MeshTopology, scale: number): Float32Array | null {
  let cache = cacheOf.get(topology);
  if (!cache) cacheOf.set(topology, (cache = new Map()));
  if (cache.has(scale)) {
    const hit = cache.get(scale)!;
    cache.delete(scale); // most recently used last
    cache.set(scale, hit);
    return hit;
  }
  const bend = computeBend(topology, scale);
  cache.set(scale, bend);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return bend;
}

function computeBend(topology: MeshTopology, scale: number): Float32Array | null {
  const n = topology.triCount;
  const normals = topology.faceNormals();
  const { vertices, tris } = topology.mesh;
  const { duplicateOf, shellOfTri } = topology;
  const liveMask = new Uint8Array(n);
  for (let t = 0; t < n; t++) liveMask[t] = shellOfTri[t] >= 0 && !(duplicateOf && duplicateOf[t] >= 0) ? 1 : 0;
  const live = (t: number) => liveMask[t] === 1;

  const centroid = new Float32Array(n * 3), area = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    if (!live(t)) continue;
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    for (let i = 0; i < 3; i++) centroid[t * 3 + i] = (vertices[a + i] + vertices[b + i] + vertices[c + i]) / 3;
    const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
    const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
    area[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  const dist = (t: number, u: number) =>
    Math.hypot(centroid[t * 3] - centroid[u * 3], centroid[t * 3 + 1] - centroid[u * 3 + 1], centroid[t * 3 + 2] - centroid[u * 3 + 2]);

  // Neighbor codes once (flattest face at non-manifold edges), -1 padded.
  const links = new Int32Array(n * 3).fill(-1);
  const buf = new Int32Array(3);
  let spacingSum = 0, spacingCount = 0;
  for (let t = 0; t < n; t++) {
    if (!live(t)) continue;
    const count = edgeNeighbors(topology, normals, t, buf);
    for (let k = 0; k < count; k++) {
      links[t * 3 + k] = buf[k];
      spacingSum += dist(t, neighborTri(buf[k]));
      spacingCount++;
    }
  }
  const spacing = spacingCount ? spacingSum / spacingCount : 0;
  // Diffusion: each pass averages a face with its neighbors (area weighted). A random walk
  // moves about `spacing` with probability 3/4 per pass, so sigma^2 per axis ~ passes * 3/8 * spacing^2.
  const sigma = scale / 2;
  const wanted = (sigma * sigma) / (0.375 * spacing * spacing);
  if (!(wanted >= MIN_PASSES)) return null; // also catches scale <= 0 and a mesh without neighbors
  const passes = Math.min(MAX_PASSES, Math.round(wanted));
  const reached = 2 * spacing * Math.sqrt(0.375 * passes); // the scale these passes smooth over
  // Fixed weights per face: its own share and each neighbor's (area weighted, negative when
  // the neighbor is wound the other way), so a pass is a plain weighted sum.
  const nbr = new Int32Array(n * 3).fill(-1), weight = new Float32Array(n * 3), self = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    if (!live(t)) continue;
    let total = area[t];
    for (let k = 0; k < 3 && links[t * 3 + k] >= 0; k++) total += area[neighborTri(links[t * 3 + k])];
    if (!(total > 0)) { self[t] = 1; continue; }
    self[t] = area[t] / total;
    for (let k = 0; k < 3 && links[t * 3 + k] >= 0; k++) {
      const code = links[t * 3 + k], u = neighborTri(code);
      nbr[t * 3 + k] = u;
      weight[t * 3 + k] = ((neighborFlipped(code) ? -1 : 1) * area[u]) / total;
    }
  }
  let cur = Float32Array.from(normals), next = new Float32Array(n * 3);
  for (let pass = 0; pass < passes; pass++) {
    for (let t = 0; t < n; t++) {
      const w = self[t];
      let x = cur[t * 3] * w, y = cur[t * 3 + 1] * w, z = cur[t * 3 + 2] * w;
      for (let k = t * 3, end = k + 3; k < end; k++) {
        const u = nbr[k];
        if (u < 0) break;
        const a = weight[k];
        x += cur[u * 3] * a; y += cur[u * 3 + 1] * a; z += cur[u * 3 + 2] * a;
      }
      next[t * 3] = x; next[t * 3 + 1] = y; next[t * 3 + 2] = z;
    }
    const swap = cur; cur = next; next = swap;
  }

  const bend = new Float32Array(n);
  // Bend: the steepest turn of the smoothed normal toward a neighbor, per unit distance, times the scale.
  for (let t = 0; t < n; t++) {
    if (!live(t)) continue;
    const nx = cur[t * 3], ny = cur[t * 3 + 1], nz = cur[t * 3 + 2];
    let steepest = 0;
    for (let k = 0; k < 3; k++) {
      const code = links[t * 3 + k];
      if (code < 0) break;
      const u = neighborTri(code), s = neighborFlipped(code) ? -1 : 1;
      const mx = cur[u * 3] * s, my = cur[u * 3 + 1] * s, mz = cur[u * 3 + 2] * s;
      const angle = Math.atan2(Math.hypot(ny * mz - nz * my, nz * mx - nx * mz, nx * my - ny * mx), nx * mx + ny * my + nz * mz);
      const d = dist(t, u);
      if (d > 0 && angle / d > steepest) steepest = angle / d;
    }
    bend[t] = steepest * reached * CREASE_GAIN;
  }

  // The steepest turn toward one neighbor is a noisy estimate per triangle; averaging it over
  // half the smoothing width turns that speckle into the bands and blobs that are really there.
  let b = bend, scratch = new Float32Array(n);
  for (let pass = 0, count = Math.max(1, Math.round(passes / 4)); pass < count; pass++) {
    for (let t = 0; t < n; t++) {
      let sum = b[t], w = 1;
      for (let k = t * 3, end = k + 3; k < end; k++) {
        const u = nbr[k];
        if (u < 0) break;
        sum += b[u];
        w++;
      }
      scratch[t] = sum / w;
    }
    const swap = b; b = scratch; scratch = swap;
  }
  bend.set(b);
  if (duplicateOf) for (let t = 0; t < n; t++) if (duplicateOf[t] >= 0) bend[t] = bend[duplicateOf[t]];
  return bend;
}
