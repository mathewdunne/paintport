// Opt-in check of the palette print picker (spec Q13) against a real full-spectrum palette:
// every virtual extruder part becomes a dot with the file's recipe, the base plate is the backdrop.
//   PALETTE_3MF="D:/3D Objects/FullSpectrumPallette.3mf" npx vitest run test/paletteRealFile.test.ts
// Skipped when PALETTE_3MF is unset. The file is read in place and never copied into the repo.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { load3MF, unzipAll } from "../src/core";
import { dotChoice, paletteFromModel } from "../src/doc/palettePrint";

const path = process.env.PALETTE_3MF;

interface FsJson {
  physical_extruders: { id: number; color: string }[];
  virtual_extruders: { id: number; color: string; components: { extruder: number; ratio: number }[] }[];
}

describe.skipIf(!path)("real palette print (PALETTE_3MF)", () => {
  it("has a dot per part with the file's recipes and colors, on a backdrop", async () => {
    const bytes = new Uint8Array(readFileSync(path!));
    const model = await load3MF(bytes);
    const json = JSON.parse(new TextDecoder().decode((await unzipAll(bytes)).get("Metadata/Prusa_Slicer_full_spectrum.json"))) as FsJson;
    const palette = paletteFromModel(model, "palette")!;
    const backdrops = palette.dots.filter((d) => d.backdrop);
    const parts = model.objects.flatMap((o) => o.parts.filter((p) => p.type === "ModelPart"));
    console.log(`${palette.dots.length} dots from ${parts.length} parts, ${backdrops.length} backdrop(s): ${backdrops.map((d) => d.name).join(", ")}`);
    expect(backdrops).toHaveLength(1);
    expect(palette.dots).toHaveLength(parts.length);

    const physical = new Map(json.physical_extruders.map((p) => [p.id, p.color.toUpperCase()]));
    const spools = json.physical_extruders.map((p) => ({ slot: p.id, color: p.color.toUpperCase() }));
    let blends = 0;
    for (const [i, part] of parts.entries()) {
      const dot = palette.dots[i];
      const virtual = json.virtual_extruders.find((v) => v.id === part.extruder);
      if (!virtual) {
        expect(dot.ingredients, dot.name).toEqual([{ color: physical.get(part.extruder), weight: 1 }]);
        continue;
      }
      blends++;
      expect(dot.color, dot.name).toBe(virtual.color.toUpperCase());
      const sum = virtual.components.reduce((s, c) => s + c.ratio, 0);
      expect(dot.ingredients, dot.name).toEqual(virtual.components.map((c) => ({ color: physical.get(c.extruder), weight: Math.round((100 * c.ratio) / sum) })));
      // With the file's own spools every blend dot pins a blend of those extruders.
      const choice = dotChoice(dot, spools, true);
      expect(choice.kind === "pin" && choice.pin.kind === "blend" && choice.pin.components.map((c) => c.slot), dot.name)
        .toEqual([...new Set(virtual.components.map((c) => c.extruder))].sort((a, b) => a - b));
    }
    expect(blends).toBe(json.virtual_extruders.length);
  }, 120_000);
});
