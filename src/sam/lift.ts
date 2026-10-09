// AI Paint (spec Q10): from a mask in a view to the triangles it covers. A triangle counts when
// its centroid is visible in that view (the visible-only brush's depth test, so sub-pixel
// triangles on dense meshes aren't lost as they would be with an ID buffer) and the mask covers
// the centroid's pixel. Triangles near the mask's edge or seen at a grazing angle are left to
// guided fill's race, which puts the boundary on the nearest crease. Whole triangles only;
// sub-triangle boundaries are phase 5. DOM-free.
import { applyTransform, parseTransform } from "../core";
import type { EditableMesh } from "../doc/paintField";
import { fieldAt, type MaskField } from "./masks";
import type { ImageCamera, Visibility } from "./types";

/**
 * Triangles closer than this to the mask's edge (share of the image's long side) are in neither
 * list. SAM's mask is a 256-cell grid over the long side, so its edge can be a few cells off the
 * crease; trusting it exactly leaves ragged edges and walls the race off from the hidden side.
 */
export const EDGE_BAND = 3 / 256;
/**
 * Triangles whose face turns further than this from the camera (cosine of the angle between the
 * view ray and the normal) are in neither list: near the silhouette a pixel spans much surface,
 * so the mask's edge there says little about where the part ends.
 */
export const MIN_FACING = 0.3;

/** Per triangle: world-space centroid and face normal (not normalized, along the winding). */
export interface TriangleFrames {
  centroids: Float64Array;
  normals: Float64Array;
}

/** The world-space frames of an object's triangles, under its build transform. */
export function triangleFrames(mesh: EditableMesh, transform: string | null): TriangleFrames {
  const t = parseTransform(transform);
  const { vertices, tris, triCount } = mesh;
  const centroids = new Float64Array(triCount * 3), normals = new Float64Array(triCount * 3);
  const p = new Float64Array(9);
  for (let f = 0; f < triCount; f++) {
    for (let k = 0; k < 3; k++) {
      const v = tris[f * 3 + k] * 3;
      const w = applyTransform(t, vertices[v], vertices[v + 1], vertices[v + 2]);
      p[k * 3] = w[0]; p[k * 3 + 1] = w[1]; p[k * 3 + 2] = w[2];
    }
    for (let i = 0; i < 3; i++) centroids[f * 3 + i] = (p[i] + p[3 + i] + p[6 + i]) / 3;
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2];
    const vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    normals[f * 3] = uy * vz - uz * vy;
    normals[f * 3 + 1] = uz * vx - ux * vz;
    normals[f * 3 + 2] = ux * vy - uy * vx;
  }
  return { centroids, normals };
}

/** A world point in image pixels (x to the right, y down), or null if it is behind the camera. */
export function projectToImage(cam: ImageCamera, x: number, y: number, z: number): [number, number] | null {
  const v = cam.view, p = cam.proj;
  const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
  const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
  const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
  const w = -vz; // w_clip = -z_view for a perspective projection
  if (w <= 0) return null;
  const nx = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / w;
  const ny = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / w;
  return [(nx * 0.5 + 0.5) * cam.width, (0.5 - ny * 0.5) * cam.height];
}

/** One view's verdict: visible triangles inside the mask, and visible triangles outside it. */
export interface MaskSplit {
  inside: Uint32Array;
  outside: Uint32Array;
}

/**
 * Splits an object's triangles by one view's mask (see `maskField`). Hidden triangles, grazing
 * ones and those near the mask's edge are in neither list, and only triangles with
 * `paintable[t] === 1` count.
 */
export function liftMask(frames: TriangleFrames, paintable: Uint8Array, cam: ImageCamera, visibility: Visibility, field: MaskField): MaskSplit {
  const inside: number[] = [], outside: number[] = [];
  const { centroids: c, normals: n } = frames;
  const band = EDGE_BAND * Math.max(cam.width, cam.height);
  const inner = Math.min(band, field.depth / 2); // a thin mask still keeps its middle
  const [ex, ey, ez] = cam.eye;
  for (let t = 0; t < paintable.length; t++) {
    if (paintable[t] !== 1) continue;
    const x = c[t * 3], y = c[t * 3 + 1], z = c[t * 3 + 2];
    const nx = n[t * 3], ny = n[t * 3 + 1], nz = n[t * 3 + 2];
    if (!visibility.isVisible(x, y, z, nx, ny, nz)) continue;
    const dx = x - ex, dy = y - ey, dz = z - ez;
    if (Math.abs(nx * dx + ny * dy + nz * dz) < MIN_FACING * Math.hypot(nx, ny, nz) * Math.hypot(dx, dy, dz)) continue;
    const q = projectToImage(cam, x, y, z);
    if (!q) continue;
    const d = fieldAt(field, q[0], q[1]);
    if (d > inner) inside.push(t);
    else if (d < -band) outside.push(t);
  }
  return { inside: Uint32Array.from(inside), outside: Uint32Array.from(outside) };
}
