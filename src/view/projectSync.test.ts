import type { BufferAttribute } from "three";
import { describe, expect, it } from "vitest";
import { createProject, type Project } from "../doc/project";
import { resolveDisplayStates } from "../doc/display";
import { cubeMesh, leaf, makeModel } from "../../test/support/docFixtures";
import { ColorSurface } from "./colorSurface";
import { buildObjectGeometry, setTriangleHighlight, type ObjectGeometry } from "./objectGeometry";
import { syncViewerToProject, type SyncTarget } from "./projectSync";
import { walkAtlas } from "./treeAtlas";
import { projectToScene } from "./projectScene";
import type { ViewScene } from "./viewScene";

const PART = { type: "ModelPart" as const, name: null };

function setup() {
  const paints = Array.from({ length: 12 }, (_, t) => (t < 4 ? leaf(1) : t < 6 ? leaf(2) : null));
  const project = createProject(makeModel(cubeMesh(), { paints, filaments: [{ color: "#FF0000" }, { color: "#00FF00" }] }));
  const scene = projectToScene(project);
  const calls: string[] = [];
  const target: SyncTarget = {
    updateTriangleStates: (o, tris) => calls.push(`tris ${o} [${Array.from(tris).join(",")}]`),
    refreshStates: () => calls.push("refresh"),
    setPalette: (palette) => calls.push(`palette ${palette.join(",")}`),
  };
  const unsubscribe = syncViewerToProject(project, scene, target);
  return { project, scene, calls, unsubscribe };
}

function expectInSync(project: Project, scene: ViewScene) {
  project.objects.forEach((_, i) => expect(Array.from(scene.objects[i].states)).toEqual(Array.from(resolveDisplayStates(project, i))));
  expect(scene.palette).toEqual(project.palette.map((c) => c.color));
}

describe("syncViewerToProject", () => {
  it("rewrites only the painted triangles, and again on undo and redo", () => {
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

  it("rewrites only the unpainted triangles of a part whose base color changed", () => {
    const { project, scene, calls } = setup();
    project.setObjectBaseColor(0, 2);
    expect(calls).toEqual(["tris 0 [6,7,8,9,10,11]"]); // 0..5 are painted and show their own state
    expectInSync(project, scene);
  });

  it("writes nothing when every triangle of the part is painted", () => {
    const paints = Array.from({ length: 12 }, () => leaf(1));
    const project = createProject(makeModel(cubeMesh(), { paints, filaments: [{ color: "#FF0000" }, { color: "#00FF00" }] }));
    const unused = project.addColor("#0000FF"); // a base color no triangle shows
    const calls: string[] = [];
    syncViewerToProject(project, projectToScene(project), {
      updateTriangleStates: (o, tris) => calls.push(`tris ${o} [${Array.from(tris)}]`),
      refreshStates: () => calls.push("refresh"),
      setPalette: () => calls.push("palette"),
    });
    project.setObjectBaseColor(0, unused);
    expect(calls).toEqual([]);
  });

  it("installs the new colors and nothing else on a recolor", () => {
    const { project, scene, calls } = setup();
    expect(project.setColor(1, "#112233")).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/#112233,#00FF00$/);
    expectInSync(project, scene);
    project.undo();
    expectInSync(project, scene);
  });

  it("re-resolves everything when colors are merged and renumbered, and on its undo", () => {
    const { project, scene, calls } = setup();
    project.deleteColor(1, 2);
    expect(calls[0]).toBe("refresh");
    expect(calls[1]).toMatch(/^palette /);
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

/** The viewer's real color path (`ColorSurface`, which `ModelViewer` delegates to) over built geometry, minus WebGL. */
function realTarget(scene: ViewScene) {
  const surface = new ColorSurface();
  surface.setScene(scene);
  const geos: ObjectGeometry[] = scene.objects.map((o) => buildObjectGeometry(o));
  geos.forEach((g, i) => surface.add(i, g));
  const table = surface.table;
  const target: SyncTarget = surface;
  const attr = (o: number) => geos[o].geometry.getAttribute("state") as BufferAttribute;
  /** The color the table gives each drawn triangle (read at its first vertex). */
  const shown = (o: number): string[] => {
    const { data } = table.texture.image as { data: Uint8Array };
    const out: string[] = [];
    for (let v = 0; v < geos[o].vertexStates.length; v += 3) {
      const t = geos[o].vertexStates[v] * 4;
      out.push("#" + [data[t], data[t + 1], data[t + 2]].map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase());
    }
    return out;
  };
  return { table, geos, target, attr, shown };
}

// Two parts of 6 triangles: part 0 has base 1 and paint 1 on triangle 0, part 1 has base 2 and paint 1 on triangle 7.
function twoPartProject() {
  const paints = Array.from({ length: 12 }, (_, t) => (t === 0 || t === 7 ? leaf(1) : null));
  const project = createProject(makeModel(cubeMesh(), {
    paints,
    filaments: [{ color: "#FF0000" }, { color: "#00FF00" }],
    parts: [{ firstTri: 0, triCount: 6, extruder: 1, ...PART }, { firstTri: 6, triCount: 6, extruder: 2, ...PART }],
  }));
  project.addColor("#0000FF"); // state 3, unused so far
  return project;
}

describe("sub-triangle trees", () => {
  // A 10 x 10 mm quad of two triangles, one part with base color 1.
  function quadProject() {
    const project = createProject(makeModel({ vertices: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], tris: [0, 1, 2, 0, 2, 3] }, {
      filaments: [{ color: "#FF0000" }, { color: "#00FF00" }],
      parts: [{ firstTri: 0, triCount: 2, extruder: 1, ...PART }],
    }));
    project.addColor("#00FF00"); // state 2
    project.addColor("#0000FF"); // state 3
    return project;
  }

  it("draws a split triangle from the atlas, with the part base in its state attribute", () => {
    const project = quadProject();
    project.paintSphere(0, [8, 2, 0], 1.5, 2, { split: { limit: 0.5 } });
    const scene = projectToScene(project);
    const { geos, surface } = realSurface(scene);
    expect(Array.from(geos[0].vertexStates)).toEqual([1, 1, 1, 1, 1, 1]);
    const root = geos[0].treeRoots[0];
    expect(root).toBeGreaterThan(0);
    expect(Array.from(geos[0].treeRoots.slice(0, 3))).toEqual([root, root, root]);
    expect(Array.from(geos[0].treeRoots.slice(3))).toEqual([0, 0, 0]);
    const word = walkAtlas(surface.atlas.words, root - 1, [1 - 0.8, 0.6, 0.2]); // (8, 2) in triangle 0
    expect(word & 0xffff).toBe(2);
  });

  it("follows brush dabs, a whole repaint, undo and a base change", () => {
    const project = quadProject();
    const scene = projectToScene(project);
    const { geos, surface } = realSurface(scene);
    syncViewerToProject(project, scene, surface);
    project.paintSphere(0, [8, 2, 0], 1.5, 2, { split: { limit: 0.5 } });
    expect(geos[0].treeRoots[0]).toBeGreaterThan(0);
    expect(geos[0].vertexStates[0]).toBe(1);
    project.paintTriangles(0, [0], 3);
    expect(geos[0].treeRoots[0]).toBe(0);
    expect(geos[0].vertexStates[0]).toBe(3);
    project.undo();
    expect(geos[0].treeRoots[0]).toBeGreaterThan(0);
    expect(geos[0].vertexStates[0]).toBe(1);
    project.setObjectBaseColor(0, 3);
    expect(geos[0].vertexStates[0]).toBe(3); // the split triangle's unpainted pieces follow the base
    expect(geos[0].vertexStates[3]).toBe(3);
  });

  it("re-flattens every tree when colors are renumbered", () => {
    const project = quadProject();
    project.paintSphere(0, [8, 2, 0], 1.5, 3, { split: { limit: 0.5 } });
    const scene = projectToScene(project);
    const { geos, surface } = realSurface(scene);
    syncViewerToProject(project, scene, surface);
    project.deleteColor(2, 1); // state 3 becomes 2
    const word = walkAtlas(surface.atlas.words, geos[0].treeRoots[0] - 1, [0.2, 0.6, 0.2]);
    expect(word & 0xffff).toBe(2);
  });
});

function realSurface(scene: ViewScene) {
  const surface = new ColorSurface();
  surface.setScene(scene);
  const geos = scene.objects.map((o) => buildObjectGeometry(o));
  geos.forEach((g, i) => surface.add(i, g));
  return { surface, geos };
}

describe("viewer color path", () => {
  it("a palette color edit uploads the table and writes no attribute", () => {
    const project = twoPartProject();
    const scene = projectToScene(project);
    const { table, target, attr, geos } = realTarget(scene);
    syncViewerToProject(project, scene, target);
    const version = attr(0).version, states = Array.from(geos[0].vertexStates), tableVersion = table.texture.version;
    project.setColor(1, "#112233");
    expect(attr(0).version).toBe(version);
    expect(attr(0).updateRanges).toEqual([]);
    expect(Array.from(geos[0].vertexStates)).toEqual(states);
    expect(table.texture.version).toBeGreaterThan(tableVersion);
    const data = table.texture.image.data as Uint8Array;
    expect(Array.from(data.slice(4, 8))).toEqual([0x11, 0x22, 0x33, 255]);
    project.undo();
    expect(attr(0).version).toBe(version);
    expect(Array.from(data.slice(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it("adding a color writes no attribute either", () => {
    const project = twoPartProject();
    const scene = projectToScene(project);
    const { target, attr } = realTarget(scene);
    syncViewerToProject(project, scene, target);
    const version = attr(0).version;
    project.addColor("#ABCDEF");
    expect(attr(0).version).toBe(version);
  });

  it("switching to Print colors and back changes the table only", () => {
    const project = twoPartProject();
    const scene = projectToScene(project);
    const { table, attr, geos, shown } = realTarget(scene);
    const version = attr(0).version, states = Array.from(geos[0].vertexStates), tableVersion = table.texture.version;
    const design = shown(0);
    table.setPrint([undefined, "#101010", undefined, "#202020"]);
    expect(attr(0).version).toBe(version);
    expect(Array.from(geos[0].vertexStates)).toEqual(states);
    expect(table.texture.version).toBeGreaterThan(tableVersion);
    expect(shown(0)[0]).toBe("#101010"); // state 1 has a print color
    expect(shown(0)[6]).toBe(design[6]); // state 2 has none: keeps its design color
    table.setPrint(null);
    expect(shown(0)).toEqual(design);
  });

  it("a part's base change rewrites only that part's unpainted triangles", () => {
    const project = twoPartProject();
    const scene = projectToScene(project);
    const { target, attr, geos, shown } = realTarget(scene);
    syncViewerToProject(project, scene, target);
    const R = "#FF0000", G = "#00FF00", B = "#0000FF";
    expect(shown(0)).toEqual([R, R, R, R, R, R, G, R, G, G, G, G]);
    project.setBaseColor(0, 1, 3);
    // Triangle 7 is painted, so the run 6 and the run 8..11 are written, not 6..11.
    expect(attr(0).updateRanges).toEqual([{ start: 6 * 3, count: 3 }, { start: 8 * 3, count: 4 * 3 }]);
    expect(shown(0)).toEqual([R, R, R, R, R, R, B, R, B, B, B, B]);
    expect(Array.from(geos[0].vertexStates.slice(0, 18))).toEqual(Array(18).fill(1)); // part 0 untouched
    expectInSync(project, scene);
  });

  it("renumbering rewrites the whole attribute and the table, and undo restores both", () => {
    const project = twoPartProject();
    const scene = projectToScene(project);
    const { table, target, attr, shown } = realTarget(scene);
    syncViewerToProject(project, scene, target);
    const before = shown(0);
    const version = attr(0).version, tableVersion = table.texture.version;
    project.deleteColor(1, 3); // state 1 merges into 3; 2 and 3 become 1 and 2
    expect(attr(0).version).toBeGreaterThan(version);
    expect(attr(0).updateRanges).toEqual([{ start: 0, count: 12 * 3 }]);
    expect(table.texture.version).toBeGreaterThan(tableVersion);
    expectInSync(project, scene);
    expect(shown(0)[0]).toBe("#0000FF"); // triangle 0 was painted 1, now merged into the blue
    project.undo();
    expect(shown(0)).toEqual(before);
  });

  it("a fill preview does not disturb the states, and clearing it restores them", () => {
    const project = twoPartProject();
    const scene = projectToScene(project);
    const { target, attr, geos, shown } = realTarget(scene);
    syncViewerToProject(project, scene, target);
    const before = shown(0);
    const state = Array.from(geos[0].vertexStates);
    setTriangleHighlight(geos[0], [0, 1, 2], true);
    expect(Array.from(geos[0].vertexStates)).toEqual(state);
    project.paintTriangles(0, [8], 3); // a paint while the preview is up
    setTriangleHighlight(geos[0], [0, 1, 2], false);
    expect(shown(0)[8]).toBe("#0000FF");
    expect(shown(0).filter((_, i) => i !== 8)).toEqual(before.filter((_, i) => i !== 8));
    expect(attr(0).updateRanges.some((r) => r.start === 8 * 3 && r.count === 3)).toBe(true);
    expect(Array.from(geos[0].highlight)).toEqual(Array(36).fill(0));
  });

  it("handles a palette that grows past 256 colors", () => {
    const project = twoPartProject();
    const scene = projectToScene(project);
    const { table, target, attr, shown } = realTarget(scene);
    syncViewerToProject(project, scene, target);
    for (let i = 0; i < 300; i++) project.addColor("#" + (0x100000 + i).toString(16));
    expect(table.texture.image.height).toBe(2);
    const last = project.palette.length - 1;
    expect(last).toBeGreaterThan(256);
    project.paintTriangles(0, [3], last);
    expect(Array.from(attr(0).array.slice(9, 12))).toEqual([last, last, last]);
    expect(shown(0)[3]).toBe(project.palette[last].color);
    project.setColor(last, "#FEDCBA");
    expect(shown(0)[3]).toBe("#FEDCBA");
  });
});
