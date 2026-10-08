import { describe, expect, it } from "vitest";
import { deltaE, emitPaintTree, load3MF, zipAll, type Model, type PaintNode } from "../core";
import { binaryStl, CUBE_TRIS } from "../../test/support/fixtures";
import { archive, FULL_SPECTRUM, modelConfig, PE_CONFIG, PE_MODEL, peConfig } from "../../test/support/prusaArchive";
import { parseStl } from "../formats/stl";

import { printSurfaceMask, resolveDisplayStates, resolveTriangleState } from "./display";
import { createProject, partId } from "./project";
import { isSplitTree } from "./paintTree";
import { TrianglePaintField } from "./trianglePaintField";

const enc = new TextEncoder();
const leaf = (state: number) => emitPaintTree({ state }, "bbs");
const split: PaintNode = { splitSides: 1, special: 0, children: [{ state: 1 }, { state: 2 }] };

/**
 * A 3MF with five triangles on one object whose base extruder is 2:
 * tri 0 unpainted, 1 leaf state 1, 2 leaf state 3, 3 split tree (states 1/2), 4 painted 0.
 * The file defines only two filament colors.
 */
async function paintedModel(): Promise<Model> {
  const paints = [
    "",
    `paint_color="${leaf(1)}"`,
    `paint_color="${leaf(3)}"`,
    `paint_color="${emitPaintTree(split, "bbs")}"`,
    `paint_color="${leaf(0)}"`,
  ];
  const model = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="Fig &amp; Co"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles>${paints.map((p) => `<triangle v1="0" v2="1" v3="2" ${p}/>`).join("")}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const settings = `<config><object id="1"><metadata key="name" value="Fig"/><metadata key="extruder" value="2"/></object></config>`;
  const project = JSON.stringify({ filament_colour: ["#ff0000", "#00ff00"] });
  return load3MF(await zipAll([
    { name: "3D/3dmodel.model", data: enc.encode(model) },
    { name: "Metadata/model_settings.config", data: enc.encode(settings) },
    { name: "Metadata/project_settings.config", data: enc.encode(project) },
  ]));
}

describe("isSplitTree", () => {
  it("tells single leaves from split trees", () => {
    for (const s of [0, 1, 2, 3, 5, 16, 17, 40, 300]) expect(isSplitTree(leaf(s))).toBe(false);
    expect(isSplitTree(emitPaintTree(split, "bbs"))).toBe(true);
  });
});

describe("createProject (painted 3MF)", () => {
  it("builds the palette from the file filaments and covers every used state", async () => {
    const model = await paintedModel();
    expect(model.usedExtruders).toEqual([1, 2, 3]);
    const p = createProject(model);
    expect(p.palette).toHaveLength(4); // slot 0 + states 1..3
    expect(p.palette[1]).toEqual({ color: "#FF0000", known: true });
    expect(p.palette[2]).toEqual({ color: "#00FF00", known: true });
    // state 3 is not in the file: a generated stand-in, flagged unknown and unlike the others
    expect(p.palette[3].known).toBe(false);
    expect(deltaE(p.palette[3].color, "#FF0000")).toBeGreaterThan(25);
    expect(deltaE(p.palette[3].color, "#00FF00")).toBeGreaterThan(25);
  });

  it("keeps only a part's base color when nothing is painted, compacted to state 1", async () => {
    const model = parseStl(binaryStl(CUBE_TRIS));
    model.objects[0].parts[0].extruder = 5; // the file has one filament: slot 5 is undefined
    const p = createProject(model);
    expect(p.palette).toHaveLength(2);
    expect(p.palette[1].known).toBe(false);
    expect(p.baseColor.get(partId(0, 0))).toBe(1);
  });

  it("takes the object and its base color from the file", async () => {
    const p = createProject(await paintedModel());
    expect(p.objects).toHaveLength(1);
    expect(p.objects[0].name).toBe("Fig");
    expect(p.objects[0].triCount).toBe(5);
    expect(p.fields).toHaveLength(1);
    expect(p.baseColor.get(partId(0, 0))).toBe(2);
    expect(p.source.paintDialect).toBe("bbs");
  });

  it("resolves display states: painted state, else the part base color", async () => {
    const p = createProject(await paintedModel());
    // tri 3 is a split tree whose dominant state (tie -> higher) is 2.
    expect(Array.from(resolveDisplayStates(p, 0))).toEqual([2, 1, 3, 2, 2]);
    p.setBaseColor(0, 0, 1);
    expect(Array.from(resolveDisplayStates(p, 0))).toEqual([1, 1, 3, 2, 1]);
  });

  it("resolves a single triangle the same way as the bulk resolver", async () => {
    const p = createProject(await paintedModel());
    for (const base of [2, 1, 3]) {
      p.setBaseColor(0, 0, base);
      const bulk = Array.from(resolveDisplayStates(p, 0));
      expect(bulk.map((_, t) => resolveTriangleState(p, 0, t))).toEqual(bulk);
    }
  });
});

describe("createProject (PrusaSlicer project)", () => {
  it("uses the project's colors, keeps the ColorMix recipe as a hint and takes the base extruder from the file", async () => {
    const model = await load3MF(await archive({
      objects: [{ id: "1", paints: [emitPaintTree({ state: 5 }, "prusa"), ""] }],
      members: {
        [PE_CONFIG]: peConfig({ extruder_colour: "#00FFFF;#FF0080;#FFFF00;#FFFFFF" }),
        [FULL_SPECTRUM]: JSON.stringify({ virtual_extruders: [{ id: 5, kind: "fullspectrum", color: "#30f845", components: [{ extruder: 1, ratio: 1 }, { extruder: 3, ratio: 1 }] }] }),
        [PE_MODEL]: modelConfig([{ id: "1", extruder: 4, volumes: [{ first: 0, last: 1 }] }]),
      },
    }));
    const p = createProject(model);
    // Only the used colors remain: the base extruder 4 and the painted virtual extruder 5.
    expect(p.palette.map((c) => c.color)).toEqual(["#808080", "#FFFFFF", "#30F845"]);
    expect(p.palette.every((c) => c.known)).toBe(true);
    expect(p.palette[2].mix).toEqual([{ extruder: 1, ratio: 1 }, { extruder: 3, ratio: 1 }]);
    expect(p.palette[1]).not.toHaveProperty("mix");
    expect(p.baseColor.get(partId(0, 0))).toBe(1);
    expect(Array.from(resolveDisplayStates(p, 0))).toEqual([2, 1]);
    // the hint is a copy: the project must not share it with the imported filaments
    expect(p.palette[2].mix).not.toBe(model.filaments[4].mix);
  });
});

describe("TrianglePaintField", () => {
  it("keeps the dominant state per triangle and preserves only split trees", async () => {
    const model = await paintedModel();
    const f = createProject(model).fields[0] as TrianglePaintField;
    expect(Array.from(f.states)).toEqual(Array.from(model.objects[0].triState));
    expect(Array.from(f.displayStates())).toEqual([0, 1, 3, 2, 0]);
    expect(Array.from(f.preserved)).toEqual([[3, emitPaintTree(split, "bbs")]]);
    expect(f.stateAt(2)).toBe(3);
    expect(f.mesh.triCount).toBe(5);
    expect(f.mesh.vertices).toBe(model.objects[0].vertices);
  });
});

describe("createProject (STL)", () => {
  it("has one design color, the neutral gray, as the base", () => {
    const p = createProject(parseStl(binaryStl(CUBE_TRIS)));
    // The importer's neutral gray is deliberate, not a generated stand-in.
    expect(p.palette).toEqual([{ color: "#808080", known: true }, { color: "#D9D9D9", known: true }]);
    expect(p.baseColor.get(partId(0, 0))).toBe(1);
    expect(Array.from(new Set(resolveDisplayStates(p, 0)))).toEqual([1]);
    expect(p.fields[0].displayStates().every((s) => s === 0)).toBe(true);
  });

  it("marks only ModelPart triangles as print surface", () => {
    const model = parseStl(binaryStl(CUBE_TRIS));
    model.objects[0].parts = [
      { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
      { firstTri: 8, triCount: 4, extruder: 1, type: "NegativeVolume", name: null },
    ];
    const mask = printSurfaceMask(createProject(model), 0);
    expect(Array.from(mask)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
  });
});
