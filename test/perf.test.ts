// Import and first-geometry cost on a ~1M-triangle mesh. Opt-in: PERF=1 npx vitest run test/perf.test.ts
import { describe, expect, it } from "vitest";
import { createProject } from "../src/doc/project";
import { parseStl } from "../src/formats/stl";
import type { BufferAttribute } from "three";
import { ColorSurface } from "../src/view/colorSurface";
import { buildObjectGeometry, rebuildStates, updateTriangleStates } from "../src/view/objectGeometry";
import { projectToScene } from "../src/view/projectScene";
import { syncViewerToProject } from "../src/view/projectSync";
import { sphereStl } from "./support/fixtures";

const RINGS = 501, SEGMENTS = 1000; // 2 * 1000 * 500 = 1M triangles

describe.skipIf(!process.env.PERF)("large mesh (~1M triangles)", () => {
  it("imports and builds render geometry in reasonable time", () => {
    const time = <T>(label: string, fn: () => T): T => {
      const t0 = performance.now();
      const r = fn();
      console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
      return r;
    };
    const stl = time("generate STL", () => sphereStl(RINGS, SEGMENTS));
    console.log(`STL size: ${(stl.length / 1e6).toFixed(1)} MB`);
    const t0 = performance.now();
    const model = time("parseStl (weld)", () => parseStl(stl, "sphere"));
    expect(model.totalTris).toBe(2 * SEGMENTS * (RINGS - 1));
    // A closed UV sphere: V = F / 2 + 2 once welded.
    expect(model.objects[0].vertices.length / 3).toBe(SEGMENTS * (RINGS - 1) + 2);
    const project = time("createProject", () => createProject(model));
    const scene = time("projectToScene", () => projectToScene(project));
    const geo = time("buildObjectGeometry", () => buildObjectGeometry(scene.objects[0]));
    expect(geo.slotCount).toBe(model.totalTris);
    const tris = Array.from({ length: 20000 }, (_, i) => i * 7);
    time("updateTriangleStates (20k tris)", () => updateTriangleStates(geo, scene.objects[0].states, tris));
    time("rebuildStates (all)", () => rebuildStates(geo, scene.objects[0].states));

    // A palette color edit reaches the viewer as a color table upload only: no per-triangle work.
    const surface = new ColorSurface();
    surface.setScene(scene);
    surface.add(0, geo);
    syncViewerToProject(project, scene, surface);
    const state = geo.geometry.getAttribute("state") as BufferAttribute;
    const stateVersion = state.version, tableVersion = surface.table.texture.version;
    const edits = 200;
    const t1 = performance.now();
    for (let i = 0; i < edits; i++) project.setColor(1, "#" + (0x100000 + i * 997).toString(16));
    const perEdit = (performance.now() - t1) / edits;
    console.log(`palette color edit incl. sync (${model.totalTris} tris): ${perEdit.toFixed(3)} ms`);
    expect(state.version).toBe(stateVersion); // no attribute write
    expect(surface.table.texture.version).toBeGreaterThanOrEqual(tableVersion + edits);
    expect(perEdit).toBeLessThan(1);
    const total = performance.now() - t0;
    console.log(`total import + geometry: ${total.toFixed(0)} ms`);
    expect(total).toBeLessThan(20000);
  });
});
