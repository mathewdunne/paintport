import { describe, expect, it } from "vitest";
import { cubeMesh, joinMeshes, leaf, makeModel, split2, split3, stripMesh, tree } from "../../test/support/docFixtures";
import { DocError } from "./errors";
import { createProject, type Project } from "./project";
import {
  fromSnapshot, GEOMETRY_FORMAT, PAINT_FORMAT, ProjectSaver, restoreProject, SNAPSHOT_VERSION,
  toGeometrySnapshot, toPaintSnapshot, toSnapshot, type GeometrySnapshot, type PaintSnapshot, type ProjectSnapshot, type SnapshotStore,
} from "./snapshot";
import { partId } from "./types";

const TRI = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], tris: [0, 1, 2] };

/**
 * A prusa-dialect file with a cube and a strip as two ModelParts, a negative volume and a
 * modifier, ColorMix hints, an unknown color and printer identity.
 */
function richProject(): Project {
  const mesh = joinMeshes(cubeMesh(), stripMesh([15, 30]), TRI, TRI);
  const model = makeModel(mesh, {
    dialect: "prusa",
    filaments: [{ color: "#FF0000" }, { color: "#30F845", mix: [{ extruder: 1, ratio: 3 }, { extruder: 3, ratio: 1 }] }, null, { color: "#0000FF" }],
    parts: [
      { firstTri: 0, triCount: 12, extruder: 1, type: "ModelPart", name: "Body" },
      { firstTri: 12, triCount: 6, extruder: 4, type: "ModelPart", name: null },
      { firstTri: 18, triCount: 1, extruder: 2, type: "NegativeVolume", name: "Cut" },
      { firstTri: 19, triCount: 1, extruder: 3, type: "ParameterModifier", name: "Mod" },
    ],
    paints: [leaf(2, "prusa"), tree(split3(1, 3, 0), "prusa"), null, leaf(3, "prusa"), tree(split2(2, 1), "prusa")],
  });
  model.sourceIdentity = { printer_model: "Core One", filament_settings_id: ["PLA", "PETG"] };
  model.objects[0].name = "Fig <b>&</b>";
  model.objects[0].transform = "1 0 0 0 1 0 0 0 1 5 6 7";
  model.objects[0].printable = false;
  model.objects[0].defaultExtruder = 3;
  const p = createProject(model);
  p.addColor("#ABCDEF");
  p.setColor(1, "#010203");
  p.paintTriangles(0, [4, 13], 4);
  p.setBaseColor(0, 1, 2);
  return p;
}

const clone = (p: Project): ProjectSnapshot => structuredClone(toSnapshot(p));

describe("project snapshot", () => {
  it("round-trips everything through a structured clone", () => {
    const p = richProject();
    const snap = toSnapshot(p);
    const q = fromSnapshot(structuredClone(snap));
    expect(toSnapshot(q)).toEqual(snap);
    expect(q.id).toBe(p.id);

    expect(q.palette).toEqual(p.palette);
    expect(q.palette.some((c) => !c.known)).toBe(true);
    expect(q.palette.some((c) => c.mix)).toBe(true);
    expect(q.baseColor).toEqual(p.baseColor);
    expect(q.source).toEqual(p.source);
    expect(q.source.paintDialect).toBe("prusa");
    expect(q.source.sourceIdentity).toEqual({ printer_model: "Core One", filament_settings_id: ["PLA", "PETG"] });
    const [a, b] = [p.objects[0], q.objects[0]];
    expect(b).toMatchObject({ name: "Fig <b>&</b>", transform: "1 0 0 0 1 0 0 0 1 5 6 7", printable: false, fileExtruder: 3, triCount: a.triCount });
    expect(b.parts).toEqual(a.parts);
    expect(Array.from(b.triPart)).toEqual(Array.from(a.triPart));
    expect(Array.from(b.paintable)).toEqual(Array.from(a.paintable));
    expect(Array.from(q.fields[0].displayStates())).toEqual(Array.from(p.fields[0].displayStates()));
  });

  it("keeps the base color of a modifier but none for a negative volume", () => {
    const p = richProject();
    expect(p.baseColor.has(partId(0, 3))).toBe(true);
    expect(p.baseColor.has(partId(0, 2))).toBe(false);
    const q = fromSnapshot(clone(p));
    expect(q.baseColor).toEqual(p.baseColor);
  });

  it("keeps typed arrays typed", () => {
    const snap = clone(richProject());
    expect(snap.geometry.objects[0].vertices).toBeInstanceOf(Float64Array);
    expect(snap.geometry.objects[0].tris).toBeInstanceOf(Int32Array);
    const o = snap.paint.objects[0];
    expect(o.states).toBeInstanceOf(Uint16Array);
    expect(o.preservedTris).toBeInstanceOf(Uint32Array);
    expect(o.preservedTris.length).toBe(o.preservedTrees.length);
    expect(o.preservedTris.length).toBeGreaterThan(0);
  });

  it("restores a project that edits and undoes like the original", () => {
    const p = richProject();
    const start = toSnapshot(p);
    const q = fromSnapshot(clone(p));
    expect(q.canUndo).toBe(false); // the history is not persisted
    const script = (x: Project) => {
      x.paintSphere(0, [0.5, 0.5, 0], 0.4, 5);
      x.deleteColor(2, 1);
      x.setObjectBaseColor(0, 1);
      x.paintTriangles(0, x.smartFillRegion(0, 14, 90), 2);
    };
    script(p);
    script(q);
    expect(toSnapshot(q)).toEqual(toSnapshot(p));
    expect(q.undoCount).toBe(p.undoCount - 4); // the original also still holds the four setup edits of richProject
    while (q.undo()) { /* unwind */ }
    expect(toSnapshot(q)).toEqual(start);
  });

  it("is not changed by later edits", () => {
    const p = richProject();
    const snap = toSnapshot(p);
    const frozen = structuredClone(snap);
    p.paintTriangles(0, [0, 1, 2, 3], 3);
    p.deleteColor(3, 1);
    p.addColor("#000000");
    expect(snap).toEqual(frozen);
  });

  it("is canonical: undo and redo give back an equal snapshot", () => {
    const p = richProject();
    const snap = toSnapshot(p);
    p.paintTriangles(0, [1, 2, 3], 1);
    p.undo();
    expect(toSnapshot(p)).toEqual(snap);
  });
});

describe("two halves", () => {
  it("the geometry half does not depend on edits and shares the project's arrays", () => {
    const p = richProject();
    const g = toGeometrySnapshot(p);
    expect(g.objects[0].vertices).toBe(p.objects[0].mesh.vertices);
    expect(g.format).toBe(GEOMETRY_FORMAT);
    const hash = g.geometryHash;
    p.paintTriangles(0, [0, 1], 2);
    p.deleteColor(1, 2);
    expect(toGeometrySnapshot(p).geometryHash).toBe(hash);
    expect(toPaintSnapshot(p).geometryHash).toBe(hash);
    expect(toPaintSnapshot(p).format).toBe(PAINT_FORMAT);
  });

  it("the paint half is small compared with the geometry", () => {
    const p = createProject(makeModel(cubeMesh()));
    const paint = toPaintSnapshot(p);
    expect(paint).not.toHaveProperty("objects.0.vertices");
    expect(Object.keys(paint.objects[0]).sort()).toEqual(["partBases", "preservedTrees", "preservedTris", "states"]);
  });

  it("refuses halves that belong to different projects, even identical-looking ones", () => {
    const a = clone(richProject()), b = clone(richProject());
    expect(() => fromSnapshot({ geometry: a.geometry, paint: b.paint })).toThrow(DocError);
    try { fromSnapshot({ geometry: a.geometry, paint: b.paint }); } catch (e) { expect((e as DocError).code).toBe("SNAPSHOT_INVALID"); }
  });

  it("refuses a geometry that no longer matches its hash", () => {
    const s = clone(richProject());
    s.geometry.objects[0].vertices[0] += 0.5;
    expect(() => fromSnapshot(s)).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
    const t = clone(richProject());
    t.paint.geometryHash = "0".repeat(16);
    expect(() => fromSnapshot(t)).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
  });
});

describe("snapshot errors", () => {
  const code = (value: unknown): string | undefined => {
    try { fromSnapshot(value); } catch (e) { return e instanceof DocError ? e.code : `other: ${String(e)}`; }
    return undefined;
  };
  /** Applies a corruption to a fresh snapshot and returns the error code. */
  const corrupt = (fn: (s: ProjectSnapshot) => void): string | undefined => {
    const s = clone(richProject());
    fn(s);
    return code(s);
  };

  it("accepts a valid snapshot", () => {
    expect(code(clone(richProject()))).toBeUndefined();
  });

  it("reports another version with its own code, from either half", () => {
    expect(SNAPSHOT_VERSION).toBe(1);
    expect(corrupt((s) => { s.geometry.version = 2; })).toBe("SNAPSHOT_VERSION");
    expect(corrupt((s) => { s.paint.version = 0; })).toBe("SNAPSHOT_VERSION");
    expect(corrupt((s) => { (s.paint as { version?: number }).version = undefined; })).toBe("SNAPSHOT_VERSION");
  });

  it("rejects things that are not snapshots", () => {
    for (const v of [null, undefined, "snapshot", 5, [], {}, { geometry: null, paint: null }, { geometry: {}, paint: {} }]) expect(code(v)).toBe("SNAPSHOT_INVALID");
    expect(corrupt((s) => { (s.geometry as { format: string }).format = "other"; })).toBe("SNAPSHOT_INVALID");
    expect(corrupt((s) => { (s.paint as { format: string }).format = "other"; })).toBe("SNAPSHOT_INVALID");
  });

  it("turns hostile types into SNAPSHOT_INVALID, never into a TypeError", () => {
    const any = (x: unknown) => x as never;
    const cases: Record<string, (s: ProjectSnapshot) => void> = {
      "palette mix is a number": (s) => { (s.paint.palette[0] as { mix?: unknown }).mix = 5; },
      "palette mix entries are null": (s) => { (s.paint.palette[0] as { mix?: unknown }).mix = [null]; },
      "palette entry is null": (s) => { s.paint.palette[0] = any(null); },
      "palette is not an array": (s) => { (s.paint as { palette: unknown }).palette = {}; },
      "color is a number": (s) => { (s.paint.palette[0] as { color: unknown }).color = 5; },
      "known is a string": (s) => { (s.paint.palette[0] as { known: unknown }).known = "yes"; },
      "parts hold null": (s) => { s.geometry.objects[0].parts = any([null]); },
      "part type is unknown": (s) => { (s.geometry.objects[0].parts[0] as { type: string }).type = "Blob"; },
      "part type is __proto__": (s) => { (s.geometry.objects[0].parts[0] as { type: string }).type = "__proto__"; },
      "part name is a number": (s) => { (s.geometry.objects[0].parts[0] as { name: unknown }).name = 3; },
      "part extruder is a string": (s) => { (s.geometry.objects[0].parts[0] as { extruder: unknown }).extruder = "2"; },
      "objects hold null": (s) => { s.geometry.objects = any([null]); },
      "paint objects hold null": (s) => { s.paint.objects = any([null]); },
      "object name is a number": (s) => { (s.geometry.objects[0] as { name: unknown }).name = 7; },
      "transform is a number": (s) => { (s.geometry.objects[0] as { transform: unknown }).transform = 7; },
      "printable is a string": (s) => { (s.geometry.objects[0] as { printable: unknown }).printable = "no"; },
      "fileExtruder is negative": (s) => { s.geometry.objects[0].fileExtruder = -1; },
      "fileExtruder is NaN": (s) => { s.geometry.objects[0].fileExtruder = NaN; },
      "vertices are a plain array": (s) => { s.geometry.objects[0].vertices = any([1, 2, 3]); },
      "states are a plain array": (s) => { s.paint.objects[0].states = any([0, 0]); },
      "partBases hold strings": (s) => { s.paint.objects[0].partBases = any(["1", "1", "0", "1"]); },
      "partBases is missing": (s) => { delete (s.paint.objects[0] as { partBases?: unknown }).partBases; },
      "source is null": (s) => { (s.geometry as { source: unknown }).source = null; },
      "sourceIdentity is an array": (s) => { (s.geometry.source as { sourceIdentity: unknown }).sourceIdentity = []; },
      "filaments hold null": (s) => { s.geometry.source.filaments = any([null]); },
      "filament color is a number": (s) => { (s.geometry.source.filaments[0] as { color: unknown }).color = 1; },
      "filament mix is a string": (s) => { (s.geometry.source.filaments[1] as { mix: unknown }).mix = "x"; },
      "filament mix ratio is a string": (s) => { (s.geometry.source.filaments[1].mix![0] as { ratio: unknown }).ratio = "2"; },
      "projectId is a number": (s) => { (s.paint as { projectId: unknown }).projectId = 1; },
      "dialect is unknown": (s) => { (s.geometry.source as { paintDialect: string }).paintDialect = "v3"; },
    };
    for (const [name, fn] of Object.entries(cases)) expect(corrupt(fn), name).toBe("SNAPSHOT_INVALID");
  });

  it("turns an exception thrown while reading into SNAPSHOT_INVALID", () => {
    const trap = new Proxy({}, { get() { throw new Error("hostile getter"); } });
    expect(code(trap)).toBe("SNAPSHOT_INVALID");
    expect(code({ geometry: trap, paint: trap })).toBe("SNAPSHOT_INVALID");
  });

  it("rejects inconsistent contents instead of building a broken project", () => {
    const o = (s: ProjectSnapshot) => s.paint.objects[0];
    expect(corrupt((s) => { o(s).states = o(s).states.slice(1); })).toBe("SNAPSHOT_INVALID");
    expect(corrupt((s) => { o(s).states[0] = 99; })).toBe("SNAPSHOT_INVALID");
    expect(corrupt((s) => { o(s).preservedTrees = o(s).preservedTrees.slice(1); })).toBe("SNAPSHOT_INVALID");
    expect(corrupt((s) => { s.geometry.objects[0].tris[0] = 100000; })).toBe("SNAPSHOT_INVALID");
    expect(corrupt((s) => { s.geometry.objects[0].parts[0].triCount = 9999; })).toBe("SNAPSHOT_INVALID");
    expect(corrupt((s) => { o(s).partBases[0] = 0; })).toBe("SNAPSHOT_INVALID"); // a ModelPart needs a base color
    expect(corrupt((s) => { o(s).partBases[2] = 1; })).toBe("SNAPSHOT_INVALID"); // a negative volume has none
    expect(corrupt((s) => { o(s).partBases[3] = 0; })).toBe("SNAPSHOT_INVALID"); // a modifier has one
    expect(corrupt((s) => { o(s).partBases[0] = 99; })).toBe("SNAPSHOT_INVALID");
    expect(corrupt((s) => { s.paint.palette[0] = { color: "red", known: true }; })).toBe("SNAPSHOT_INVALID");
  });

  it("checks preserved trees: they must parse, stay inside the palette, agree with the state and sit on print surface", () => {
    const p = richProject();
    const field = p.fields[0] as unknown as { preserved: Map<number, string> };
    const [t0] = [...field.preserved.keys()];
    const good = field.preserved.get(t0)!;
    const withTree = (fn: (o: ProjectSnapshot["paint"]["objects"][0], idx: number) => void) => corrupt((s) => fn(s.paint.objects[0], s.paint.objects[0].preservedTris.indexOf(t0)));
    expect(withTree((o, i) => { o.preservedTrees[i] = "ZZ"; })).toBe("SNAPSHOT_INVALID"); // garbage
    expect(withTree((o, i) => { o.preservedTrees[i] = ""; })).toBe("SNAPSHOT_INVALID");
    expect(withTree((o, i) => { o.preservedTrees[i] = leaf(1); })).toBe("SNAPSHOT_INVALID"); // a plain leaf is not preserved detail
    expect(withTree((o, i) => { o.preservedTrees[i] = tree(split2(1, 99)); })).toBe("SNAPSHOT_INVALID"); // outside the palette
    expect(withTree((o, i) => { o.preservedTrees[i] = good.slice(1); })).toBe("SNAPSHOT_INVALID"); // truncated
    expect(withTree((o, i) => { o.states[o.preservedTris[i]] = 1; o.preservedTrees[i] = tree(split2(2, 2)); })).toBe("SNAPSHOT_INVALID"); // dominant 2, state 1
    expect(withTree((o, i) => { o.preservedTris[i] = 18; })).toBe("SNAPSHOT_INVALID"); // the negative volume
    expect(corrupt((s) => { s.paint.objects[0].states[18] = 1; })).toBe("SNAPSHOT_INVALID"); // paint on a negative volume
    expect(corrupt((s) => { s.paint.objects[0].states[19] = 1; })).toBe("SNAPSHOT_INVALID"); // ... and on a modifier
  });

  it("a restored project can delete colors without partial corruption", () => {
    const q = fromSnapshot(clone(richProject()));
    const before = toSnapshot(q);
    q.deleteColor(2, 1);
    q.undo();
    expect(toSnapshot(q)).toEqual(before);
  });
});

/** Two keys, like an IndexedDB store with a geometry and a paint record. */
function memoryStore(initial?: { geometry?: unknown; paint?: unknown }) {
  const log: string[] = [];
  const store = {
    geometry: initial?.geometry ?? null as unknown, paint: initial?.paint ?? null as unknown, cleared: 0, log,
    async loadGeometry() { return this.geometry; },
    async loadPaint() { return this.paint; },
    async saveGeometry(g: GeometrySnapshot) { log.push("geometry"); this.geometry = g; },
    async savePaint(p: PaintSnapshot) { log.push("paint"); this.paint = p; },
    async clear() { this.geometry = null; this.paint = null; this.cleared++; },
  };
  return store satisfies SnapshotStore;
}

describe("restoreProject", () => {
  it("reports an empty store", async () => {
    expect(await restoreProject(memoryStore())).toEqual({ status: "empty" });
  });

  it("restores a stored project", async () => {
    const p = richProject();
    const s = toSnapshot(p);
    const store = memoryStore(s);
    const r = await restoreProject(store);
    expect(r.status).toBe("restored");
    if (r.status === "restored") expect(toSnapshot(r.project)).toEqual(s);
    expect(store.cleared).toBe(0);
  });

  it("clears damaged data and says so", async () => {
    const s = clone(richProject());
    const junk = memoryStore({ geometry: { hello: "world" }, paint: 5 });
    expect((await restoreProject(junk)).status).toBe("invalid");
    expect(junk.cleared).toBe(1);
    const half = memoryStore({ geometry: s.geometry, paint: null }); // a crash between the two writes
    expect((await restoreProject(half)).status).toBe("invalid");
    expect(half.cleared).toBe(1);
  });

  it("leaves data of another version alone, so an old tab cannot destroy a newer save", async () => {
    const s = clone(richProject());
    s.paint.version = 99;
    s.geometry.version = 99;
    const store = memoryStore(s);
    const r = await restoreProject(store);
    expect(r.status).toBe("version");
    expect(store.cleared).toBe(0);
    expect(store.paint).toBe(s.paint);
  });

  it("does not hide storage failures", async () => {
    const broken = { ...memoryStore(), loadGeometry: () => Promise.reject(new Error("disk")) };
    await expect(restoreProject(broken)).rejects.toThrow("disk");
  });
});

describe("ProjectSaver", () => {
  it("writes the geometry once and then only the paint", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = richProject();
    await saver.save(p);
    p.paintTriangles(0, [5], 2);
    await saver.save(p);
    await saver.save(p);
    expect(store.log).toEqual(["geometry", "paint", "paint", "paint"]);
    const r = await restoreProject(store);
    expect(r.status === "restored" && toSnapshot(r.project)).toEqual(toSnapshot(p));
  });

  it("writes geometry again for a different project, always before its paint", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    await saver.save(richProject());
    await saver.save(richProject());
    expect(store.log).toEqual(["geometry", "paint", "geometry", "paint"]);
  });

  it("skips the geometry for a project that was restored from the store", async () => {
    const p = richProject();
    const store = memoryStore(toSnapshot(p));
    const saver = new ProjectSaver(store);
    const r = await restoreProject(store);
    if (r.status !== "restored") throw new Error("not restored");
    saver.adopt(r.project);
    await saver.save(r.project);
    expect(store.log).toEqual(["paint"]);
  });

  it("keeps overlapping saves in order", async () => {
    const store = memoryStore();
    const slow = { ...store, async saveGeometry(g: GeometrySnapshot) { await new Promise((r) => setTimeout(r, 20)); await store.saveGeometry(g); } };
    const saver = new ProjectSaver(slow);
    const p = richProject();
    await Promise.all([saver.save(p), saver.save(p), saver.save(p)]);
    expect(store.log).toEqual(["geometry", "paint", "paint", "paint"]);
  });

  it("retries the geometry after a failed write and does not wedge later saves", async () => {
    const store = memoryStore();
    let fail = true;
    const flaky = { ...store, async saveGeometry(g: GeometrySnapshot) { if (fail) { fail = false; throw new Error("quota"); } await store.saveGeometry(g); } };
    const saver = new ProjectSaver(flaky);
    const p = richProject();
    await expect(saver.save(p)).rejects.toThrow("quota");
    await saver.save(p);
    expect(store.log).toEqual(["geometry", "paint"]);
  });
});
