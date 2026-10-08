// Opt-in check against a real PrusaSlicer 2.9.x ColorMix project (Core One INDX 4T).
//   REAL_3MF=D:\Downloads\goldfish_colormix_4t.3mf npx vitest run test/prusaRealFile.test.ts
// Skipped when REAL_3MF is unset. The file is read in place and never copied into the repo.
// Expected values come from the file's own metadata (Slic3r_PE.config, full_spectrum.json,
// Slic3r_PE_model.config), as inspected when the importer was written.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { load3MF } from "../src/core";
import { createProject } from "../src/doc/project";

const path = process.env.REAL_3MF;

// id -> [color as stored in the JSON, recipe]
const VIRTUAL: Record<number, [string, [number, number][]]> = {
  5: ["#30f845", [[1, 0.5], [3, 0.5]]],
  6: ["#9dfa00", [[1, 0.25], [3, 0.75]]],
  7: ["#00faa1", [[1, 0.75], [3, 0.25]]],
  8: ["#e90048", [[2, 0.75], [3, 0.25]]],
  9: ["#e44e1a", [[2, 0.5], [3, 0.5]]],
  10: ["#ee9d00", [[2, 0.25], [3, 0.75]]],
  11: ["#965661", [[1, 0.25], [2, 0.5], [3, 0.25]]],
  12: ["#00a0d1", [[1, 0.75], [2, 0.25]]],
  13: ["#5353a0", [[1, 0.5], [2, 0.5]]],
  14: ["#9a1a8c", [[1, 0.25], [2, 0.75]]],
};

describe.skipIf(!path)("real PrusaSlicer project (REAL_3MF)", () => {
  it("imports colors, ColorMix recipes and base extruders", async () => {
    const bytes = readFileSync(path!);
    const t0 = performance.now();
    const model = await load3MF(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const loadMs = performance.now() - t0;
    const rssMb = process.resourceUsage().maxRSS / 1024; // KB on every platform Node supports
    console.log(`load3MF: ${(loadMs / 1000).toFixed(1)} s, ${(bytes.length / 1e6).toFixed(0)} MB archive, ${model.totalTris} ModelPart triangles, peak RSS ${rssMb.toFixed(0)} MB`);
    console.log(`used states ${model.usedExtruders.join(",")}; unpainted ${model.unpainted}; base per filament ${model.filaments.map((f) => f.baseTris).join(",")}`);
    expect(model.paintDialect).toBe("prusa");
    expect(model.objects).toHaveLength(2);
    for (const o of model.objects) {
      expect(o.name).toBe("goldfish");
      expect(o.defaultExtruder).toBe(4);
      expect(o.parts).toHaveLength(1);
      expect(o.parts[0]).toMatchObject({ firstTri: 0, extruder: 4, type: "ModelPart", name: "goldfish" });
      expect(o.parts[0].triCount).toBe(o.tris.length / 3);
    }

    expect(model.filaments).toHaveLength(14);
    ["#00FFFF", "#FF0080", "#FFFF00", "#FFFFFF"].forEach((color, i) => {
      expect(model.filaments[i], `filament ${i + 1}`).toMatchObject({ index: i + 1, color, colorKnown: true });
      expect(model.filaments[i]).not.toHaveProperty("mix");
    });
    for (let id = 5; id <= 14; id++) {
      const [color, recipe] = VIRTUAL[id];
      expect(model.filaments[id - 1], `filament ${id}`).toMatchObject({
        index: id, color: color.toUpperCase(), colorKnown: true,
        mix: recipe.map(([extruder, ratio]) => ({ extruder, ratio })),
      });
    }
    expect(model.filaments[3].isDefaultOf).toBe(2);
    expect(model.specialVolumes).toBe(0);

    // The design palette uses the known colors, with the recipes as hints.
    const project = createProject(model);
    expect(project.palette).toHaveLength(15);
    expect(project.palette[5]).toEqual({ color: "#30F845", mix: [{ extruder: 1, ratio: 0.5 }, { extruder: 3, ratio: 0.5 }] });
    expect([...project.baseColor.values()]).toEqual([4, 4]);
  }, 600_000);
});
