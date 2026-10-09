import { describe, expect, it } from "vitest";
import { load3MF, zipAll, type Model, type ZipEntry } from "../core";
import { binaryStl, CUBE_TRIS } from "../../test/support/fixtures";
import { cubeMesh, leaf, makeModel, makeMultiModel, split2, split3, tree } from "../../test/support/docFixtures";
import { defaultExportSettings, type ExportSettings } from "../persist/exportSettings";
import { buildExport } from "./export";
import { hashPositions } from "./geometryHash";
import { importProject } from "./importProject";
import { defaultSpools, EXPORT_TARGET_IDS, type ExportTargetId } from "./mapping";
import { createProject, type Project } from "./project";
import { fileSpools, fileSpoolsDiffer } from "./mapping";
import { buildSidecar, isSidecarMember, readSidecar, SIDECAR_JSON, sidecarPaintName } from "./sidecar";

const DATE = "2026-05-06";
const enc = new TextEncoder(), dec = new TextDecoder();

function settings(on: Record<number, string>, target: ExportTargetId): ExportSettings {
  const s = defaultExportSettings();
  s.target = target;
  s.printerCount = { prusa: 16, bambu: 16, snapmaker: 16 };
  s.spools = defaultSpools().map((sp) => (on[sp.slot] ? { ...sp, on: true, color: on[sp.slot] } : { ...sp, on: false }));
  return s;
}

async function exportBytes(project: Project, s: ExportSettings): Promise<{ entries: ZipEntry[]; bytes: Uint8Array }> {
  const { entries } = buildExport(project, s, { date: DATE });
  return { entries, bytes: await zipAll(entries) };
}

// --- a rich project --------------------------------------------------------------------------

/**
 * Object 0: ModelPart "head" (base file extruder 1), ModelPart "body" (2), a negative volume and a
 * modifier (3); preserved trees; a ColorMix hint on file color 4 and an undefined color 5.
 * Object 1: a flat object with two ModelParts of different base colors, a transform and printable=false.
 */
function richProject(): Project {
  const filaments = [{ color: "#FF0000" }, { color: "#00FF00" }, { color: "#0000FF" }, { color: "#123456", mix: [{ extruder: 1, ratio: 1 }, { extruder: 2, ratio: 1 }] }];
  const model = makeMultiModel([
    {
      mesh: cubeMesh(),
      spec: {
        paints: [tree(split2(1, 2)), leaf(3), tree(split3(2, 4, 5)), leaf(4), null, leaf(5)],
        parts: [
          { firstTri: 0, triCount: 4, extruder: 1, type: "ModelPart", name: "head" },
          { firstTri: 4, triCount: 2, extruder: 2, type: "ModelPart", name: "body &amp; soul" },
          { firstTri: 6, triCount: 2, extruder: 1, type: "NegativeVolume", name: "hole" },
          { firstTri: 8, triCount: 4, extruder: 3, type: "ParameterModifier", name: "mod" },
        ],
      },
    },
    {
      mesh: cubeMesh([4, 0, 0]),
      spec: {
        paints: [leaf(2), null, null, leaf(3)],
        parts: [
          { firstTri: 0, triCount: 6, extruder: 1, type: "ModelPart", name: null },
          { firstTri: 6, triCount: 6, extruder: 2, type: "ModelPart", name: null },
        ],
      },
    },
  ], filaments);
  model.objects[0].name = "Fig &amp; Co";
  model.objects[1].transform = "1 0 0 0 1 0 0 0 1 10 0 0";
  model.objects[1].printable = false;

  const p = createProject(model, { name: "fish" });
  p.addColor("#ABCDEF"); // an unused, user-made color
  p.setColor(2, "#00CC00");
  p.paintTriangles(0, [4, 5], 3); // repaint, and the surviving trees must not change
  p.paintTriangles(1, [1, 2], 5);
  // the two parts of object 0 export merged: both bases map to spool 3
  p.setPin(1, { kind: "spool", slot: 3 });
  p.setPin(2, { kind: "spool", slot: 3 });
  p.setPin(3, { kind: "blend", components: [{ slot: 1, ratio: 1 }, { slot: 2, ratio: 3 }] });
  p.setPin(5, { kind: "spool", slot: 2 });
  return p;
}

const SPOOLS = { 1: "#FF0000", 2: "#00FF00", 3: "#0000FF" };

/** What a restored project must share with the original, as plain comparable data. */
function summary(p: Project) {
  return {
    palette: p.palette,
    mapping: [...p.mapping].sort((a, b) => a[0] - b[0]),
    base: [...p.baseColor].sort(),
    name: p.source.name,
    filaments: p.source.filaments,
    objects: p.objects.map((o, i) => ({
      name: o.name, printable: o.printable, transform: o.transform, triCount: o.triCount,
      parts: o.parts.map((x) => ({ id: x.id, firstTri: x.firstTri, triCount: x.triCount, type: x.type, name: x.name })),
      paintable: [...o.paintable], triPart: [...o.triPart],
      states: [...p.fields[i].displayStates()],
      preserved: [...(p.fields[i] as unknown as { preserved: Map<number, string> }).preserved].sort((a, b) => a[0] - b[0]),
      positions: hashPositions(o.mesh),
    })),
  };
}

describe("the design sidecar round trip", () => {
  it.each(EXPORT_TARGET_IDS)("%s: export -> zip -> import restores the design exactly", async (target) => {
    const project = richProject();
    const { bytes } = await exportBytes(project, settings(SPOOLS, target));

    const fileModel = await load3MF(bytes);
    // without the sidecar the two parts of object 0 and the part bases of the flat bbs object are lost
    expect(fileModel.objects[0].parts.length).toBeLessThan(project.objects[0].parts.length);

    const back = await importProject("fish_export.3mf", bytes);
    expect(back.sidecar, back.reason).toBe("restored");
    expect(summary(back.project)).toEqual(summary(project));
    expect(back.project.source.name).toBe("fish"); // not "fish_export"
    expect(back.project.palette[6]).toEqual({ color: "#ABCDEF", known: true });
    expect(back.project.palette[4].mix).toEqual([{ extruder: 1, ratio: 1 }, { extruder: 2, ratio: 1 }]);
    expect(back.project.palette.some((c) => !c.known)).toBe(true);

    // exporting the restored project again writes the same files
    const again = buildExport(back.project, settings(SPOOLS, target), { date: DATE });
    const first = buildExport(project, settings(SPOOLS, target), { date: DATE });
    expect(again.entries.map((e) => [e.name, dec.decode(e.data)])).toEqual(first.entries.map((e) => [e.name, dec.decode(e.data)]));
  });

  it("keeps the original file's filaments, so hints and file spools still refer to the original file", async () => {
    // Spools unlike the file's colors: the hint of color 4 (blend of file extruders 1 and 2) must not apply.
    const other = { 1: "#EE0000", 2: "#00EE00", 3: "#0000EE" };
    for (const target of EXPORT_TARGET_IDS) {
      const project = richProject();
      const s = settings(other, target);
      const first = buildExport(project, s, { date: DATE });
      const { project: back, sidecar } = await importProject("again.3mf", await zipAll(first.entries));
      expect(sidecar).toBe("restored");
      expect(back.source.filaments).toEqual(project.source.filaments);
      // the re-imported file itself only knows the spools of the export
      const reimported = await load3MF(await zipAll(first.entries));
      expect(fileSpools({ filaments: reimported.filaments }).map((x) => x.color)).not.toEqual(fileSpools(project.source).map((x) => x.color));
      expect(fileSpoolsDiffer(s.spools, fileSpools(back.source), 16)).toBe(true); // the original spools are offered
      const again = buildExport(back, s, { date: DATE });
      expect(again.entries.map((e) => [e.name, dec.decode(e.data)]), target).toEqual(first.entries.map((e) => [e.name, dec.decode(e.data)]));
    }
  });

  it("gives parts the file extruder of the imported part they start in", async () => {
    const project = richProject();
    const { bytes } = await exportBytes(project, settings(SPOOLS, "prusa"));
    const back = (await importProject("x.3mf", bytes)).project;
    // both ModelParts of object 0 export as one volume with extruder 3
    expect(back.objects[0].parts.slice(0, 2).map((p) => p.extruder)).toEqual([3, 3]);
  });

  it("restores nothing when the file has no sidecar", async () => {
    const project = richProject();
    const { entries } = await exportBytes(project, settings(SPOOLS, "prusa"));
    const bytes = await zipAll(entries.filter((e) => !isSidecarMember(e.name)));
    const back = await importProject("plain.3mf", bytes);
    expect(back.sidecar).toBe("none");
    expect(back.reason).toBeUndefined();
    expect(summary(back.project)).toEqual(summary(createProject(await load3MF(bytes), { name: "plain" })));
    expect(back.project.source.name).toBe("plain");
  });

  it("treats leftover .bin files without the JSON as no sidecar", async () => {
    const { entries } = await exportBytes(richProject(), settings(SPOOLS, "prusa"));
    const back = await importProject("x.3mf", await zipAll(entries.filter((e) => e.name !== SIDECAR_JSON)));
    expect(back.sidecar).toBe("none");
  });

  it("has no sidecar for STL and OBJ", async () => {
    const back = await importProject("part.stl", binaryStl(CUBE_TRIS));
    expect(back.sidecar).toBe("none");
    expect(back.project.source.name).toBe("part");
    // an STL name is the file name, not XML text: nothing is unescaped
    expect((await importProject("R&amp;D.stl", binaryStl(CUBE_TRIS))).project.objects[0].name).toBe("R&amp;D");
  });
});

describe("the sidecar files", () => {
  it("lays out the paint binary as documented", () => {
    const model = makeModel(cubeMesh(), { paints: [leaf(2), tree(split2(1, 2)), null, tree(split3(2, 2, 1))], filaments: [{ color: "#FF0000" }, { color: "#00FF00" }] });
    const project = createProject(model, { name: "bin" });
    const [json, bin] = buildSidecar(project);
    expect(json.name).toBe(SIDECAR_JSON);
    expect(bin.name).toBe("Metadata/PaintPortPlus/object_0.bin");
    expect(sidecarPaintName(0)).toBe(bin.name);
    const dv = new DataView(bin.data.buffer, bin.data.byteOffset, bin.data.byteLength);
    expect(dec.decode(bin.data.subarray(0, 4))).toBe("PPDP");
    expect([dv.getUint16(4, true), dv.getUint16(6, true), dv.getUint32(8, true), dv.getUint32(12, true)]).toEqual([1, 0, 12, 2]);
    const states = Array.from({ length: 12 }, (_, t) => dv.getUint16(16 + 2 * t, true));
    expect(states).toEqual([...project.fields[0].displayStates()]);
    expect(states[0]).toBe(2);
    expect(states[1]).toBe(2); // dominant state of the tree (1,2): tie goes to the higher
    let at = 16 + 24;
    const entries: [number, string][] = [];
    for (let i = 0; i < 2; i++) {
      const len = dv.getUint32(at + 4, true);
      entries.push([dv.getUint32(at, true), dec.decode(bin.data.subarray(at + 8, at + 8 + len))]);
      at += 8 + len;
    }
    expect(at).toBe(bin.data.length);
    const preserved = (project.fields[0] as unknown as { preserved: Map<number, string> }).preserved;
    expect(entries).toEqual([[1, preserved.get(1)], [3, preserved.get(3)]]);
  });

  it("writes the document fields", () => {
    const project = richProject();
    const doc = JSON.parse(dec.decode(buildSidecar(project)[0].data)) as Record<string, unknown> & { objects: { triCount: number; hash: string; parts: Record<string, unknown>[] }[] };
    expect(doc).toMatchObject({ format: "paintport-plus-design", version: 1, app: expect.any(String), name: "fish" });
    expect((doc.palette as unknown[]).length).toBe(project.palette.length - 1);
    expect(doc.pins).toEqual([[1, { kind: "spool", slot: 3 }], [2, { kind: "spool", slot: 3 }], [3, { kind: "blend", components: [{ slot: 1, ratio: 1 }, { slot: 2, ratio: 3 }] }], [5, { kind: "spool", slot: 2 }]]);
    expect(doc.objects.map((o) => o.triCount)).toEqual([12, 12]);
    expect(doc.objects[0].hash).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.objects[0].parts).toEqual([
      { firstTri: 0, triCount: 4, type: "ModelPart", name: "head", base: 1 },
      { firstTri: 4, triCount: 2, type: "ModelPart", name: "body & soul", base: 2 },
      { firstTri: 6, triCount: 2, type: "NegativeVolume", name: "hole", base: 0 },
      { firstTri: 8, triCount: 4, type: "ParameterModifier", name: "mod", base: 3 },
    ]);
  });

  it("hashes positions, not vertex indices", () => {
    const a = { vertices: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), tris: Int32Array.from([0, 1, 2]) };
    // the same triangle with the vertices in another order, plus a vertex nobody uses
    const b = { vertices: Float64Array.from([9, 9, 9, 0, 1, 0, 1, 0, 0, 0, 0, 0]), tris: Int32Array.from([3, 2, 1]) };
    expect(hashPositions(a)).toBe(hashPositions(b));
    expect(hashPositions({ ...a, vertices: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 1e-9]) })).not.toBe(hashPositions(a));
    expect(hashPositions({ ...a, tris: Int32Array.from([0, 2, 1]) })).not.toBe(hashPositions(a)); // winding is part of the geometry
    expect(hashPositions({ vertices: Float64Array.from([-0, 0, 0, 1, 0, 0, 0, 1, 0]), tris: a.tris })).toBe(hashPositions(a)); // -0 is 0
  });

  it("recognizes its archive members", () => {
    expect(isSidecarMember(SIDECAR_JSON)).toBe(true);
    expect(isSidecarMember("Metadata/PaintPortPlus/object_3.bin")).toBe(true);
    expect(isSidecarMember("Metadata/project_settings.config")).toBe(false);
    expect(isSidecarMember("3D/3dmodel.model")).toBe(false);
  });
});

// --- hostile and mismatching sidecars ------------------------------------------------------------

describe("a sidecar that does not belong to the file is ignored", () => {
  /** One object: ModelPart 0..7 with trees, NegativeVolume 8..11. Palette: red, green. */
  function smallProject(): Project {
    const model = makeModel(cubeMesh(), {
      paints: [tree(split2(1, 2)), leaf(2), tree(split3(2, 1, 2))],
      parts: [
        { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
        { firstTri: 8, triCount: 4, extruder: 1, type: "NegativeVolume", name: "hole" },
      ],
      filaments: [{ color: "#FF0000" }, { color: "#00FF00" }],
    });
    return createProject(model, { name: "small" });
  }
  const spools = () => settings({ 1: "#FF0000", 2: "#00FF00" }, "prusa");

  async function entries(): Promise<ZipEntry[]> {
    return buildExport(smallProject(), spools(), { date: DATE }).entries.map((e) => ({ name: e.name, data: e.data.slice() }));
  }
  const find = (es: ZipEntry[], name: string): ZipEntry => es.find((e) => e.name === name)!;
  function editDoc(es: ZipEntry[], edit: (doc: any) => void): ZipEntry[] { // eslint-disable-line @typescript-eslint/no-explicit-any
    const e = find(es, SIDECAR_JSON);
    const doc = JSON.parse(dec.decode(e.data));
    edit(doc);
    e.data = enc.encode(JSON.stringify(doc));
    return es;
  }
  function editBin(es: ZipEntry[], edit: (b: Uint8Array, dv: DataView) => Uint8Array | void): ZipEntry[] {
    const e = find(es, sidecarPaintName(0));
    const out = edit(e.data, new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength));
    if (out) e.data = out;
    return es;
  }
  /** Offset of preserved entry `i` (they start after the header and the 12 states). */
  const entryAt = (_b: Uint8Array, dv: DataView, i: number): number => {
    let at = 16 + 24;
    for (let k = 0; k < i; k++) at += 8 + dv.getUint32(at + 4, true);
    return at;
  };

  async function ignored(es: ZipEntry[], reasonPart?: string) {
    const bytes = await zipAll(es);
    const back = await importProject("hostile.3mf", bytes);
    expect(back.sidecar, "outcome").toBe("ignored");
    if (reasonPart) expect(back.reason).toContain(reasonPart);
    // the file-based import is intact
    const fileBased = createProject(await load3MF(bytes), { name: "hostile" });
    expect(summary(back.project)).toEqual(summary(fileBased));
    expect(back.project.palette.length).toBeGreaterThan(1);
  }

  it("accepts the unmodified sidecar", async () => {
    expect((await importProject("x.3mf", await zipAll(await entries()))).sidecar).toBe("restored");
  });

  describe("document", () => {
    const docCases: [string, (doc: any) => void, string?][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ["another version", (d) => { d.version = 2; }, "version"],
      ["no version", (d) => { delete d.version; }, "version"],
      ["another format", (d) => { d.format = "something-else"; }, "design document"],
      ["missing palette", (d) => { delete d.palette; }],
      ["missing filaments", (d) => { delete d.filaments; }],
      ["filaments is not an array", (d) => { d.filaments = {}; }],
      ["a filament that is not an object", (d) => { d.filaments = [5]; }],
      ["a filament with a bad color", (d) => { d.filaments[0].color = 5; }],
      ["a filament with a malformed mix", (d) => { d.filaments[0].mix = [{ extruder: "x" }]; }],
      ["a filament without an index", (d) => { delete d.filaments[0].index; }],
      ["palette is not an array", (d) => { d.palette = {}; }],
      ["name is not a string", (d) => { d.name = 5; }],
      ["an extra object", (d) => { d.objects.push(d.objects[0]); }, "object count"],
      ["a missing object", (d) => { d.objects.pop(); }, "object count"],
      ["objects is not an array", (d) => { d.objects = "x"; }],
      ["the triangle count differs", (d) => { d.objects[0].triCount = 13; }],
      ["the geometry hash differs", (d) => { d.objects[0].hash = "0".repeat(16); }, "geometry"],
      ["the geometry hash is not a string", (d) => { d.objects[0].hash = 5; }],
      ["parts leave a gap", (d) => { d.objects[0].parts[1].firstTri = 9; }, "tile"],
      ["parts stop short", (d) => { d.objects[0].parts.pop(); }, "tile"],
      ["a part has no triangles", (d) => { d.objects[0].parts.splice(1, 0, { firstTri: 8, triCount: 0, type: "NegativeVolume", name: null, base: 0 }); }, "tile"],
      ["parts overrun", (d) => { d.objects[0].parts[1].triCount = 5; }, "tile"],
      ["parts is not an array", (d) => { d.objects[0].parts = {}; }],
      ["a part type the file does not have", (d) => { d.objects[0].parts[0].type = "ParameterModifier"; d.objects[0].parts[0].base = 1; }, "type"],
      ["an unknown part type", (d) => { d.objects[0].parts[0].type = "Banana"; }],
      ["a part name that is not a string", (d) => { d.objects[0].parts[0].name = 7; }],
      ["a base color on a negative volume", (d) => { d.objects[0].parts[1].base = 1; }],
      ["no base color on a ModelPart", (d) => { d.objects[0].parts[0].base = 0; }],
      ["a base color outside the palette", (d) => { d.objects[0].parts[0].base = 99; }],
      ["a negative base color", (d) => { d.objects[0].parts[0].base = -1; }],
      ["a fractional base color", (d) => { d.objects[0].parts[0].base = 1.5; }],
      ["a palette color that is not a color", (d) => { d.palette[0].color = "red"; }],
      ["a palette color in lower case", (d) => { d.palette[0].color = "#ff0000"; }],
      ["known is not a boolean", (d) => { d.palette[0].known = "yes"; }],
      ["a malformed mix hint", (d) => { d.palette[0].mix = [{ extruder: "a", ratio: 1 }]; }],
      ["a palette beyond the 16 bit states", (d) => { d.palette = Array.from({ length: 70000 }, () => ({ color: "#FF0000", known: true })); }],
      ["a pin of an unknown kind", (d) => { d.pins = [[1, { kind: "banana" }]]; }],
      ["a pin on a state outside the palette", (d) => { d.pins = [[9, { kind: "spool", slot: 1 }]]; }],
      ["a pin on state 0", (d) => { d.pins = [[0, { kind: "spool", slot: 1 }]]; }],
      ["unsorted pins", (d) => { d.pins = [[2, { kind: "spool", slot: 1 }], [1, { kind: "spool", slot: 1 }]]; }],
      ["a spool pin on slot 99", (d) => { d.pins = [[1, { kind: "spool", slot: 99 }]]; }],
      ["pins is not an array", (d) => { d.pins = "x"; }],
    ];
    it.each(docCases)("%s", async (_name, edit, reason) => {
      await ignored(editDoc(await entries(), edit), reason);
    });

    it("is not JSON", async () => {
      const es = await entries();
      find(es, SIDECAR_JSON).data = enc.encode("{ not json");
      await ignored(es);
    });

    it.each(["null", "[]", '"x"', "5", "{}", "true"])("is the JSON value %s", async (value) => {
      const es = await entries();
      find(es, SIDECAR_JSON).data = enc.encode(value);
      await ignored(es);
    });

    it("is empty", async () => {
      const es = await entries();
      find(es, SIDECAR_JSON).data = new Uint8Array(0);
      await ignored(es);
    });

    it("is larger than the cap", async () => {
      const es = editDoc(await entries(), (d) => { d.pad = "x".repeat(17 * 1024 * 1024); });
      await ignored(es, "too large");
    });

    it("is nested deeper than the JSON parser allows", async () => {
      const es = await entries();
      find(es, SIDECAR_JSON).data = enc.encode("[".repeat(100000) + "]".repeat(100000));
      await ignored(es);
    });
  });

  describe("paint binary", () => {
    it("is missing", async () => {
      await ignored((await entries()).filter((e) => e.name !== sidecarPaintName(0)), "missing");
    });

    const binCases: [string, (b: Uint8Array, dv: DataView) => Uint8Array | void, string?][] = [
      ["empty", () => new Uint8Array(0), "header"],
      ["too short for the header", (b) => b.slice(0, 15), "header"],
      ["bad magic", (b) => { b[0] = 0x58; }, "header"],
      ["another layout version", (_b, dv) => { dv.setUint16(4, 2, true); }, "version"],
      ["reserved field set", (_b, dv) => { dv.setUint16(6, 1, true); }, "version"],
      ["another triangle count", (_b, dv) => { dv.setUint32(8, 11, true); }, "triangle count"],
      ["a huge triangle count", (_b, dv) => { dv.setUint32(8, 0xffffffff, true); }, "triangle count"],
      ["more preserved trees than triangles", (_b, dv) => { dv.setUint32(12, 13, true); }, "size"],
      ["a huge preserved count", (_b, dv) => { dv.setUint32(12, 0xffffffff, true); }, "size"],
      ["one preserved tree too many", (_b, dv) => { dv.setUint32(12, 3, true); }, "cut off"],
      ["one preserved tree fewer", (_b, dv) => { dv.setUint32(12, 1, true); }, "trailing"],
      ["cut in the states", (b) => b.slice(0, 30), "size"],
      ["cut in the last tree", (b) => b.slice(0, b.length - 1), "length"],
      ["a trailing byte", (b) => { const o = new Uint8Array(b.length + 1); o.set(b); return o; }, "trailing"],
      ["a huge tree length", (b, dv) => { dv.setUint32(entryAt(b, dv, 0) + 4, 0xffffffff, true); }, "length"],
      ["a zero tree length", (b, dv) => { dv.setUint32(entryAt(b, dv, 0) + 4, 0, true); }, "length"],
      ["a tree length past the end", (b, dv) => { dv.setUint32(entryAt(b, dv, 1) + 4, 9999, true); }, "length"],
      ["a tree on a triangle outside the mesh", (b, dv) => { dv.setUint32(entryAt(b, dv, 0), 12, true); }, "triangle"],
      ["trees out of order", (b, dv) => { dv.setUint32(entryAt(b, dv, 0), 5, true); }, "triangle"],
      ["a tree with non-hex characters", (b, dv) => { b[entryAt(b, dv, 0) + 8] = 0x47; }, "characters"],
      ["a state outside the palette", (_b, dv) => { dv.setUint16(16 + 2 * 3, 3, true); }],
      ["a huge state", (_b, dv) => { dv.setUint16(16 + 2 * 3, 0xffff, true); }],
      ["paint on a negative volume", (_b, dv) => { dv.setUint16(16 + 2 * 9, 1, true); }],
      ["a tree on a triangle that is not print surface", (b, dv) => { dv.setUint32(entryAt(b, dv, 1), 9, true); }],
      ["a tree whose dominant state disagrees with the state", (_b, dv) => { dv.setUint16(16, 1, true); dv.setUint16(18, 1, true); dv.setUint16(20, 1, true); }],
    ];
    it.each(binCases)("%s", async (_name, edit, reason) => {
      await ignored(editBin(await entries(), edit), reason);
    });

    /** `bin` with the tree of preserved entry `entry` replaced (sizes fixed up). */
    function withTree(b: Uint8Array, entry: number, text: string): Uint8Array {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const at = entryAt(b, dv, entry), oldLength = dv.getUint32(at + 4, true), t = enc.encode(text);
      const out = new Uint8Array(b.length - oldLength + t.length);
      out.set(b.subarray(0, at + 8));
      out.set(t, at + 8);
      out.set(b.subarray(at + 8 + oldLength), at + 8 + t.length);
      new DataView(out.buffer).setUint32(at + 4, t.length, true);
      return out;
    }

    it.each([
      ["a tree that ends too early", "F", undefined],
      ["a tree with trailing nibbles", "4444", undefined],
      ["a tree that is only a leaf", "8", undefined],
      ["a tree cut off inside a leaf marker", "9C1", undefined],
      ["a very deep tree", "1".repeat(60000), undefined],
      ["a tree over the length cap", "1".repeat(70000), "length"],
    ] as [string, string, string | undefined][])("%s", async (_name, text, reason) => {
      await ignored(editBin(await entries(), (b) => withTree(b, 0, text)), reason);
    });
  });

  describe("geometry", () => {
    async function geometryEdited(edit: (xml: string) => string) {
      const es = await entries();
      const model = find(es, "3D/3dmodel.model");
      const xml = edit(dec.decode(model.data));
      expect(xml).not.toBe(dec.decode(model.data));
      model.data = enc.encode(xml);
      return es;
    }

    it("a vertex moved", async () => {
      await ignored(await geometryEdited((x) => x.replace(/<vertex x="([^"]+)"/, (_m, v: string) => `<vertex x="${Number(v) + 0.25}"`)), "geometry");
    });

    it("a triangle that points at another vertex", async () => {
      await ignored(await geometryEdited((x) => x.replace(/<triangle v1="(\d+)" v2="(\d+)"/, '<triangle v1="$2" v2="$1"')), "geometry");
    });

    it("a triangle removed", async () => {
      await ignored(await geometryEdited((x) => x.replace(/ *<triangle [^>]*\/>\n/, "")));
    });

    it("another object count", async () => {
      const es = await entries();
      const copy = buildExport(createProject(makeMultiModel([{ mesh: cubeMesh() }, { mesh: cubeMesh([3, 0, 0]) }], [{ color: "#FF0000" }]), { name: "two" }), settings({ 1: "#FF0000" }, "prusa"), { date: DATE }).entries;
      // the sidecar of a one-object project next to the model of a two-object project
      const merged = [...copy.filter((e) => !isSidecarMember(e.name)), ...es.filter((e) => isSidecarMember(e.name))];
      await ignored(merged, "object count");
    });

    it("another file's sidecar next to this file's model", async () => {
      const other = createProject(makeModel(cubeMesh([1, 1, 1]), { paints: [leaf(1)], filaments: [{ color: "#FF0000" }] }), { name: "o" });
      const otherEntries = buildExport(other, settings({ 1: "#FF0000" }, "prusa"), { date: DATE }).entries;
      const merged = [...(await entries()).filter((e) => !isSidecarMember(e.name)), ...otherEntries.filter((e) => isSidecarMember(e.name))];
      await ignored(merged);
    });
  });

  it("readSidecar never throws for arbitrary members", () => {
    const model: Model = makeModel(cubeMesh());
    const garbage = new Map<string, Uint8Array>([[SIDECAR_JSON, new Uint8Array([0xff, 0xfe, 0x00, 0x7b])], [sidecarPaintName(0), new Uint8Array(3)]]);
    expect(readSidecar(garbage, model).status).toBe("ignored");
    expect(readSidecar(new Map(), model)).toEqual({ status: "none" });
  });
});
