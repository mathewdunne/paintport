import { describe, expect, it } from "vitest";
import { load3MF, parsePaintTree, unzipAll, zipAll, type Model } from "../core";
import { cubeMesh, leaf, makeModel, makeMultiModel, split2, split3, stripMesh, tree } from "../../test/support/docFixtures";
import { defaultExportSettings, type ExportSettings } from "../persist/exportSettings";
import { buildExport, type ExportResult } from "./export";
import { defaultSpools, EXPORT_TARGET_IDS, type ExportTargetId } from "./mapping";
import { createProject } from "./project";

const dec = new TextDecoder();
const DATE = "2026-05-06";

/** Settings with exactly the given spools on (slot -> color), 16 extruders everywhere unless `counts` says otherwise. */
function settings(on: Record<number, string>, over: { target?: ExportTargetId; counts?: Partial<Record<ExportTargetId, number>>; allowMix?: boolean } = {}): ExportSettings {
  const s = defaultExportSettings();
  s.target = over.target ?? "prusa";
  s.printerCount = { prusa: 16, bambu: 16, snapmaker: 16, ...over.counts };
  s.spools = defaultSpools().map((sp) => (on[sp.slot] ? { ...sp, on: true, color: on[sp.slot] } : { ...sp, on: false }));
  if (over.allowMix !== undefined) s.allowMix = over.allowMix;
  return s;
}

const text = (r: ExportResult, name: string): string => {
  const e = r.entries.find((x) => x.name === name);
  if (!e) throw new Error(`no entry ${name} in ${r.entries.map((x) => x.name).join(", ")}`);
  return dec.decode(e.data);
};

/** Export, zip, and load the 3MF the way a slicer-free re-import would. */
async function reload(r: ExportResult): Promise<Model> {
  return load3MF(await zipAll(r.entries));
}

const RGB = { r: "#FF0000", g: "#00FF00", b: "#0000FF" };
const filaments3 = [{ color: RGB.r }, { color: RGB.g }, { color: RGB.b }];

describe("export after edits", () => {
  // tri 0 split (1,2), tri 1 leaf 2, tri 2 split (2,3,1), tri 3 leaf 3, the rest unpainted; base color: file extruder 1
  const paints = [tree(split2(1, 2)), leaf(2), tree(split3(2, 3, 1)), leaf(3)];
  const fresh = () => createProject(makeModel(cubeMesh(), { paints, filaments: filaments3 }), { name: "cube" });
  // design 1 (red) -> slot 4, 2 (green) -> slot 2, 3 (blue) -> slot 6; the colors match exactly, so Auto picks them
  const spools = settings({ 4: RGB.r, 2: RGB.g, 6: RGB.b });

  it("flattens repainted triangles, keeps untouched preserved trees and remaps their states", async () => {
    const project = fresh();
    project.paintTriangles(0, [0, 5], 3); // tri 0 had a tree; tri 5 was unpainted
    project.paintTriangles(0, [1], 0); // erase
    const out = await reload(buildExport(project, spools, { date: DATE }));
    const p = out.objects[0].paints;
    expect(out.paintDialect).toBe("prusa");
    expect(parsePaintTree(p[0]!, "prusa")).toEqual({ state: 6 });
    expect(p[1]).toBeNull();
    expect(parsePaintTree(p[2]!, "prusa")).toEqual(split3(2, 6, 4)); // the tree survived with states 2,3,1 -> 2,6,4
    expect(parsePaintTree(p[3]!, "prusa")).toEqual({ state: 6 });
    expect(parsePaintTree(p[5]!, "prusa")).toEqual({ state: 6 });
    for (const t of [4, 6, 7, 8, 9, 10, 11]) expect(p[t], `tri ${t}`).toBeNull();
    expect(out.objects[0].parts[0].extruder).toBe(4); // the part's base: design 1 -> slot 4
  });

  it("writes the same files again for the same project (nothing depends on call order)", () => {
    const project = fresh();
    const a = buildExport(project, spools, { date: DATE }), b = buildExport(project, spools, { date: DATE });
    expect(a.entries.map((e) => [e.name, dec.decode(e.data)])).toEqual(b.entries.map((e) => [e.name, dec.decode(e.data)]));
  });

  it("follows color edits and undo: a re-colored design color maps to another spool", () => {
    const project = fresh();
    expect(text(buildExport(project, spools, { date: DATE }), "Metadata/Slic3r_PE_model.config")).toContain('key="extruder" value="4"');
    project.setColor(1, RGB.b); // the red color becomes blue: Auto now picks the blue spool
    expect(text(buildExport(project, spools, { date: DATE }), "Metadata/Slic3r_PE_model.config")).toContain('key="extruder" value="6"');
    project.undo();
    expect(text(buildExport(project, spools, { date: DATE }), "Metadata/Slic3r_PE_model.config")).toContain('key="extruder" value="4"');
  });
});

describe("volumes, transforms and names", () => {
  const model = (): Model => {
    const m = makeModel(cubeMesh(), {
      paints: [leaf(2), leaf(1), null, null, leaf(1) /* on the negative volume: dropped */, leaf(2), null, null],
      parts: [
        { firstTri: 0, triCount: 4, extruder: 1, type: "ModelPart", name: "body" },
        { firstTri: 4, triCount: 4, extruder: 1, type: "NegativeVolume", name: "hole" },
        { firstTri: 8, triCount: 4, extruder: 2, type: "ParameterModifier", name: "mod" },
      ],
      filaments: [{ color: RGB.r }, { color: RGB.g }],
    });
    return m;
  };

  it.each(EXPORT_TARGET_IDS)("%s: negative volumes stay negative and unpainted, modifiers keep their mapped extruder", async (target) => {
    const project = createProject(model(), { name: "vol" });
    const out = await reload(buildExport(project, settings({ 3: RGB.r, 5: RGB.g }, { target }), { date: DATE }));
    const o = out.objects[0];
    expect(o.parts.map((p) => p.type)).toEqual(["ModelPart", "NegativeVolume", "ParameterModifier"]);
    expect(o.parts.map((p) => [p.firstTri, p.triCount])).toEqual([[0, 4], [4, 4], [8, 4]]);
    expect(o.parts[0].extruder).toBe(3); // design 1 (red) -> slot 3
    expect(o.parts[2].extruder).toBe(5); // the modifier's design 2 (green) -> slot 5
    for (let t = 4; t < 12; t++) expect(o.paints[t], `${target} tri ${t}`).toBeNull();
    const states = (t: number) => parsePaintTree(o.paints[t]!, out.paintDialect);
    expect(states(0)).toEqual({ state: 5 });
    expect(states(1)).toEqual({ state: 3 });
    // an unpainted ModelPart triangle: unpainted in the Prusa file, filled with the base in the bbs files
    if (target === "prusa") expect(o.paints[2]).toBeNull();
    else expect(states(2)).toEqual({ state: 3 });
    expect(o.parts[1].name).toBe("hole");
  });

  it.each(EXPORT_TARGET_IDS)("%s: transform, printable flag and names round-trip, escaped once", async (target) => {
    const m = makeMultiModel([{ mesh: cubeMesh(), spec: { filaments: [{ color: RGB.r }] } }, { mesh: cubeMesh([3, 0, 0]), spec: { filaments: [{ color: RGB.r }] } }]);
    m.objects[0].name = "Tom &amp; Jerry &lt;3";
    m.objects[0].transform = "1 0 0 0 1 0 0 0 1 5 6 7";
    m.objects[0].printable = false;
    m.objects[1].name = "plain";
    const project = createProject(m, { name: "names" });
    expect(project.objects[0].name).toBe("Tom & Jerry <3");
    const out = await reload(buildExport(project, settings({ 1: RGB.r }, { target }), { date: DATE }));
    expect(out.objects.map((o) => o.name)).toEqual(["Tom &amp; Jerry &lt;3", "plain"]); // the raw text the slicer sees: escaped once
    expect(out.objects.map((o) => o.transform)).toEqual(["1 0 0 0 1 0 0 0 1 5 6 7", null]);
    expect(out.objects.map((o) => o.printable)).toEqual([false, true]);
    expect(createProject(out).objects.map((o) => o.name)).toEqual(["Tom & Jerry <3", "plain"]); // and reads back the same
  });
});

describe("mapping into the plan", () => {
  // three colors painted on separate triangles of a strip
  const model = () => makeModel(stripMesh([0, 0, 0, 0]), { paints: [leaf(1), leaf(2), leaf(3)], filaments: filaments3 });
  const blend = (a: number, b: number, ra = 1, rb = 1) => ({ kind: "blend" as const, components: [{ slot: a, ratio: ra }, { slot: b, ratio: rb }] });

  it("Prusa lists every printer extruder and numbers blends above the printer's count", () => {
    const project = createProject(model(), { name: "plan" });
    project.setPin(1, blend(1, 2));
    project.setPin(2, blend(1, 2, 1, 3));
    project.setPin(3, { kind: "spool", slot: 3 });
    const r = buildExport(project, settings({ 1: RGB.r, 2: RGB.g, 3: RGB.b }, { counts: { prusa: 8 } }), { date: DATE });
    expect(r.virtualCount).toBe(2);
    expect(r.firstVirtualId).toBe(9);
    expect(r.physical).toHaveLength(8);
    expect(r.virtuals.map((v) => v.id)).toEqual([9, 10]);
    expect([...r.stateMap]).toEqual([[1, 9], [2, 10], [3, 3]]);
    const fs = JSON.parse(text(r, "Metadata/Prusa_Slicer_full_spectrum.json")) as { physical_extruders: unknown[]; virtual_extruders: { id: number }[] };
    expect(fs.physical_extruders).toHaveLength(8);
    expect(fs.virtual_extruders.map((v) => v.id)).toEqual([9, 10]);
    expect(r.mmVersion).toBe(1);
  });

  it("the bbs targets end the physical list at the highest active slot and number blends right after it", () => {
    for (const target of ["bambu", "snapmaker"] as const) {
      const project = createProject(model(), { name: "plan" });
      project.setPin(1, blend(2, 5));
      project.setPin(2, { kind: "spool", slot: 2 });
      project.setPin(3, { kind: "spool", slot: 5 });
      const r = buildExport(project, settings({ 2: RGB.r, 5: RGB.g, 7: RGB.b }, { target }), { date: DATE });
      expect(r.physical.map((p) => p.slot)).toEqual([1, 2, 3, 4, 5, 6, 7]); // up to the highest ACTIVE slot (7), inactive ones included
      expect(r.firstVirtualId).toBe(8);
      expect([...r.stateMap]).toEqual([[1, 8], [2, 2], [3, 5]]);
      const ps = JSON.parse(text(r, "Metadata/project_settings.config")) as { filament_colour: string[]; mixed_filament_definitions?: string };
      expect(ps.filament_colour).toHaveLength(target === "bambu" ? 8 : 7);
      if (target === "snapmaker") expect(ps.mixed_filament_definitions).toMatch(/^2,5,1,1,50,/);
    }
  });

  it("deduplicates blends by recipe", () => {
    const project = createProject(model(), { name: "plan" });
    project.setPin(1, blend(1, 2));
    project.setPin(2, blend(1, 2, 2, 2)); // the same recipe, written 2:2
    project.setPin(3, blend(1, 2, 3, 1));
    const r = buildExport(project, settings({ 1: RGB.r, 2: RGB.g }), { date: DATE });
    expect(r.virtualCount).toBe(2);
    expect(r.stateMap.get(1)).toBe(r.stateMap.get(2));
    expect(r.stateMap.get(3)).not.toBe(r.stateMap.get(1));
  });

  it("does not map colors that are unused, so they create no virtual extruder", () => {
    const project = createProject(model(), { name: "plan" });
    const spare = project.addColor("#123456");
    project.setPin(spare, blend(1, 2));
    const r = buildExport(project, settings({ 1: RGB.r, 2: RGB.g, 3: RGB.b }), { date: DATE });
    expect(r.virtualCount).toBe(0);
    expect(r.stateMap.has(spare)).toBe(false);
    expect(r.entries.some((e) => e.name === "Metadata/Prusa_Slicer_full_spectrum.json")).toBe(false);
  });

  it("never writes a blend while ColorMix is off, not even a pinned one", () => {
    const project = createProject(model(), { name: "plan" });
    project.setPin(1, blend(1, 2));
    const r = buildExport(project, settings({ 1: RGB.r, 2: RGB.g, 3: RGB.b }, { allowMix: false }), { date: DATE });
    expect(r.virtualCount).toBe(0);
    expect(r.stateMap.get(1)).toBe(1); // the pin fell back to Auto: the nearest spool
  });

  it("names the file and titles the project like the classic tool", () => {
    const project = createProject(model(), { name: "my fish" });
    const prusa = buildExport(project, settings({ 1: RGB.r, 2: RGB.g, 3: RGB.b }), { date: DATE });
    expect(prusa.fileName).toBe("my fish_INDX_3T.3mf");
    expect(text(prusa, "3D/3dmodel.model")).toContain('<metadata name="Title">my fish (INDX)</metadata>');
    expect(text(prusa, "3D/3dmodel.model")).toContain(`<metadata name="CreationDate">${DATE}</metadata>`);
    const bambu = buildExport(project, settings({ 1: "#00FFFF", 2: "#FF00FF", 3: "#FFFF00" }, { target: "bambu" }), { date: DATE });
    expect(bambu.fileName).toBe("my fish_bambu_CMY.3mf");
    expect(text(bambu, "3D/3dmodel.model")).toContain('<metadata name="Title">my fish (PaintPort)</metadata>');
    expect(text(bambu, "3D/3dmodel.model")).toContain("BambuStudio-02.07.01.62");
    const snap = buildExport(createProject(model()), settings({ 1: RGB.r }, { target: "snapmaker" }), { date: DATE });
    expect(snap.fileName).toBe("PaintPort_snapmaker_1T.3mf"); // no source name
    expect(text(snap, "3D/3dmodel.model")).toContain("BambuStudio-2.3.5");
  });

  it("defaults the date to today", () => {
    const r = buildExport(createProject(model()), settings({ 1: RGB.r }));
    expect(text(r, "3D/3dmodel.model")).toContain(`<metadata name="CreationDate">${new Date().toISOString().slice(0, 10)}</metadata>`);
  });

  it("adds the design sidecar to every export", () => {
    const r = buildExport(createProject(model()), settings({ 1: RGB.r }));
    expect(r.entries.map((e) => e.name).slice(-2)).toEqual(["Metadata/PaintPortPlus.json", "Metadata/PaintPortPlus/object_0.bin"]);
  });
});

describe("refusals", () => {
  const project = () => createProject(makeModel(stripMesh([0, 0, 0]), { paints: [leaf(1), leaf(2)], filaments: [{ color: RGB.r }, { color: RGB.g }] }), { name: "ref" });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return undefined;
  };

  it("refuses without an active spool", () => {
    expect(code(() => buildExport(project(), settings({}), { date: DATE }))).toBe("EXPORT_NO_SPOOL");
    // a spool above the printer's extruder count does not exist
    expect(code(() => buildExport(project(), settings({ 6: RGB.r }, { counts: { prusa: 4 } }), { date: DATE }))).toBe("EXPORT_NO_SPOOL");
  });

  it("refuses a Bambu export over the 16 filaments, but not Snapmaker or Prusa", () => {
    const p = project();
    p.setPin(1, { kind: "blend", components: [{ slot: 1, ratio: 1 }, { slot: 2, ratio: 1 }] });
    const all = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, i % 2 ? RGB.g : RGB.r]));
    expect(code(() => buildExport(p, settings(all, { target: "bambu" }), { date: DATE }))).toBe("EXPORT_BAMBU_LIMIT");
    expect(code(() => buildExport(p, settings(all, { target: "snapmaker" }), { date: DATE }))).toBeUndefined();
    expect(code(() => buildExport(p, settings(all, { target: "prusa" }), { date: DATE }))).toBeUndefined();
    // without the blend the 16 spools alone are fine
    p.setPin(1, { kind: "spool", slot: 1 });
    expect(code(() => buildExport(p, settings(all, { target: "bambu" }), { date: DATE }))).toBeUndefined();
  });

  it("refuses a Prusa export whose extruder ids a paint string cannot address", () => {
    const n = 300; // colors, each painted on its own triangle and pinned to a distinct blend
    const turns = Array(n / 2).fill(0);
    const p = createProject(makeModel(stripMesh(turns), { filaments: [{ color: RGB.r }] }), { name: "many" });
    const pins: { slot: number; other: number; ra: number; rb: number }[] = [];
    for (let a = 1; a <= 16; a++) for (let b = a + 1; b <= 16; b++) for (const [ra, rb] of [[1, 1], [1, 2], [2, 1]]) pins.push({ slot: a, other: b, ra, rb });
    expect(pins.length).toBeGreaterThan(n);
    for (let i = 0; i < n; i++) {
      const state = i === 0 ? 1 : p.addColor(`#${(i * 37).toString(16).padStart(6, "0")}`);
      p.paintTriangles(0, [i], state);
      const q = pins[i];
      p.setPin(state, { kind: "blend", components: [{ slot: q.slot, ratio: q.ra }, { slot: q.other, ratio: q.rb }] });
    }
    const all = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i + 1, i % 2 ? RGB.g : RGB.r]));
    expect(code(() => buildExport(p, settings(all, { target: "prusa" }), { date: DATE }))).toBe("EXPORT_TOO_MANY");
  });
});

describe("the exported file", () => {
  it("is a zip of the entries that a re-import can read", async () => {
    const project = createProject(makeModel(cubeMesh(), { paints: [leaf(1), leaf(2)], filaments: [{ color: RGB.r }, { color: RGB.g }] }), { name: "z" });
    const r = buildExport(project, settings({ 1: RGB.r, 2: RGB.g }), { date: DATE });
    const files = await unzipAll(await zipAll(r.entries));
    expect([...files.keys()]).toEqual(r.entries.map((e) => e.name));
  });
});
