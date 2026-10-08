import { describe, expect, it } from "vitest";
import { emitPaintTree, load3MF, zipAll, type Model, type PaintNode } from "../core";
import { binaryStl, CUBE_TRIS } from "../../test/support/fixtures";
import { parseStl } from "../formats/stl";
import { printSurfaceMask, resolveDisplayStates, resolveTriangleState } from "./display";
import { createProject, partId } from "./project";
import { isSplitTree, TrianglePaintField } from "./trianglePaintField";

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
    expect(p.palette[1].color).toBe("#FF0000");
    expect(p.palette[2].color).toBe("#00FF00");
    expect(p.palette[3].color).toBe("#FFCA28"); // state 3 is not in the file: fallback color
  });

  it("covers a part extruder beyond the file filaments even when it is not painted", async () => {
    const model = parseStl(binaryStl(CUBE_TRIS));
    model.objects[0].parts[0].extruder = 5;
    const p = createProject(model);
    expect(p.palette).toHaveLength(6);
    expect(p.palette.every((c) => /^#[0-9A-F]{6}$/.test(c.color))).toBe(true);
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
    p.baseColor.set(partId(0, 0), 1);
    expect(Array.from(resolveDisplayStates(p, 0))).toEqual([1, 1, 3, 2, 1]);
  });

  it("resolves a single triangle the same way as the bulk resolver", async () => {
    const p = createProject(await paintedModel());
    for (const base of [2, 1, 3]) {
      p.baseColor.set(partId(0, 0), base);
      const bulk = Array.from(resolveDisplayStates(p, 0));
      expect(bulk.map((_, t) => resolveTriangleState(p, 0, t))).toEqual(bulk);
    }
  });
});

describe("TrianglePaintField", () => {
  it("keeps the dominant state per triangle and preserves only split trees", async () => {
    const model = await paintedModel();
    const f = new TrianglePaintField(model.objects[0]);
    expect(Array.from(f.states)).toEqual(Array.from(model.objects[0].triState));
    expect(Array.from(f.displayStates())).toEqual([0, 1, 3, 2, 0]);
    expect(f.preserved).toEqual([null, null, null, emitPaintTree(split, "bbs"), null]);
    expect(f.stateAt(2)).toBe(3);
    expect(f.mesh.triCount).toBe(5);
    expect(f.mesh.vertices).toBe(model.objects[0].vertices);
  });
});

describe("createProject (STL)", () => {
  it("has one design color, the neutral gray, as the base", () => {
    const p = createProject(parseStl(binaryStl(CUBE_TRIS)));
    expect(p.palette).toEqual([{ color: "#808080" }, { color: "#D9D9D9" }]);
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
