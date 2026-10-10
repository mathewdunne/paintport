// ColorMix ratios in an export (spec 3.2): we write integer weights (17:3), PrusaSlicer's own
// projects store fractions that sum to 1 (0.85, 0.15). Opt-in: the installed PrusaSlicer CLI
// slices a box printed with one blend in both forms; both must give the same layer pattern,
// and the tool shares must follow the recipe.
//   PRUSA_CLI="C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe" npx vitest run test/colormixRatio.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zipAll } from "../src/core";
import { buildExport } from "../src/doc/export";
import { createProject } from "../src/doc/project";
import { defaultExportSettings } from "../src/persist/exportSettings";
import { makeModel } from "./support/docFixtures";
import { extrusions } from "./support/gcode";

const SIZE = 20, HEIGHT = 8, COLORS = ["#FF0000", "#0000FF", "#00FF00"];
const FULL_SPECTRUM = "Metadata/Prusa_Slicer_full_spectrum.json";

interface FsComponent { extruder: number; ratio: number }
interface FsJson { virtual_extruders: { components: FsComponent[] }[] }

/** A 20 x 20 x 8 mm box whose part is printed with the blend `recipe` ([slot, weight] pairs, slots ascending). */
function exportBox(recipe: [number, number][]) {
  const v = [[0, 0, 0], [SIZE, 0, 0], [SIZE, SIZE, 0], [0, SIZE, 0], [0, 0, HEIGHT], [SIZE, 0, HEIGHT], [SIZE, SIZE, HEIGHT], [0, SIZE, HEIGHT]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const p = createProject(makeModel({ vertices: v.flat(), tris: f.flat() }, { filaments: COLORS.map((color) => ({ color })) }));
  const state = p.addColor("#808080");
  p.setBaseColor(0, 0, state);
  p.setPin(state, { kind: "blend", components: recipe.map(([slot, ratio]) => ({ slot, ratio })) });
  const settings = defaultExportSettings();
  settings.target = "prusa";
  settings.printerCount.prusa = COLORS.length;
  settings.allowMix = true;
  settings.spools = settings.spools.map((s, i) => (i < COLORS.length ? { ...s, color: COLORS[i], on: true } : { ...s, on: false }));
  return buildExport(p, settings, { date: "2026-10-10" }).entries;
}

/** The export with the full-spectrum ratios rewritten as fractions that sum to 1, as PrusaSlicer saves them. */
function asFractions(entries: ReturnType<typeof exportBox>) {
  return entries.map((e) => {
    if (e.name !== FULL_SPECTRUM) return e;
    const json = JSON.parse(new TextDecoder().decode(e.data)) as FsJson;
    for (const ve of json.virtual_extruders) {
      const sum = ve.components.reduce((s, c) => s + c.ratio, 0);
      for (const c of ve.components) c.ratio /= sum;
    }
    return { ...e, data: new TextEncoder().encode(JSON.stringify(json, null, 4)) };
  });
}

/** Slices `entries` and returns the tools of each layer (in layer order) and each tool's share of the extruded path. */
async function slice(entries: ReturnType<typeof exportBox>, dir: string, name: string) {
  const file = join(dir, `${name}.3mf`), gcodePath = join(dir, `${name}.gcode`);
  writeFileSync(file, await zipAll(entries));
  const n = COLORS.length, list = (x: string) => Array(n).fill(x).join(",");
  execFileSync(process.env.PRUSA_CLI!, [
    "--export-gcode", "--output", gcodePath, "--center", "100,100",
    "--nozzle-diameter", list("0.4"), "--temperature", list("215"), "--first-layer-temperature", list("215"),
    "--filament-diameter", list("1.75"), "--extruder-offset", list("0x0"), "--retract-length", list("0"),
    "--layer-height", "0.2", "--first-layer-height", "0.2", "--no-wipe-tower", "--gcode-comments", file,
  ], { stdio: "pipe" });
  const length = new Map<number, number>(), layers = new Map<number, Set<number>>();
  for (const m of extrusions(readFileSync(gcodePath, "utf8"))) {
    length.set(m.tool, (length.get(m.tool) ?? 0) + Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]));
    if (!layers.has(m.z)) layers.set(m.z, new Set());
    layers.get(m.z)!.add(m.tool);
  }
  const total = [...length.values()].reduce((s, l) => s + l, 0);
  return {
    pattern: [...layers].sort((a, b) => a[0] - b[0]).map(([, tools]) => [...tools].sort().join("+")),
    share: (tool: number) => (length.get(tool) ?? 0) / total,
  };
}

describe.skipIf(!process.env.PRUSA_CLI)("ColorMix ratios in PrusaSlicer", () => {
  // 85/15, 50/50 and 35/50/15 from a real full-spectrum palette; PrusaSlicer cycles whole layers.
  const recipes: [number, number][][] = [[[1, 17], [2, 3]], [[1, 1], [2, 1]], [[1, 7], [2, 10], [3, 3]]];
  it.each(recipes.map((r) => [r]))("integer weights print like PrusaSlicer's fractions: %j", async (recipe) => {
    const dir = mkdtempSync(join(tmpdir(), "colormix-ratio-"));
    const entries = exportBox(recipe);
    const json = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === FULL_SPECTRUM)!.data)) as FsJson;
    expect(json.virtual_extruders[0].components).toEqual(recipe.map(([extruder, ratio]) => ({ extruder, ratio })));
    const integer = await slice(entries, dir, "integer");
    const fraction = await slice(asFractions(entries), dir, "fraction");
    expect(integer.pattern).toEqual(fraction.pattern);
    const sum = recipe.reduce((s, [, r]) => s + r, 0);
    for (const [slot, ratio] of recipe) expect(Math.abs(integer.share(slot - 1) - ratio / sum), `slot ${slot}`).toBeLessThan(0.05);
  }, 120_000);
});
