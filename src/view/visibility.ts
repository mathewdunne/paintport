// Visible-only brushing (spec Q5.2): decides whether a surface point can be seen from the
// camera, using a depth image of the scene that the viewer renders once per camera pose
// (see depthPass.ts) and reads back to the CPU. Pure math on plain arrays, so it runs
// (and is tested) in Node with a software depth image.
//
// Why a depth image and not an ID image: an ID image only knows triangles that cover at
// least one pixel, so on dense meshes (triangles smaller than a pixel) most triangles would
// count as hidden and a stroke would leave speckle. Here every candidate triangle is
// tested at the point where the brush touches it, against the depth of whatever surface
// covers that pixel; a sub-pixel triangle on a visible surface sits at (nearly) the same
// depth as its neighbours and passes.

/** Pixel alpha: nothing drawn here. */
export const ALPHA_NONE = 0;
/** Pixel alpha: the nearest surface is front-facing (counter-clockwise on screen). */
export const ALPHA_FRONT = 255;
/** Pixel alpha: the nearest surface is a back face (inverted winding, or looking inside a mesh). */
export const ALPHA_BACK = 128;

const DEPTH_MAX = 0xffffff;

/** Packs a normalized depth (0 = near plane, 1 = far plane) into 3 bytes. Mirrors the depth shader. */
export function encodeDepth(depth01: number): [number, number, number] {
  const v = Math.round(Math.min(1, Math.max(0, depth01)) * DEPTH_MAX);
  return [Math.floor(v / 65536), Math.floor((v % 65536) / 256), v % 256];
}

export function decodeDepth(r: number, g: number, b: number): number {
  return (r * 65536 + g * 256 + b) / DEPTH_MAX;
}

/** A depth image as `readPixels` returns it: RGBA bytes, row 0 at the bottom. */
export interface DepthFrame {
  width: number;
  height: number;
  /** RGB = packed depth (see encodeDepth), A = ALPHA_*. */
  data: ArrayLike<number>;
  /** Linear view-space distances the packed depth is normalized by. */
  near: number;
  far: number;
}

/** The camera the depth image was rendered with. Matrices are column-major (three.js `elements`). */
export interface DepthView {
  /** World to camera. */
  view: ArrayLike<number>;
  /** Camera to clip space (perspective). */
  proj: ArrayLike<number>;
  /** Camera position in world space. */
  eye: readonly [number, number, number];
}

/** Steepest surface slope (tan of the angle to the view direction) the depth tolerance accounts for. */
const MAX_SLOPE = 8;
/** Depth tolerance in pixel sizes on a surface facing the camera. */
const BASE_TOLERANCE_PX = 1.5;

export class VisibilityTest {
  private readonly frame: DepthFrame;
  private readonly v: ArrayLike<number>;
  private readonly p: ArrayLike<number>;
  private readonly eye: readonly [number, number, number];
  private readonly range: number;
  /** Depth quantization step plus slack, in world units. */
  private readonly floor: number;
  /** World size of one depth-image pixel at distance 1. */
  private readonly pixelAtUnit: number;

  constructor(frame: DepthFrame, view: DepthView) {
    this.frame = frame;
    this.v = view.view;
    this.p = view.proj;
    this.eye = view.eye;
    this.range = frame.far - frame.near;
    this.floor = (2 * this.range) / DEPTH_MAX;
    this.pixelAtUnit = 2 / (view.proj[5] * frame.height);
  }

  /**
   * True if the surface point (x, y, z) with face normal (nx, ny, nz) (any length) is
   * visible. Front-facing points are visible when nothing nearer covers their pixel.
   * Back-facing points count only when the nearest surface at their pixel is a back face
   * as well (a mesh with inverted winding); otherwise they are the far side of something
   * seen from the front, such as the back of a thin plate.
   */
  isVisible(x: number, y: number, z: number, nx: number, ny: number, nz: number): boolean {
    const { v, p, frame } = this;
    const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
    const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
    const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
    const depth = -vz;
    if (depth <= frame.near) return false;
    const w = depth; // w_clip = -z_view for a perspective projection
    const sx = ((p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / w * 0.5 + 0.5) * frame.width;
    const sy = ((p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / w * 0.5 + 0.5) * frame.height;
    const dx = x - this.eye[0], dy = y - this.eye[1], dz = z - this.eye[2];
    const dot = nx * dx + ny * dy + nz * dz;
    const front = dot < 0;
    // Along a slanted surface the depth changes by `slope` pixel sizes per pixel, and the
    // sample can be off by up to a pixel.
    const len = Math.hypot(nx, ny, nz) * Math.hypot(dx, dy, dz);
    const cos = len > 0 ? Math.abs(dot) / len : 1;
    const slope = Math.min(MAX_SLOPE, Math.sqrt(Math.max(0, 1 - cos * cos)) / Math.max(cos, 1e-6));
    const tolerance = this.pixelAtUnit * depth * (BASE_TOLERANCE_PX + slope) + this.floor;

    // The four pixels whose centres are nearest to the point. Passing against any of them is
    // enough: a point right beside an occluder's edge sits in a pixel the occluder covers,
    // and testing only that pixel would drop it although it is visible.
    const x0 = Math.floor(sx - 0.5), y0 = Math.floor(sy - 0.5);
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const px = x0 + i, py = y0 + j;
        if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
        const o = (py * frame.width + px) * 4;
        const alpha = frame.data[o + 3];
        if (alpha === ALPHA_NONE) {
          if (front) return true; // nothing is drawn here (a sliver at the silhouette)
          continue;
        }
        if (!front && alpha !== ALPHA_BACK) continue;
        const bufferDepth = frame.near + decodeDepth(frame.data[o], frame.data[o + 1], frame.data[o + 2]) * this.range;
        if (depth - bufferDepth <= tolerance) return true;
      }
    }
    return false;
  }
}
