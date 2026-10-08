// Stands in for the viewer: mirrors a project through change events only, so a test can
// check that the events alone are enough to keep a view exact.
import { expect } from "vitest";
import { resolveDisplayStates, resolveStatesInto, resolveTriangleState } from "../../src/doc/display";
import type { ProjectEvent } from "../../src/doc/events";
import type { Project } from "../../src/doc/project";

export class ViewerSim {
  readonly events: ProjectEvent[] = [];
  private shown: Uint16Array[];
  private colors: string[];
  private readonly unsubscribe: () => void;

  constructor(private readonly project: Project) {
    this.shown = project.objects.map((_, i) => resolveDisplayStates(project, i));
    this.colors = project.palette.map((c) => c.color);
    this.unsubscribe = project.subscribe((e) => {
      this.events.push(e);
      this.apply(e);
    });
  }

  private apply(e: ProjectEvent): void {
    const p = this.project;
    switch (e.kind) {
      case "paint":
        resolveStatesInto(p, e.object, e.tris, this.shown[e.object]);
        break;
      case "base":
        for (const pi of e.parts) {
          const part = p.objects[e.object].parts[pi];
          for (let t = part.firstTri; t < part.firstTri + part.triCount; t++) this.shown[e.object][t] = resolveTriangleState(p, e.object, t);
        }
        break;
      case "palette":
        this.colors = p.palette.map((c) => c.color);
        if (e.renumbered) this.shown = p.objects.map((_, i) => resolveDisplayStates(p, i));
        break;
      case "history":
        break;
    }
  }

  /** Forgets recorded events (keeps the mirrored view). */
  clear(): void {
    this.events.length = 0;
  }

  /** The mirrored view equals what a full rebuild from the project would show. */
  expectInSync(): void {
    this.project.objects.forEach((_, i) => expect(Array.from(this.shown[i])).toEqual(Array.from(resolveDisplayStates(this.project, i))));
    expect(this.colors).toEqual(this.project.palette.map((c) => c.color));
  }

  dispose(): void {
    this.unsubscribe();
  }
}
