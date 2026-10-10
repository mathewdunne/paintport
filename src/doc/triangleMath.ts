// Small geometry helpers on indexed meshes (no allocation in the hot paths).

/** Squared distance from point p to segment a-b. */
function sqDistSegment(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - t * abx, dy = apy - t * aby, dz = apz - t * abz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Squared distance from point p to triangle `tri` of the indexed mesh: the exact closest
 * point on the triangle, not its plane or bounding box. A sphere of radius r touches the
 * triangle iff this is <= r * r.
 */
export function sqDistPointTriangle(
  vertices: Float64Array, tris: Int32Array, tri: number, px: number, py: number, pz: number,
): number {
  const ia = tris[tri * 3] * 3, ib = tris[tri * 3 + 1] * 3, ic = tris[tri * 3 + 2] * 3;
  const ax = vertices[ia], ay = vertices[ia + 1], az = vertices[ia + 2];
  const bx = vertices[ib], by = vertices[ib + 1], bz = vertices[ib + 2];
  const cx = vertices[ic], cy = vertices[ic + 1], cz = vertices[ic + 2];

  // Voronoi-region walk (Ericson, Real-Time Collision Detection 5.1.5).
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz; // vertex a
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz; // vertex b
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { // edge ab
    const v = d1 / (d1 - d3);
    const dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz;
    return dx * dx + dy * dy + dz * dz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz; // vertex c
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { // edge ac
    const w = d2 / (d2 - d6);
    const dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz;
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { // edge bc
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const dx = bpx - w * (cx - bx), dy = bpy - w * (cy - by), dz = bpz - w * (cz - bz);
    return dx * dx + dy * dy + dz * dz;
  }
  const sum = va + vb + vc;
  if (!(sum > 0) || !Number.isFinite(sum)) {
    // Degenerate (collinear) triangle: the closest point lies on one of its edges.
    return Math.min(
      sqDistSegment(px, py, pz, ax, ay, az, bx, by, bz),
      sqDistSegment(px, py, pz, bx, by, bz, cx, cy, cz),
      sqDistSegment(px, py, pz, cx, cy, cz, ax, ay, az),
    );
  }
  // Inside the face: barycentric closest point.
  const denom = 1 / sum;
  const v = vb * denom, w = vc * denom;
  const dx = apx - abx * v - acx * w, dy = apy - aby * v - acy * w, dz = apz - abz * v - acz * w;
  return dx * dx + dy * dy + dz * dz;
}

/** `sqDistPointTriangle` for a triangle given by its corners a, b, c. */
export function sqDistPointCorners(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const c = CORNER_SCRATCH;
  c[0] = ax; c[1] = ay; c[2] = az; c[3] = bx; c[4] = by; c[5] = bz; c[6] = cx; c[7] = cy; c[8] = cz;
  return sqDistPointTriangle(c, CORNERS, 0, px, py, pz);
}
const CORNER_SCRATCH = new Float64Array(9);
const CORNERS = Int32Array.of(0, 1, 2);
