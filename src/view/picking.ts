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
    return { tri: this.triOfSlot[slot], point: hit.point.clone(), normal: faceNormal.clone(), distance: hit.distance };
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
