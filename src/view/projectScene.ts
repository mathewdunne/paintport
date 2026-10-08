import { printSurfaceMask, resolveDisplayStates } from "../doc/display";
import type { Project } from "../doc/project";
import type { ViewScene } from "./viewScene";

/** Snapshot of a project for the viewer. */
export function projectToScene(project: Project): ViewScene {
  return {
    palette: project.palette.map((c) => c.color),
    // Geometry comes from the paint field's mesh, which a finer-grained field may replace.
    objects: project.objects.map((o, i) => ({
      vertices: project.fields[i].mesh.vertices,
      tris: project.fields[i].mesh.tris,
      transform: o.transform,
      states: resolveDisplayStates(project, i),
      mask: printSurfaceMask(project, i),
    })),
  };
}
