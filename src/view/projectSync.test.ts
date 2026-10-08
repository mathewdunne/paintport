import { describe, expect, it } from "vitest";
import { createProject, type Project } from "../doc/project";
import { resolveDisplayStates } from "../doc/display";
import { cubeMesh, leaf, makeModel } from "../../test/support/docFixtures";
import { syncViewerToProject, type ColorTarget } from "./projectSync";
import { projectToScene } from "./projectScene";

function setup() {
  const paints = Array.from({ length: 12 }, (_, t) => (t < 4 ? leaf(1) : t < 6 ? leaf(2) : null));
  const project = createProject(makeModel(cubeMesh(), { paints, filaments: [{ color: "#FF0000" }, { color: "#00FF00" }] }));
  const scene = projectToScene(project);
  const calls: string[] = [];
  const target: ColorTarget = {
    updateTriangleColors: (o, tris) => calls.push(`tris ${o} [${Array.from(tris).join(",")}]`),
    setPalette: (palette, changed) => calls.push(`palette ${palette.join(",")} ${changed === "all" ? "all" : `[${changed.join(",")}]`}`),
  };
  const unsubscribe = syncViewerToProject(project, scene, target);
  return { project, scene, calls, unsubscribe };
}

function expectInSync(project: Project, scene: ReturnType<typeof projectToScene>) {
  project.objects.forEach((_, i) => expect(Array.from(scene.objects[i].states)).toEqual(Array.from(resolveDisplayStates(project, i))));
  expect(scene.palette).toEqual(project.palette.map((c) => c.color));
}

describe("syncViewerToProject", () => {
  it("recolors only the painted triangles, and again on undo and redo", () => {
    const { project, scene, calls } = setup();
    project.paintTriangles(0, [6, 7], 2);
    expect(calls).toEqual(["tris 0 [6,7]"]);
    expectInSync(project, scene);
    calls.length = 0;
    project.undo();
    expect(calls).toEqual(["tris 0 [6,7]"]);
    expectInSync(project, scene);
    project.redo();
    expectInSync(project, scene);
  });

  it("one event per dab inside a stroke, one undo step for the lot", () => {
    const { project, scene, calls } = setup();
    project.beginStroke();
    project.paintTriangles(0, [6], 2);
    project.paintTriangles(0, [7], 2);
    project.endStroke();
    expect(calls).toEqual(["tris 0 [6]", "tris 0 [7]"]);
    expect(project.undoCount).toBe(1);
    project.undo();
    expectInSync(project, scene);
  });

  it("recolors the unpainted triangles of a part whose base color changed", () => {
    const { project, scene, calls } = setup();
    project.setObjectBaseColor(0, 2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^tris 0 \[0,1,2,3,4,5,6,7,8,9,10,11\]$/);
    expectInSync(project, scene);
  });

  it("rewrites the color table and names the changed states on a recolor", () => {
    const { project, scene, calls } = setup();
    expect(project.setColor(1, "#112233")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/#112233,#00FF00 \[1\]$/);
    expectInSync(project, scene);
    project.undo();
    expectInSync(project, scene);
  });

  it("re-resolves everything when colors are merged and renumbered, and on its undo", () => {
    const { project, scene, calls } = setup();
    project.deleteColor(1, 2);
    expect(calls.at(-1)).toMatch(/ all$/);
    expectInSync(project, scene);
    project.undo();
    expectInSync(project, scene);
    project.redo();
    expectInSync(project, scene);
  });

  it("stops after unsubscribing", () => {
    const { project, calls, unsubscribe } = setup();
    unsubscribe();
    project.paintTriangles(0, [6], 2);
    expect(calls).toEqual([]);
  });
});
