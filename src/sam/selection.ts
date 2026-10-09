// AI Paint (spec Q10.5): views add up. Marks are points on the surface. A view is prompted with
// the positive marks it can see (made in any view) and the negative marks made in it; the
// views' mask splits are then combined into seeds for guided fill's race. DOM-free.
import type { Vec3 } from "../doc/paintField";
import { projectToImage, type MaskSplit } from "./lift";
import type { ImageCamera, SamPoint, Visibility } from "./types";

export interface AiMark {
  tri: number;
  /** World space. */
  point: Vec3;
  /** Face normal at the point, world space, facing the camera it was clicked from. */
  normal: Vec3;
  positive: boolean;
  /** The view it was clicked in. */
  view: number;
  /** The design state its triangle showed when it was placed. */
  state: number;
}

/** The prompt points for `view`, in its image's pixels. */
export function promptsFor(marks: readonly AiMark[], view: number, cam: ImageCamera, visibility: Visibility): SamPoint[] {
  const out: SamPoint[] = [];
  for (const m of marks) {
    const own = m.view === view;
    if (!m.positive && !own) continue;
    const [x, y, z] = m.point;
    if (!own && !visibility.isVisible(x, y, z, m.normal[0], m.normal[1], m.normal[2])) continue;
    const q = projectToImage(cam, x, y, z);
    if (!q || q[0] < 0 || q[1] < 0 || q[0] >= cam.width || q[1] >= cam.height) continue;
    out.push({ x: q[0], y: q[1], positive: m.positive });
  }
  return out;
}

/**
 * Seeds for the race from every view's split: inside = triangles some mask covers that show
 * `state` (spec Q10.9); outside = triangles some view saw outside its mask that no mask covers.
 * `stateOf` is the displayed state per triangle.
 */
export function combineViews(splits: readonly MaskSplit[], triCount: number, stateOf: ArrayLike<number>, state: number): { inside: number[]; outside: number[] } {
  const label = new Uint8Array(triCount); // 1 = in some mask, 2 = only seen outside masks
  for (const s of splits) for (const t of s.inside) label[t] = 1;
  for (const s of splits) for (const t of s.outside) if (label[t] === 0) label[t] = 2;
  const inside: number[] = [], outside: number[] = [];
  for (let t = 0; t < triCount; t++) {
    if (label[t] === 1 && stateOf[t] === state) inside.push(t);
    else if (label[t] === 2) outside.push(t);
  }
  return { inside, outside };
}
