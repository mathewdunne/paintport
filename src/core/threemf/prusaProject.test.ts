// PrusaSlicer project import (phase 2.0): colors from Slic3r_PE.config, ColorMix virtual
// extruders from Prusa_Slicer_full_spectrum.json, base extruders from Slic3r_PE_model.config.
// This is a deliberate extension beyond the classic tool, so it is covered here and not by
// the parity suite (which never feeds the port Prusa project metadata).
import { describe, expect, it } from "vitest";
import {
  archive, FULL_SPECTRUM, modelConfig, PE_CONFIG, PE_MODEL, peConfig, type ArchiveSpec,
} from "../../../test/support/prusaArchive";
import { build3MF, emitPaintTree, load3MF, unzipAll, zipAll, type Model } from "../index";
import { splitConfigStrings } from "./prusaProject";

const leaf = (state: number) => emitPaintTree({ state }, "prusa");
const load = async (spec: ArchiveSpec): Promise<Model> => load3MF(await archive(spec));
const one = (n = 1) => [{ id: "1", paints: Array<string>(n).fill("") }];

/** A project whose single object has `n` unpainted triangles, with the given members. */
const withMembers = (members: Record<string, string>, n = 1) => load({ objects: one(n), members });
const colorsOf = (m: Model) => m.filaments.map((f) => f.color);
const knownOf = (m: Model) => m.filaments.map((f) => f.colorKnown);

const FALLBACK1 = "#26A69A";

const physical4: [number, string][] = [[1, "#00FFFF"], [2, "#FF0080"], [3, "#FFFF00"], [4, "#FFFFFF"]];
const vx = (id: unknown, color: unknown, comps: unknown, extra: Record<string, unknown> = {}) => ({ id, kind: "fullspectrum", color, components: comps, ...extra });
const comps = (...c: [number, number][]) => c.map(([extruder, ratio]) => ({ extruder, ratio }));
const fsJson = (physical: [number, string][], virtuals: unknown) =>
  JSON.stringify({ version: 1, physical_extruders: physical.map(([id, color]) => ({ id, color })), virtual_extruders: virtuals });

describe("splitConfigStrings (how libslic3r writes a string vector)", () => {
  it("splits on ; and keeps empty entries as empty", () => {
    expect(splitConfigStrings("#00FFFF;#FF0080")).toEqual(["#00FFFF", "#FF0080"]);
    expect(splitConfigStrings(";;;")).toEqual(["", "", "", ""]);
    expect(splitConfigStrings("#FF0000;;#0000FF;")).toEqual(["#FF0000", "", "#0000FF", ""]);
  });
  it("reads the quoted empty string a single-entry vector gets, and quoted entries with escapes", () => {
    expect(splitConfigStrings('""')).toEqual([""]);
    expect(splitConfigStrings("")).toEqual([""]);
    expect(splitConfigStrings('"a;b";"c \\"d\\""')).toEqual(["a;b", 'c "d"']);
  });
  it("trims blanks around the value", () => {
    expect(splitConfigStrings(" #FF0000 ; #00FF00 ")).toEqual(["#FF0000", "#00FF00"]);
  });
});

describe("physical filament colors (Slic3r_PE.config)", () => {
  it("uses extruder_colour per slot; the slot count is the list length", async () => {
    const m = await withMembers({ [PE_CONFIG]: peConfig({ extruder_colour: "#00FFFF;#FF0080;#FFFF00;#FFFFFF", filament_colour: "#FF8000;#FF8000;#FF8000;#FF8000" }) });
    expect(colorsOf(m)).toEqual(["#00FFFF", "#FF0080", "#FFFF00", "#FFFFFF"]);
    expect(knownOf(m)).toEqual([true, true, true, true]);
  });

  it("falls back per slot to filament_colour when an extruder_colour entry is empty", async () => {
    const m = await withMembers({ [PE_CONFIG]: peConfig({ extruder_colour: "#FF0000;;#0000FF;", filament_colour: "#111111;#222222;#333333;#444444" }) });
    expect(colorsOf(m)).toEqual(["#FF0000", "#222222", "#0000FF", "#444444"]);
    expect(knownOf(m)).toEqual([true, true, true, true]);
  });

  it("uses filament_colour alone when there is no extruder_colour line", async () => {
    const m = await withMembers({ [PE_CONFIG]: peConfig({ filament_colour: "#FF8000;#00ff00" }) });
    expect(colorsOf(m)).toEqual(["#FF8000", "#00FF00"]);
  });

  it("treats the all-empty encodings (';;;' and a quoted empty string) as unknown colors", async () => {
    const four = await withMembers({ [PE_CONFIG]: peConfig({ extruder_colour: ";;;" }) });
    expect(four.filaments).toHaveLength(4);
    expect(knownOf(four)).toEqual([false, false, false, false]);
    const single = await withMembers({ [PE_CONFIG]: peConfig({ extruder_colour: '""', filament_colour: "#12AB34" }) });
    expect(colorsOf(single)).toEqual(["#12AB34"]);
    const none = await withMembers({ [PE_CONFIG]: peConfig({ extruder_colour: '""', filament_colour: '""' }) });
    expect(colorsOf(none)).toEqual([FALLBACK1]);
    expect(knownOf(none)).toEqual([false]);
  });

  it("reads quoted entries, normalizes case and short forms, and drops alpha", async () => {
    const m = await withMembers({ [PE_CONFIG]: peConfig({ extruder_colour: '"#ff0000";#0F0;00ff0080' }) });
    expect(colorsOf(m)).toEqual(["#FF0000", "#00FF00", "#00FF00"]);
  });

  it("ignores unreadable color entries instead of turning them into a known gray", async () => {
    const m = await withMembers({ [PE_CONFIG]: peConfig({ extruder_colour: "red;#GG0000;#FF0000", filament_colour: "#111111;;" }) });
    expect(colorsOf(m)[0]).toBe("#111111"); // "red" is unset -> filament_colour
    expect(knownOf(m)).toEqual([true, false, true]);
    expect(colorsOf(m)[2]).toBe("#FF0000");
  });

  it("does not touch files without Prusa project metadata", async () => {
    const m = await withMembers({});
    expect(colorsOf(m)).toEqual([FALLBACK1]);
    expect(knownOf(m)).toEqual([false]);
    expect(m.filaments[0]).not.toHaveProperty("mix");
  });

  it("leaves a Slic3r_PE.config without color lines as it was", async () => {
    const m = await withMembers({ [PE_CONFIG]: peConfig({ nozzle_diameter: "0.4" }) });
    expect(knownOf(m)).toEqual([false]);
  });
});

describe("the JSON's physical_extruders colors", () => {
  it("rank between extruder_colour and filament_colour", async () => {
    const m = await withMembers({
      [PE_CONFIG]: peConfig({ extruder_colour: "#AA0000;;", filament_colour: "#FF8000;#FF8000;#FF8000" }),
      [FULL_SPECTRUM]: fsJson([[1, "#0000BB"], [2, "#00CC00"]], []),
    });
    // slot 1: extruder_colour beats the JSON; slot 2: the JSON beats filament_colour; slot 3: filament_colour
    expect(colorsOf(m)).toEqual(["#AA0000", "#00CC00", "#FF8000"]);
  });

  it("are the only source (and define the slot count) for a file without Slic3r_PE.config, like PaintPort's own export", async () => {
    const m = await withMembers({ [FULL_SPECTRUM]: fsJson(physical4, [vx(5, "#30f845", comps([1, 1], [3, 1]))]) });
    expect(colorsOf(m)).toEqual(["#00FFFF", "#FF0080", "#FFFF00", "#FFFFFF", "#30F845"]);
    expect(m.filaments[4].mix).toEqual(comps([1, 1], [3, 1]));
  });

  it("can extend the slot count past the config lists", async () => {
    const m = await withMembers({
      [PE_CONFIG]: peConfig({ extruder_colour: "#FF0000;#00FF00" }),
      [FULL_SPECTRUM]: fsJson([[3, "#0000FF"]], []),
    });
    expect(colorsOf(m)).toEqual(["#FF0000", "#00FF00", "#0000FF"]);
  });
});

describe("ColorMix virtual extruders (Prusa_Slicer_full_spectrum.json)", () => {
  const config = peConfig({ extruder_colour: "#00FFFF;#FF0080;#FFFF00;#FFFFFF", filament_colour: "#FF8000;#FF8000;#FF8000;#FF8000" });
  const base = (virtuals: unknown, extra: Record<string, string> = {}) => withMembers({ [PE_CONFIG]: config, [FULL_SPECTRUM]: fsJson(physical4, virtuals), ...extra });

  it("turns each virtual extruder into a filament at its id with the stored color and the recipe", async () => {
    const m = await base([
      vx(5, "#30f845", comps([1, 0.5], [3, 0.5])),
      vx(6, "#9dfa00", comps([1, 0.25], [3, 0.75])),
      vx(7, "#965661", comps([1, 0.25], [2, 0.5], [3, 0.25])),
    ]);
    expect(m.filaments.map((f) => f.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(m.filaments[4]).toMatchObject({ index: 5, color: "#30F845", colorKnown: true, mix: comps([1, 0.5], [3, 0.5]) });
    expect(m.filaments[6].mix).toEqual(comps([1, 0.25], [2, 0.5], [3, 0.25]));
    for (const f of m.filaments.slice(0, 4)) expect(f).not.toHaveProperty("mix");
  });

  it("leaves a gap in the ids as an unknown filament", async () => {
    const m = await base([vx(7, "#112233", comps([1, 1], [2, 1]))]);
    expect(m.filaments).toHaveLength(7);
    expect(m.filaments[5]).toMatchObject({ index: 6, colorKnown: false });
    expect(m.filaments[5]).not.toHaveProperty("mix");
    expect(m.filaments[6].mix).toBeDefined();
  });

  it("counts painted virtual states in the statistics", async () => {
    const m = await load({
      objects: [{ id: "1", paints: [leaf(5), leaf(5), leaf(1), ""] }],
      members: { [PE_CONFIG]: config, [FULL_SPECTRUM]: fsJson(physical4, [vx(5, "#30f845", comps([1, 1], [3, 1]))]), [PE_MODEL]: modelConfig([{ id: "1", extruder: 4 }]) },
    });
    expect(m.usedExtruders).toEqual([1, 5]);
    expect(m.filaments[4]).toMatchObject({ paintedTris: 2, paintedShare: 2, baseTris: 0 });
    expect(m.filaments[0]).toMatchObject({ paintedTris: 1 });
    expect(m.filaments[3]).toMatchObject({ baseTris: 1, baseShare: 1, isDefaultOf: 1 });
  });

  // Every malformed variant of the id-5 entry is ignored; the valid id-6 entry next to it survives.
  const good6 = vx(6, "#00ff00", comps([2, 1], [3, 1]));
  const malformed: [string, unknown][] = [
    ["id equal to the physical count", vx(4, "#112233", comps([1, 1], [2, 1]))],
    ["id below the physical count", vx(2, "#112233", comps([1, 1], [2, 1]))],
    ["id 0", vx(0, "#112233", comps([1, 1], [2, 1]))],
    ["negative id", vx(-5, "#112233", comps([1, 1], [2, 1]))],
    ["fractional id", vx(5.5, "#112233", comps([1, 1], [2, 1]))],
    ["string id", vx("5", "#112233", comps([1, 1], [2, 1]))],
    ["missing id", vx(undefined, "#112233", comps([1, 1], [2, 1]))],
    ["id beyond what a paint string can address", vx(1_000_000_000, "#112233", comps([1, 1], [2, 1]))],
    ["missing color", vx(5, undefined, comps([1, 1], [2, 1]))],
    ["unreadable color", vx(5, "not a color", comps([1, 1], [2, 1]))],
    ["numeric color", vx(5, 0x112233, comps([1, 1], [2, 1]))],
    ["missing components", vx(5, "#112233", undefined)],
    ["components not an array", vx(5, "#112233", { extruder: 1, ratio: 1 })],
    ["empty components", vx(5, "#112233", [])],
    ["component referencing an unknown extruder", vx(5, "#112233", comps([1, 1], [9, 1]))],
    ["component referencing extruder 0", vx(5, "#112233", comps([0, 1], [2, 1]))],
    ["component referencing another virtual extruder", vx(5, "#112233", comps([1, 1], [6, 1]))],
    ["fractional component extruder", vx(5, "#112233", comps([1.5, 1], [2, 1]))],
    ["string component extruder", vx(5, "#112233", [{ extruder: "1", ratio: 1 }, { extruder: 2, ratio: 1 }])],
    ["zero ratio", vx(5, "#112233", comps([1, 0], [2, 1]))],
    ["negative ratio", vx(5, "#112233", comps([1, -1], [2, 1]))],
    ["string ratio", vx(5, "#112233", [{ extruder: 1, ratio: "1" }, { extruder: 2, ratio: 1 }])],
    ["missing ratio", vx(5, "#112233", [{ extruder: 1 }, { extruder: 2, ratio: 1 }])],
    ["component that is not an object", vx(5, "#112233", [1, 2])],
    ["another kind", vx(5, "#112233", comps([1, 1], [2, 1]), { kind: "gradient" })],
    ["entry that is not an object", "nope"],
    ["null entry", null],
  ];
  it.each(malformed)("ignores an entry with %s", async (_name, bad) => {
    const m = await base([bad, good6]);
    expect(m.filaments.find((f) => f.index === 5)?.mix).toBeUndefined();
    expect(m.filaments.length).toBeLessThanOrEqual(6); // a hostile id must not allocate slots
    const f6 = m.filaments.find((f) => f.index === 6);
    expect(f6).toMatchObject({ color: "#00FF00", colorKnown: true, mix: comps([2, 1], [3, 1]) });
    if (m.filaments.length >= 5) expect(m.filaments[4].colorKnown).toBe(false);
  });

  it("keeps the first of two entries with the same id", async () => {
    const m = await base([vx(5, "#111111", comps([1, 1], [2, 1])), vx(5, "#222222", comps([3, 1], [4, 1]))]);
    expect(m.filaments[4]).toMatchObject({ color: "#111111", mix: comps([1, 1], [2, 1]) });
  });

  it("accepts an entry without a kind", async () => {
    const m = await base([vx(5, "#111111", comps([1, 1], [2, 1]), { kind: undefined })]);
    expect(m.filaments[4].mix).toBeDefined();
  });

  it.each([
    ["not JSON", "{ oops"],
    ["an empty file", ""],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["an object without the lists", "{}"],
    ["virtual_extruders that is not an array", '{"virtual_extruders": {"id": 5}}'],
    ["physical_extruders that is not an array", '{"physical_extruders": 7, "virtual_extruders": []}'],
  ])("does not throw on %s: the physical colors still load", async (_name, json) => {
    const m = await withMembers({ [PE_CONFIG]: config, [FULL_SPECTRUM]: json });
    expect(colorsOf(m)).toEqual(["#00FFFF", "#FF0080", "#FFFF00", "#FFFFFF"]);
    expect(m.filaments.some((f) => f.mix)).toBe(false);
  });

  it("ignores the virtual extruders when no physical slot count is known", async () => {
    const m = await withMembers({ [FULL_SPECTRUM]: JSON.stringify({ virtual_extruders: [vx(5, "#112233", comps([1, 1], [2, 1]))] }) });
    expect(colorsOf(m)).toEqual([FALLBACK1]);
    expect(m.filaments[0]).not.toHaveProperty("mix");
  });

  it("skips malformed physical_extruders entries", async () => {
    const m = await withMembers({
      [FULL_SPECTRUM]: JSON.stringify({ physical_extruders: [{ id: 1, color: "#FF0000" }, { id: "2", color: "#00FF00" }, { id: 3, color: "nope" }, null, { id: 4 }, { id: 2, color: "#0000FF" }] }),
    });
    expect(colorsOf(m)).toEqual(["#FF0000", "#0000FF"]);
  });
});

describe("base extruders (Slic3r_PE_model.config)", () => {
  it("reads the object extruder into defaultExtruder and the part extruder, even when everything is painted", async () => {
    const m = await load({
      objects: [{ id: "1", paints: [leaf(1), leaf(2), leaf(1)] }],
      members: { [PE_MODEL]: modelConfig([{ id: "1", name: "Fish", extruder: 4, volumes: [{ first: 0, last: 2, type: "ModelPart", name: "Fish" }] }]) },
    });
    expect(m.objects[0].name).toBe("Fish");
    expect(m.objects[0].defaultExtruder).toBe(4);
    expect(m.objects[0].parts).toEqual([{ firstTri: 0, triCount: 3, extruder: 4, type: "ModelPart", name: "Fish" }]);
    expect(m.filaments).toHaveLength(4);
    expect(m.filaments[3].isDefaultOf).toBe(1);
  });

  it("matches objects by id: several objects, an instance, and an object missing from the config", async () => {
    const m = await load({
      objects: [{ id: "1", paints: ["", ""] }, { id: "2", paints: [""] }, { id: "3", paints: [""] }],
      items: ["2", "1", "1", "3"],
      members: { [PE_MODEL]: modelConfig([
        { id: "1", extruder: 3, volumes: [{ first: 0, last: 1 }] },
        { id: "2", extruder: 2, volumes: [{ first: 0, last: 0 }] },
      ]) },
    });
    expect(m.objects.map((o) => o.defaultExtruder)).toEqual([2, 3, 3, 1]);
    expect(m.objects.map((o) => o.parts.map((p) => p.extruder))).toEqual([[2], [3], [3], [1]]);
    // statistics follow the base extruders: unpainted triangles per extruder
    expect(m.filaments.map((f) => f.baseTris)).toEqual([1, 1, 4]);
    expect(m.filaments.map((f) => f.isDefaultOf)).toEqual([1, 1, 2]);
    expect(m.unpainted).toBe(6);
  });

  it("takes volume extruders and types; 0 or a missing key inherits the object's extruder", async () => {
    const volumes = [
      { first: 0, last: 1, type: "ModelPart", extruder: 3, name: "A" },
      { first: 2, last: 3, type: "ModelPart", extruder: 0 },
      { first: 4, last: 5, type: "ModelPart" },
      { first: 6, last: 6, type: "NegativeVolume", extruder: 2 },
      { first: 7, last: 7, type: "ParameterModifier" },
      { first: 8, last: 8, type: "SupportBlocker" },
      { first: 9, last: 9, type: "SupportEnforcer" },
      { first: 10, last: 10, type: "Mystery" },
      { first: 11, last: 11 },
    ];
    const m = await load({
      objects: [{ id: "1", paints: Array<string>(12).fill("") }],
      members: { [PE_MODEL]: modelConfig([{ id: "1", extruder: 2, volumes }]) },
    });
    const parts = m.objects[0].parts;
    expect(parts.map((p) => p.type)).toEqual(["ModelPart", "ModelPart", "ModelPart", "NegativeVolume", "ParameterModifier", "SupportBlocker", "SupportEnforcer", "ModelPart", "ModelPart"]);
    expect(parts.map((p) => p.extruder)).toEqual([3, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(parts.map((p) => [p.firstTri, p.triCount])).toEqual([[0, 2], [2, 2], [4, 2], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [11, 1]]);
    expect(parts[0].name).toBe("A");
    // only ModelParts are print surface: 2 + 2 + 2 + 1 + 1 triangles
    expect(m.totalTris).toBe(8);
    expect(m.specialVolumes).toBe(4);
    expect(m.filaments.map((f) => f.baseTris)).toEqual([0, 6, 2]);
  });

  it("fills gaps between volumes with ModelParts of the object extruder and skips unreadable ranges", async () => {
    const m = await load({
      objects: [{ id: "1", paints: Array<string>(6).fill("") }],
      members: { [PE_MODEL]: modelConfig([{ id: "1", extruder: 2, volumes: [{ first: 1, last: 2, extruder: 3 }, { first: 5, last: 99, type: "NegativeVolume" }, { first: 4, last: 3 }] }]) },
    });
    expect(m.objects[0].parts.map((p) => [p.firstTri, p.triCount, p.extruder, p.type])).toEqual([
      [0, 1, 2, "ModelPart"], [1, 2, 3, "ModelPart"], [3, 2, 2, "ModelPart"], [5, 1, 2, "NegativeVolume"],
    ]);
  });

  it("uses extruder 1 where the config says nothing, and survives garbage values", async () => {
    const m = await load({
      objects: [{ id: "1", paints: [""] }, { id: "2", paints: [""] }],
      members: { [PE_MODEL]: modelConfig([{ id: "1" }, { id: "2", extruder: -3, volumes: [{ first: 0, last: 0, extruder: 99 }] }]).replace("</config>", ' <object id="3"><metadata type="object" key="extruder" value="abc"/></object>\n</config>') },
    });
    expect(m.objects.map((o) => o.defaultExtruder)).toEqual([1, 1]);
    expect(m.objects[1].parts[0].extruder).toBe(99); // a volume extruder is taken as written
  });

  it("does not read the extruder of layer-range metadata as an object extruder", async () => {
    const cfg = `<config><object id="1"><metadata type="object" key="name" value="X"/><range min_z="0" max_z="1"><metadata type="layer_config_range" key="extruder" value="3"/></range><volume firstid="0" lastid="0"><metadata type="volume" key="volume_type" value="ModelPart"/></volume></object></config>`;
    const m = await withMembers({ [PE_MODEL]: cfg });
    expect(m.objects[0].defaultExtruder).toBe(1);
  });

  it("copes with a missing, empty or broken config", async () => {
    for (const cfg of ["", "<config/>", "<config><object>", "not xml at all", '<config><object id="1"></object></config>']) {
      const m = await withMembers({ [PE_MODEL]: cfg });
      expect(m.objects[0].defaultExtruder, cfg).toBe(1);
      expect(m.objects[0].parts, cfg).toHaveLength(1);
    }
  });

  it("does not mistake the first volume for a component part when ids collide", async () => {
    // object id "0" and a volume numbered 0 live in different key spaces
    const m = await load({
      objects: [{ id: "0", paints: ["", ""] }],
      members: { [PE_MODEL]: modelConfig([{ id: "0", extruder: 2, volumes: [{ first: 0, last: 0, extruder: 3 }, { first: 1, last: 1 }] }]) },
    });
    expect(m.objects[0].parts.map((p) => p.extruder)).toEqual([3, 2]);
  });
});

describe("Bambu metadata keeps precedence", () => {
  const bambuObj = (id: string, extruder: number) => `<object id="${id}"><metadata key="name" value="Bambu ${id}"/><metadata key="extruder" value="${extruder}"/></object>`;
  const bambu = (objects: string) => `<config>${objects}</config>`;
  const prusaMembers = {
    [PE_CONFIG]: peConfig({ extruder_colour: "#00FFFF;#FF0080;#FFFF00;#FFFFFF" }),
    [FULL_SPECTRUM]: fsJson(physical4, [vx(5, "#30f845", comps([1, 1], [3, 1]))]),
    [PE_MODEL]: modelConfig([{ id: "1", name: "Prusa 1", extruder: 3 }, { id: "2", name: "Prusa 2", extruder: 4 }]),
  };

  it("uses the Bambu colors, ignores the full-spectrum recipes, and keeps the Bambu object extruder", async () => {
    const m = await load({
      objects: [{ id: "1", paints: [""] }],
      members: { ...prusaMembers, "Metadata/model_settings.config": bambu(bambuObj("1", 2)), "Metadata/project_settings.config": JSON.stringify({ filament_colour: ["#111111", "#222222"] }) },
    });
    expect(colorsOf(m)).toEqual(["#111111", "#222222"]);
    expect(m.filaments.some((f) => f.mix)).toBe(false);
    expect(m.objects[0].name).toBe("Bambu 1");
    expect(m.objects[0].defaultExtruder).toBe(2);
    expect(m.objects[0].parts[0].extruder).toBe(2);
  });

  it("falls back to the Prusa extruders for an object the Bambu config does not list", async () => {
    const m = await load({
      objects: [{ id: "1", paints: [""] }, { id: "2", paints: [""] }],
      members: { ...prusaMembers, "Metadata/model_settings.config": bambu(bambuObj("1", 2)) },
    });
    expect(m.objects.map((o) => [o.name, o.defaultExtruder])).toEqual([["Bambu 1", 2], ["Prusa 2", 4]]);
    // no Bambu colors: the Prusa ones apply
    expect(colorsOf(m).slice(0, 4)).toEqual(["#00FFFF", "#FF0080", "#FFFF00", "#FFFFFF"]);
    expect(m.filaments[4].mix).toBeDefined();
  });

  it("uses the Prusa colors when project_settings.config has no usable filament_colour", async () => {
    for (const ps of ["{}", "null", "{ broken", JSON.stringify({ filament_colour: "#FF0000" })]) {
      const m = await load({ objects: [{ id: "1", paints: [""] }], members: { ...prusaMembers, "Metadata/project_settings.config": ps } });
      expect(colorsOf(m).slice(0, 4), ps).toEqual(["#00FFFF", "#FF0080", "#FFFF00", "#FFFFFF"]);
    }
  });
});

describe("PaintPort's own Prusa export re-imports with its structure", () => {
  it("keeps the volume ranges, types, extruders, virtual colors and recipes", async () => {
    const source = await load({
      objects: [{ id: "1", paints: [leaf(1), leaf(2), "", "", leaf(1)] }],
      members: { [PE_MODEL]: modelConfig([{ id: "1", extruder: 2, volumes: [{ first: 0, last: 1, extruder: 3 }, { first: 2, last: 3, type: "NegativeVolume" }, { first: 4, last: 4 }] }]) },
    });
    const built = build3MF(source, {
      target: "prusa",
      stateMap: new Map([[1, 1], [2, 5]]),
      physical: physical4.map(([slot, color]) => ({ slot, color })),
      virtuals: [{ id: 5, color: "#30F845", components: comps([1, 1], [3, 1]) }],
    });
    const re = await load3MF(await zipAll(built.entries));
    expect(re.paintDialect).toBe("prusa");
    expect(re.objects[0].parts.map((p) => [p.firstTri, p.triCount, p.extruder, p.type])).toEqual([
      [0, 2, 3, "ModelPart"], [2, 2, 1, "NegativeVolume"], [4, 1, 5, "ModelPart"],
    ]);
    // The export maps base extruders through the plan (2 -> 5), writes no extruder for a
    // negative volume and no object-level extruder, so those two read back as inherit -> 1.
    expect(re.objects[0].defaultExtruder).toBe(1);
    expect(colorsOf(re)).toEqual(["#00FFFF", "#FF0080", "#FFFF00", "#FFFFFF", "#30F845"]);
    expect(re.filaments[4].mix).toEqual(comps([1, 1], [3, 1]));
    expect(re.usedExtruders).toEqual([1, 5]);
  });

  it("the bbs export carries no Prusa project members", async () => {
    const source = await load({ objects: one(2), members: { [PE_MODEL]: modelConfig([{ id: "1", extruder: 2 }]) } });
    const built = build3MF(source, { target: "bambu", mixFormat: "bambu", stateMap: new Map(), physical: physical4.map(([slot, color]) => ({ slot, color })) });
    const names = (await unzipAll(await zipAll(built.entries))).keys();
    expect([...names].some((n) => n.includes("Slic3r_PE") || n.includes("full_spectrum"))).toBe(false);
  });
});

describe("hostile magnitudes (extruder numbers are clamped to 272)", () => {
  it("treats an object extruder above the limit as 1, not as a million filament slots", async () => {
    for (const huge of [273, 99999999, 2 ** 40]) {
      const m = await withMembers({ [PE_MODEL]: modelConfig([{ id: "1", extruder: huge, volumes: [{ first: 0, last: 0 }] }]) });
      expect(m.objects[0].defaultExtruder, String(huge)).toBe(1);
      expect(m.objects[0].parts[0].extruder, String(huge)).toBe(1);
      expect(m.filaments).toHaveLength(1);
    }
  });

  it("accepts 272, the highest extruder a paint string can address", async () => {
    const m = await withMembers({ [PE_MODEL]: modelConfig([{ id: "1", extruder: 272, volumes: [{ first: 0, last: 0, extruder: 272 }] }]) });
    expect(m.objects[0].defaultExtruder).toBe(272);
    expect(m.filaments).toHaveLength(272);
  });

  it("treats a volume extruder above the limit as inherit", async () => {
    for (const huge of [273, 5_000_000]) {
      const m = await withMembers({ [PE_MODEL]: modelConfig([{ id: "1", extruder: 2, volumes: [{ first: 0, last: 0, extruder: huge }] }]) });
      expect(m.objects[0].parts[0].extruder, String(huge)).toBe(2);
      expect(m.filaments).toHaveLength(2);
    }
  });

  it("slices the color lists to 272 entries", async () => {
    const semicolons = ";".repeat(3_000_000);
    for (const key of ["extruder_colour", "filament_colour"]) {
      const m = await withMembers({ [PE_CONFIG]: peConfig({ [key]: semicolons }) });
      expect(m.filaments, key).toHaveLength(272);
      expect(knownOf(m).some(Boolean)).toBe(false);
    }
    const colors = Array<string>(1000).fill("#FF0000").join(";");
    const m = await withMembers({ [PE_CONFIG]: peConfig({ extruder_colour: colors }) });
    expect(m.filaments).toHaveLength(272);
    expect(knownOf(m).every(Boolean)).toBe(true);
  });

  it("splitConfigStrings stops at the limit", () => {
    expect(splitConfigStrings("a;b;c;d", 2)).toEqual(["a", "b"]);
    expect(splitConfigStrings("a;b", 2)).toEqual(["a", "b"]);
    expect(splitConfigStrings("a", 2)).toEqual(["a"]);
    expect(splitConfigStrings(";".repeat(1000), 5)).toHaveLength(5);
  });
});

describe("Slic3r_PE_model.config scanning stays linear on unterminated tags", () => {
  // The old lazy regex took ~25 s for 100k tags; the bound is generous so it only catches
  // quadratic behavior, not a slow machine.
  const LIMIT_MS = 3000;
  const timed = async (config: string) => {
    const t0 = performance.now();
    const m = await withMembers({ [PE_MODEL]: config });
    const ms = performance.now() - t0;
    expect(m.objects[0].defaultExtruder).toBe(1);
    expect(ms).toBeLessThan(LIMIT_MS);
  };
  it("100k unterminated <object> tags", () => timed('<config>' + '<object id="1">'.repeat(100_000)));
  it("100k unterminated <volume> tags inside one object", () => timed('<config><object id="1">' + '<volume firstid="0" lastid="0">'.repeat(100_000) + "</object></config>"));
  it("100k unclosed <metadata tags", () => timed('<config><object id="1">' + "<metadata ".repeat(100_000) + "</object></config>"));
  it("100k closed objects are read in linear time too", () => timed("<config>" + '<object id="1"><metadata type="object" key="name" value="x"/></object>'.repeat(100_000) + "</config>"));
});

describe("legacy PrusaSlicer < 2.4 volumes", () => {
  const legacy = (inner: string) => `<config><object id="1"><metadata type="object" key="extruder" value="2"/><volume firstid="0" lastid="0">${inner}</volume><volume firstid="1" lastid="1"><metadata type="volume" key="modifier" value="0"/></volume></object></config>`;
  const types = async (config: string) => (await withMembers({ [PE_MODEL]: config }, 2)).objects[0].parts.map((p) => p.type);

  it("reads key=modifier value=1 as a ParameterModifier when volume_type is absent", async () => {
    expect(await types(legacy('<metadata type="volume" key="modifier" value="1"/>'))).toEqual(["ParameterModifier", "ModelPart"]);
  });
  it("lets volume_type win over the legacy key", async () => {
    expect(await types(legacy('<metadata type="volume" key="modifier" value="1"/><metadata type="volume" key="volume_type" value="ModelPart"/>'))).toEqual(["ModelPart", "ModelPart"]);
  });
  it("keeps a volume without either key a ModelPart", async () => {
    expect(await types(legacy(""))).toEqual(["ModelPart", "ModelPart"]);
  });
});

describe("Slic3r_PE.config line endings and broken quotes", () => {
  it("reads a CRLF file", async () => {
    const crlf = peConfig({ extruder_colour: "#00FFFF;;#FFFF00", filament_colour: "#111111;#222222;#333333" }).replace(/\n/g, "\r\n");
    const m = await withMembers({ [PE_CONFIG]: crlf });
    expect(colorsOf(m)).toEqual(["#00FFFF", "#222222", "#FFFF00"]);
    expect(knownOf(m)).toEqual([true, true, true]);
  });

  it("confines an unterminated quote to its own line", async () => {
    for (const eol of ["\n", "\r\n"]) {
      const cfg = ['; extruder_colour = "#FF0000;#00FF00', "; filament_colour = #111111;#222222;#333333", "; nozzle_diameter = 0.4"].join(eol) + eol;
      const m = await withMembers({ [PE_CONFIG]: cfg });
      // the broken extruder_colour list is one unreadable entry: slot 1 falls back, the rest of the file is intact
      expect(colorsOf(m)).toEqual(["#111111", "#222222", "#333333"]);
    }
  });

  it("does not throw on a lone quote, a trailing backslash or a quote-only value", () => {
    expect(splitConfigStrings('"')).toEqual([""]);
    expect(splitConfigStrings('"abc\\')).toEqual(["abc\\"]);
    expect(splitConfigStrings('"a;b')).toEqual(["a;b"]);
  });
});
