// Sub-triangle paint survives export (spec Q12): a split brush line and a fill up to it on a plate of
// two big triangles are exported for PrusaSlicer, re-imported unchanged, and (opt-in) sliced by the
// installed PrusaSlicer CLI, which must print every color where the project shows it.
//   PRUSA_CLI="C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe" npx vitest run test/subtriangleExport.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zipAll } from "../src/core";
import { buildExport } from "../src/doc/export";
import { importProject } from "../src/doc/importProject";
import { createProject, type Project } from "../src/doc/project";
import { defaultExportSettings } from "../src/persist/exportSettings";
import { splitLimit } from "../src/tools/PaintController";
import { makeModel } from "./support/docFixtures";
import { extrusions } from "./support/gcode";

const SIZE = 60, HEIGHT = 3, RADIUS = 3;

/** A 60 x 60 x 3 mm box: its top is two triangles, (0,0) (60,0) (60,60) and (0,0) (60,60) (0,60). */
function plate(): Project {
  const v = [[0, 0, 0], [SIZE, 0, 0], [SIZE, SIZE, 0], [0, SIZE, 0], [0, 0, HEIGHT], [SIZE, 0, HEIGHT], [SIZE, SIZE, HEIGHT], [0, SIZE, HEIGHT]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const p = createProject(makeModel({ vertices: v.flat(), tris: f.flat() }, {
    filaments: [{ color: "#FFFFFF" }],
    parts: [{ firstTri: 0, triCount: 12, extruder: 1, type: "ModelPart", name: "plate" }],
  }));
  p.addColor("#FF0000"); // 2
  p.addColor("#0000FF"); // 3
  return p;
}

/** The top triangle under (x, y) and the point's barycentric coordinates in it. */
function onTop(x: number, y: number): { tri: number; bary: [number, number, number] } {
  return x >= y ? { tri: 2, bary: [1 - x / SIZE, (x - y) / SIZE, y / SIZE] } : { tri: 3, bary: [1 - y / SIZE, x / SIZE, (y - x) / SIZE] };
}

const shown = (p: Project, x: number, y: number) => { const s = onTop(x, y); return p.stateShownAt(0, s.tri, s.bary); };

/** A red line across the top at y = 25 + x / 6 (crossing both triangles and their shared diagonal), then blue up to it from (10, 5). */
function paint(p: Project) {
  const limit = splitLimit(RADIUS);
  for (let x = -RADIUS; x <= SIZE + RADIUS; x += RADIUS / 3) p.paintSphere(0, [x, 25 + x / 6, HEIGHT], RADIUS, 2, { split: { limit } });
  p.paintRegion(0, p.smartFillRegion(0, onTop(10, 5), 30), 3);
  expect(p.fields[0].treeOf(2)).toBeDefined(); // both top triangles are cut (the sides near the line's ends too)
  expect(p.fields[0].treeOf(3)).toBeDefined();
  expect(shown(p, 10, 5)).toBe(3);
  expect(shown(p, 30, 30)).toBe(2);
  expect(shown(p, 50, 50)).toBe(1);
}

async function exported(p: Project, target: "prusa" | "bambu" = "prusa") {
  const settings = defaultExportSettings();
  settings.target = target;
  settings.printerCount[target] = 3;
  settings.allowMix = false;
  settings.spools = settings.spools.map((s, i) => (i < 3 ? { ...s, color: p.palette[i + 1].color, on: true } : { ...s, on: false }));
  const result = buildExport(p, settings, { date: "2026-10-09" });
  return zipAll(result.entries);
}

/** Every 2 mm on the top, the state shown, skipping samples near the line's edges and the plate's rim. */
function samples(p: Project): { x: number; y: number; state: number }[] {
  const out: { x: number; y: number; state: number }[] = [];
  for (let y = 3; y <= SIZE - 3; y += 2) for (let x = 3; x <= SIZE - 3; x += 2) {
    const dist = Math.abs(y - (25 + x / 6)) / Math.hypot(1, 1 / 6);
    if (Math.abs(dist - RADIUS) < 1) continue;
    out.push({ x, y, state: shown(p, x, y) });
  }
  return out;
}

describe("sub-triangle paint in an export", () => {
  it("re-imports with the same pieces, for PrusaSlicer and Bambu Studio", async () => {
    const p = plate();
    paint(p);
    for (const target of ["prusa", "bambu"] as const) {
      const back = (await importProject(`plate_${target}.3mf`, await exported(p, target))).project;
      expect(new Map(back.fields[0].trees()), target).toEqual(new Map(p.fields[0].trees()));
      for (const s of samples(p)) expect(shown(back, s.x, s.y), `${target} at ${s.x}, ${s.y}`).toBe(s.state);
    }
  });

  it.skipIf(!process.env.PRUSA_CLI)("PrusaSlicer prints every color where the project shows it", async () => {
    const p = plate();
    paint(p);
    const dir = mkdtempSync(join(process.env.SPIKE_OUT ?? tmpdir(), "subtri-export-"));
    const file = join(dir, "plate_INDX.3mf"), gcodePath = join(dir, "plate.gcode");
    writeFileSync(file, await exported(p));
    execFileSync(process.env.PRUSA_CLI!, [
      "--export-gcode", "--output", gcodePath, "--center", "100,100",
      "--nozzle-diameter", "0.4,0.4,0.4", "--temperature", "215,215,215", "--first-layer-temperature", "215,215,215",
      "--filament-diameter", "1.75,1.75,1.75", "--extruder-offset", "0x0,0x0,0x0", "--retract-length", "0,0,0",
      "--layer-height", "0.2", "--first-layer-height", "0.2", "--top-solid-layers", "3", "--bottom-solid-layers", "3",
      "--perimeters", "1", "--no-wipe-tower", "--gcode-comments", file,
    ], { stdio: "pipe" });
    const moves = extrusions(readFileSync(gcodePath, "utf8"));
    const topZ = Math.max(...moves.map((m) => m.z));
    const top = moves.filter((m) => Math.abs(m.z - topZ) < 1e-6 && /infill/i.test(m.type));
    // Bed to model: the CLI centers the object's bounding box on 100,100.
    let n = 0, ok = 0;
    for (const m of top) {
      for (const f of [0.25, 0.5, 0.75]) {
        const x = m.a[0] + (m.b[0] - m.a[0]) * f - 70, y = m.a[1] + (m.b[1] - m.a[1]) * f - 70;
        if (x < 3 || y < 3 || x > SIZE - 3 || y > SIZE - 3) continue;
        const dist = Math.abs(y - (25 + x / 6)) / Math.hypot(1, 1 / 6);
        if (Math.abs(dist - RADIUS) < 1) continue;
        n++;
        if (shown(p, x, y) - 1 === m.tool) ok++;
      }
    }
    console.log(`top layer: ${top.length} infill lines, ${ok} of ${n} samples printed with the shown color`);
    expect(n).toBeGreaterThan(500);
    expect(ok / n).toBeGreaterThan(0.99);
  }, 120_000);
});
