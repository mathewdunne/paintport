import { resolveDisplayStates, resolveStatesInto, resolveTriangleState } from "../doc/display";
import type { Project } from "../doc/project";
import type { ViewScene } from "./viewScene";

/** The viewer calls the sync uses to recolor. `ModelViewer` implements it. */
export interface ColorTarget {
  updateTriangleColors(objectIndex: number, triIndices: ArrayLike<number>): void;
  setPalette(palette: string[], changed: readonly number[] | "all"): void;
}

/**
 * Keeps the viewer in step with the project through its change events alone, touching
 * only what changed: the triangles of a paint edit, the triangles of a part whose base
 * color changed, the triangles that show a recolored state. Geometry and the spatial
 * index are never rebuilt. `scene` must be the snapshot the viewer was given (its
 * `states` arrays are updated in place). Returns the unsubscribe function.
 */
export function syncViewerToProject(project: Project, scene: ViewScene, viewer: ColorTarget): () => void {
  return project.subscribe((e) => {
    switch (e.kind) {
      case "paint": {
        resolveStatesInto(project, e.object, e.tris, scene.objects[e.object].states);
        viewer.updateTriangleColors(e.object, e.tris);
        break;
      }
      case "base": {
        const states = scene.objects[e.object].states;
        for (const pi of e.parts) {
          const part = project.objects[e.object].parts[pi];
          const tris = new Uint32Array(part.triCount);
          for (let i = 0; i < part.triCount; i++) {
            tris[i] = part.firstTri + i;
            states[part.firstTri + i] = resolveTriangleState(project, e.object, part.firstTri + i);
          }
          viewer.updateTriangleColors(e.object, tris);
        }
        break;
      }
      case "palette": {
        const colors = project.palette.map((c) => c.color);
        scene.palette = colors;
        if (e.renumbered) {
          project.objects.forEach((_, i) => scene.objects[i].states.set(resolveDisplayStates(project, i)));
          viewer.setPalette(colors, "all");
        } else {
          viewer.setPalette(colors, e.changed);
        }
        break;
      }
      case "history":
        break;
    }
  });
}
