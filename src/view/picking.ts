import { BufferGeometry, DoubleSide, Ray, Vector3 } from "three";
import { INTERSECTED, MeshBVH, NOT_INTERSECTED } from "three-mesh-bvh";
import type { VisibilityTest } from "./visibility";

/** Where a ray meets an object. `tri` is a document triangle id. */
export interface SurfaceHit {
  tri: number;
  /** World space. */
  point: Vector3;
  /** Unit face normal in world space, flipped to face the ray origin. */
  normal: Vector3;
  distance: number;
  /** The point's barycentric coordinates in the triangle, in the order the document lists its corners. */
  bary: [number, number, number];
}

/** Growable list of triangle ids, reused between brush dabs. */
export class TriangleList {
  private buf = new Uint32Array(1024);
  length = 0;

  push(tri: number): void {
    if (this.length === this.buf.length) {
      const next = new Uint32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = tri;
  }

  clear(): void {
    this.length = 0;
  }

  /** A copy that stays valid after the list is reused. */
  toArray(): Uint32Array {
    return this.buf.slice(0, this.length);
  }
}

const closest = new Vector3();
const faceNormal = new Vector3();

/**
 * Spatial index of one object's render geometry (non-indexed, world-space positions, one
 * "slot" of 3 vertices per drawn triangle). Answers ray and sphere queries in document
 * triangle ids. The BVH is built once per scene: painting only recolors triangles, so it
 * never needs to be rebuilt or refitted.
 */
export class ObjectPicker {
  private readonly bvh: MeshBVH;
  private readonly position: ArrayLike<number>;
  private readonly triOfSlot: Uint32Array;

  /** `slotOfTri` maps a document triangle to its slot (-1 = not drawn). */
  constructor(geometry: BufferGeometry, slotOfTri: Int32Array, slotCount: number) {
    this.position = geometry.getAttribute("position").array;
    this.triOfSlot = new Uint32Array(slotCount);
    for (let t = 0; t < slotOfTri.length; t++) if (slotOfTri[t] >= 0) this.triOfSlot[slotOfTri[t]] = t;
    // Indirect: the geometry's own buffers stay untouched (no index is added or reordered).
    this.bvh = new MeshBVH(geometry, { indirect: true });
  }

  /** First surface along `ray`, or null. Both sides of a triangle count, so inverted meshes can be picked. */
  raycast(ray: Ray): SurfaceHit | null {
    const hit = this.bvh.raycastFirst(ray, DoubleSide);
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null;
    const slot = hit.faceIndex;
    this.normalOfSlot(slot, faceNormal);
    if (faceNormal.dot(ray.direction) > 0) faceNormal.negate();
    return { tri: this.triOfSlot[slot], point: hit.point.clone(), normal: faceNormal.clone(), distance: hit.distance, bary: this.baryOfSlot(slot, hit.point) };
  }

  /** Barycentric coordinates of a point on slot `slot`'s triangle (slot vertex k is the document triangle's corner k). */
  private baryOfSlot(slot: number, p: Vector3): [number, number, number] {
    const pos = this.position, o = slot * 9;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const v0x = pos[o + 3] - ax, v0y = pos[o + 4] - ay, v0z = pos[o + 5] - az;
    const v1x = pos[o + 6] - ax, v1y = pos[o + 7] - ay, v1z = pos[o + 8] - az;
    const v2x = p.x - ax, v2y = p.y - ay, v2z = p.z - az;
    const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
    const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z;
    const den = d00 * d11 - d01 * d01;
    if (!(Math.abs(den) > 0)) return [1 / 3, 1 / 3, 1 / 3]; // degenerate: any point will do
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    const v = clamp((d11 * d20 - d01 * d21) / den), w = clamp((d00 * d21 - d01 * d20) / den);
    const sum = v + w > 1 ? v + w : 1;
    return [1 - (v + w) / sum, v / sum, w / sum];
  }

  /**
   * Adds to `out` the document triangles the sphere (world space) touches: those whose
   * closest point to `center` is within `radius`. With `visibility`, only triangles whose
   * closest point (where the brush actually meets them) is visible. `forceTri` is always
   * included if given (the triangle under the cursor, which is visible by construction).
   */
  collectSphere(center: Vector3, radius: number, visibility: VisibilityTest | null, forceTri: number, out: TriangleList): void {
    const r2 = radius * radius;
    let forced = forceTri < 0;
    const triOfSlot = this.triOfSlot;
    this.bvh.shapecast({
      intersectsBounds: (box) => (box.distanceToPoint(center) <= radius ? INTERSECTED : NOT_INTERSECTED),
      intersectsTriangle: (tri, slot) => {
        tri.closestPointToPoint(center, closest);
        if (closest.distanceToSquared(center) > r2) return false;
        const id = triOfSlot[slot];
        if (id === forceTri) forced = true;
        else if (visibility) {
          this.normalOfSlot(slot, faceNormal);
          if (!visibility.isVisible(closest.x, closest.y, closest.z, faceNormal.x, faceNormal.y, faceNormal.z)) return false;
        }
        out.push(id);
        return false;
      },
    });
    if (!forced) out.push(forceTri);
  }

  private normalOfSlot(slot: number, target: Vector3): void {
    const p = this.position, o = slot * 9;
    const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
    const wx = p[o + 6] - p[o], wy = p[o + 7] - p[o + 1], wz = p[o + 8] - p[o + 2];
    target.set(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx).normalize();
  }
}
