// Import and first-geometry cost on a ~1M-triangle mesh. Opt-in: PERF=1 npx vitest run test/perf.test.ts
import { describe, expect, it } from "vitest";
import { createProject } from "../src/doc/project";
import { parseStl } from "../src/formats/stl";
import { buildObjectGeometry, paletteToBytes, updateTriangleColors } from "../src/view/objectGeometry";
import { projectToScene } from "../src/view/projectScene";
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
    const bytes = paletteToBytes(scene.palette);
    const geo = time("buildObjectGeometry", () => buildObjectGeometry(scene.objects[0], bytes));
    expect(geo.slotCount).toBe(model.totalTris);
    const tris = Array.from({ length: 20000 }, (_, i) => i * 7);
    time("updateTriangleColors (20k tris)", () => updateTriangleColors(geo, scene.objects[0].states, tris, bytes));
    const total = performance.now() - t0;
    console.log(`total import + geometry: ${total.toFixed(0)} ms`);
    expect(total).toBeLessThan(20000);
  });
});
