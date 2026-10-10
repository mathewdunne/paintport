import { resolveViewStates, resolveViewStatesInto } from "../doc/display";
import type { Project } from "../doc/project";
import type { ViewScene } from "./viewScene";

/** The viewer calls the sync uses. `ModelViewer` implements it. */
export interface SyncTarget {
  /** Rewrites the given triangles' state attribute from the scene's (already updated) `states`. */
  updateTriangleStates(objectIndex: number, triIndices: ArrayLike<number>): void;
  /** Rewrites every triangle's state attribute from the scene's `states`. */
  refreshStates(): void;
  /** Installs the Design colors; touches the color table only, never the state attribute. */
  setPalette(palette: string[]): void;
}

/**
 * Keeps the viewer in step with the project through its change events alone, touching
 * only what changed: the triangles of a paint edit, the unpainted triangles of a part
 * whose base color changed, the color table for a recolor. Geometry and the spatial index
 * are never rebuilt. `scene` must be the snapshot the viewer was given (its `states`
 * arrays are updated in place). Returns the unsubscribe function.
 */
export function syncViewerToProject(project: Project, scene: ViewScene, viewer: SyncTarget): () => void {
  return project.subscribe((e) => {
    switch (e.kind) {
      case "paint": {
        resolveViewStatesInto(project, e.object, e.tris, scene.objects[e.object].states);
        viewer.updateTriangleStates(e.object, e.tris);
        break;
      }
      case "base": {
        const states = scene.objects[e.object].states;
        const field = project.fields[e.object];
        const { parts, paintable } = project.objects[e.object];
        for (const pi of e.parts) {
          const part = parts[pi];
          const base = project.baseColor.get(part.id) ?? 0;
          const tris = new Uint32Array(part.triCount);
          let n = 0;
          for (let t = part.firstTri; t < part.firstTri + part.triCount; t++) {
            // Painted: shows its own state, not the base. A split triangle holds the base for its unpainted pieces.
            if (field.stateAt(t) > 0 && field.treeOf(t) === undefined) continue;
            states[t] = paintable[t] === 1 ? base : 0;
            tris[n++] = t;
          }
          if (n > 0) viewer.updateTriangleStates(e.object, tris.subarray(0, n));
        }
        break;
      }
      case "palette": {
        const colors = project.palette.map((c) => c.color);
        scene.palette = colors;
        if (e.renumbered) {
          project.objects.forEach((_, i) => scene.objects[i].states.set(resolveViewStates(project, i)));
          viewer.refreshStates();
        }
        viewer.setPalette(colors);
        break;
      }
      case "history":
        break;
    }
  });
}
