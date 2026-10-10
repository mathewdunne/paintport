import type { Project } from "./project";
import type { State } from "./paintField";
import { NO_PART } from "./types";

/**
 * Design state shown at one triangle: its painted state, or for an unpainted triangle the
 * base state of its part. This is the eyedropper: the picked color is the state returned
 * here. 0 for triangles that are not print surface (they show nothing).
 */
export function resolveTriangleState(project: Project, objectIndex: number, tri: number, bary?: readonly [number, number, number]): State {
  const object = project.objects[objectIndex];
  if (object.paintable[tri] !== 1) return 0;
  const painted = project.fields[objectIndex].stateAt(tri, bary);
  if (painted > 0) return painted;
  return baseStateOf(project, objectIndex, tri);
}

/** The base state of the triangle's part (0 when it has none). */
function baseStateOf(project: Project, objectIndex: number, tri: number): State {
  const object = project.objects[objectIndex];
  const part = object.triPart[tri];
  if (part === NO_PART) return 0;
  return project.baseColor.get(object.parts[part].id) ?? 0;
}

/**
 * What the viewer's state attribute holds for a triangle: the state it shows, except for a
 * split triangle, whose pieces the shader draws from its tree: there it is the part's base,
 * the color of the tree's unpainted leaves.
 */
export function resolveViewState(project: Project, objectIndex: number, tri: number): State {
  const object = project.objects[objectIndex];
  if (object.paintable[tri] !== 1) return 0;
  if (project.fields[objectIndex].treeOf(tri) !== undefined) return baseStateOf(project, objectIndex, tri);
  return resolveTriangleState(project, objectIndex, tri);
}

/** `resolveViewState` for every triangle of an object, as a fresh array. */
export function resolveViewStates(project: Project, objectIndex: number): Uint16Array {
  const out = resolveDisplayStates(project, objectIndex);
  for (const t of project.fields[objectIndex].trees().keys()) out[t] = resolveViewState(project, objectIndex, t);
  return out;
}

/** `resolveTriangleState` for every triangle of an object, as a fresh array. */
export function resolveDisplayStates(project: Project, objectIndex: number): Uint16Array {
  const object = project.objects[objectIndex];
  const painted = project.fields[objectIndex].displayStates();
  const baseOfPart = object.parts.map((p) => project.baseColor.get(p.id) ?? 0);
  const out = new Uint16Array(painted.length);
  for (let t = 0; t < painted.length; t++) {
    const s = painted[t];
    if (object.paintable[t] !== 1) out[t] = 0;
    else if (s > 0) out[t] = s;
    else {
      const part = object.triPart[t];
      out[t] = part === NO_PART ? 0 : baseOfPart[part];
    }
  }
  return out;
}

/**
 * Writes the display state of the given triangles into `out` (indexed by triangle, as
 * `resolveDisplayStates` returns it): the incremental update for a "paint" event.
 */
export function resolveStatesInto(project: Project, objectIndex: number, tris: ArrayLike<number>, out: Uint16Array): void {
  for (let i = 0; i < tris.length; i++) out[tris[i]] = resolveTriangleState(project, objectIndex, tris[i]);
}

/** `resolveStatesInto` with `resolveViewState`: the viewer's incremental update for a "paint" event. */
export function resolveViewStatesInto(project: Project, objectIndex: number, tris: ArrayLike<number>, out: Uint16Array): void {
  for (let i = 0; i < tris.length; i++) out[tris[i]] = resolveViewState(project, objectIndex, tris[i]);
}

/**
 * 1 for triangles that are print surface (ModelPart volumes), 0 for negative volumes,
 * modifiers and supports, which the viewer does not draw. The project's own array: do not
 * modify it.
 */
export function printSurfaceMask(project: Project, objectIndex: number): Uint8Array {
  return project.objects[objectIndex].paintable;
}
