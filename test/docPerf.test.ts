// Document-layer cost on a ~1.3M-triangle mesh (the size of the user's real objects).
// Opt-in: PERF=1 npx vitest run test/docPerf.test.ts
import { describe, expect, it } from "vitest";
import { createProject } from "../src/doc/project";
import { fromSnapshot, toSnapshot } from "../src/doc/snapshot";
import { parseStl } from "../src/formats/stl";
import { sphereStl } from "./support/fixtures";

const RINGS = 651, SEGMENTS = 1000; // 2 * 1000 * 650 = 1.3M triangles

describe.skipIf(!process.env.PERF)("1.3M-triangle object", () => {
  it("builds adjacency quickly and keeps edits and fills proportional to what they touch", () => {
    const rows: string[] = [];
    const time = <T>(label: string, fn: () => T): T => {
      const t0 = performance.now();
      const r = fn();
      const line = `${label}: ${(performance.now() - t0).toFixed(1)} ms`;
      rows.push(line);
      console.log(line);
      return r;
    };
    const stl = sphereStl(RINGS, SEGMENTS);
    const model = parseStl(stl, "sphere");
    expect(model.totalTris).toBe(2 * SEGMENTS * (RINGS - 1));
    const p = time("createProject", () => createProject(model));
    p.addColor("#336699"); // state 2
    const n = p.objects[0].triCount;
    const arrayBuffers0 = process.memoryUsage().arrayBuffers;

    const topo = time("topology build (adjacency + shells)", () => p.topology(0));
    const topologyMB = (process.memoryUsage().arrayBuffers - arrayBuffers0) / 1e6;
    console.log(`topology memory (array buffers): ${topologyMB.toFixed(0)} MB; stats ${JSON.stringify(topo.stats)}`);
    expect(topo.stats.shells).toBe(1);
    expect(topo.stats.boundaryEdges).toBe(0);
    expect(topo.stats.nonManifoldEdges).toBe(0);

    time("face normals (first smart fill only)", () => topo.faceNormals());
    const shell = time("shell fill (whole sphere)", () => p.shellFillRegion(0, 12345));
    expect(shell.length).toBe(n);
    const all1 = time("smart fill 30 deg, whole sphere (first call)", () => p.smartFillRegion(0, 12345, 30));
    expect(all1.length).toBe(n);
    time("smart fill 30 deg, whole sphere (again)", () => p.smartFillRegion(0, 54321, 30));
    const tiny = time("smart fill 0.1 deg (a quad)", () => p.smartFillRegion(0, 650100, 0.1));
    expect(tiny.length).toBeLessThanOrEqual(2);

    // A paint band around the equator bounds the fill to the northern cap.
    const band: number[] = [];
    for (let t = 0; t < n; t++) { const ring = Math.floor((t - 0) / (2 * SEGMENTS)); if (ring >= 300 && ring < 305) band.push(t); }
    time(`paintTriangles (${band.length} tris, a band)`, () => p.paintTriangles(0, band, 2));
    const cap = time("smart fill bounded by that band", () => p.smartFillRegion(0, 100, 30));
    console.log(`  northern cap: ${cap.length} triangles`);
    expect(cap.length).toBeGreaterThan(n / 4);
    expect(cap.length).toBeLessThan(n / 2);

    // Brush dabs near the north pole: the view passes the few thousand triangles near the cursor.
    const cand = Array.from({ length: 12000 }, (_, i) => i);
    const dab = (i: number) => p.paintSphere(0, [Math.cos(i / 8) * 0.4, Math.sin(i / 8) * 0.4, 9.99], 0.3, 1 + (i % 2), { candidates: cand });
    time("paintSphere, 12000 candidates", () => dab(0));
    p.beginStroke();
    let painted = 0;
    time("stroke of 200 dabs (12000 candidates each)", () => { for (let i = 1; i <= 200; i++) painted += dab(i); });
    console.log(`  triangle changes over the stroke: ${painted}`);
    time("endStroke (merge)", () => p.endStroke());
    time("undo stroke", () => p.undo());

    const whole = time("paintTriangles (all 1.3M)", () => p.paintTriangles(0, shell, 2));
    expect(whole).toBeGreaterThan(0);
    time("undo (1.3M triangles)", () => p.undo());
    time("redo (1.3M triangles)", () => p.redo());
    time("deleteColor (merge 2 into 1, 1.3M)", () => p.deleteColor(2, 1));
    time("undo deleteColor", () => p.undo());
    time("setBaseColor", () => p.setBaseColor(0, 0, 2));
    time("colorUsage", () => p.colorUsage());

    const snap = time("toSnapshot", () => toSnapshot(p));
    time("fromSnapshot (validated)", () => fromSnapshot(snap));
    console.log("\n" + rows.join("\n"));
  }, 120000);
});
