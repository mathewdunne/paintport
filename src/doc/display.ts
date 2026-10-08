import { NO_PART, type Project } from "./project";
import type { State } from "./paintField";

/**
 * Design state to show for one triangle: its painted state, or for an unpainted triangle
 * the base state of its part. Use this for incremental viewer updates (phase 2).
 */
export function resolveTriangleState(project: Project, objectIndex: number, tri: number): State {
  const object = project.objects[objectIndex];
  const painted = project.fields[objectIndex].stateAt(tri);
  if (painted > 0) return painted;
  const part = object.triPart[tri];
  if (part === NO_PART) return object.source.defaultExtruder;
  return project.baseColor.get(object.parts[part].id) ?? object.source.defaultExtruder;
}

/** `resolveTriangleState` for every triangle of an object, as a fresh array. */
export function resolveDisplayStates(project: Project, objectIndex: number): Uint16Array {
  const object = project.objects[objectIndex];
  const painted = project.fields[objectIndex].displayStates();
  const baseOfPart = object.parts.map((p) => project.baseColor.get(p.id) ?? object.source.defaultExtruder);
  const out = new Uint16Array(painted.length);
  for (let t = 0; t < painted.length; t++) {
    const s = painted[t];
    if (s > 0) out[t] = s;
    else {
      const part = object.triPart[t];
      out[t] = part === NO_PART ? object.source.defaultExtruder : baseOfPart[part];
    }
  }
  return out;
}

/**
 * 1 for triangles that are print surface (ModelPart volumes), 0 for negative volumes,
 * modifiers and supports, which the viewer does not draw.
 */
export function printSurfaceMask(project: Project, objectIndex: number): Uint8Array {
  const object = project.objects[objectIndex];
  const mask = new Uint8Array(object.triCount);
  for (const p of object.parts) if (p.type === "ModelPart") mask.fill(1, p.firstTri, p.firstTri + p.triCount);
  return mask;
}
