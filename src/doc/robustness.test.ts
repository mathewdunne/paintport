// Failure handling and bounded memory of the document: faulty subscribers, interrupted strokes,
// no-op strokes, the undo byte budget, modifier base colors and all-or-nothing deletes.
import { describe, expect, it, vi } from "vitest";
import { cubeMesh, leaf, makeModel, makeMultiModel, split2, stripMesh, tree, type ModelSpec } from "../../test/support/docFixtures";
import { ViewerSim } from "../../test/support/viewerSim";
import { resolveDisplayStates } from "./display";
import { DocError } from "./errors";
import { createProject, type Project, type ProjectOptions } from "./project";
import { toSnapshot } from "./snapshot";
import { partId } from "./types";
import { TrianglePaintField } from "./trianglePaintField";

const RED = { color: "#FF0000" }, GREEN = { color: "#00FF00" }, BLUE = { color: "#0000FF" };

/** Cube with colors 1 red, 2 green, 3 blue, base 2; tri 0 leaf 1, tri 1 leaf 2, tri 2 split tree (1 | 3), tri 3 leaf 3. */
function fixture(spec: ModelSpec = {}, options: ProjectOptions = {}): Project {
  return createProject(makeModel(cubeMesh(), {
    filaments: [RED, GREEN, BLUE],
    parts: [{ firstTri: 0, triCount: 12, extruder: 2, type: "ModelPart", name: null }],
    paints: [leaf(1), leaf(2), tree(split2(1, 3)), leaf(3)],
    ...spec,
  }), options);
}
const field = (p: Project, i = 0) => p.fields[i] as TrianglePaintField;
const codeOf = (fn: () => void): string | undefined => {
  try { fn(); } catch (e) { return e instanceof DocError ? e.code : `other: ${String(e)}`; }
  return undefined;
};

describe("faulty subscribers", () => {
  it("records the edit before notifying, and a throwing subscriber cannot corrupt the document", () => {
    const p = fixture();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let reached = 0;
      p.subscribe(() => { throw new Error("viewer bug"); });
      p.subscribe(() => { reached++; });
      const initial = toSnapshot(p);
      expect(p.paintTriangles(0, [4], 1)).toBe(1);
      expect(p.undoCount).toBe(1); // recorded although the first subscriber threw
      expect(reached).toBeGreaterThan(0); // and the next subscriber still heard it
      expect(spy).toHaveBeenCalled();
      p.setColor(1, "#123456");
      p.deleteColor(3, 1);
      p.batch(() => { p.addColor("#000001"); p.paintTriangles(0, [5], 2); });
      expect(p.undoCount).toBe(4);
      while (p.undo()) { /* unwind */ }
      expect(toSnapshot(p)).toEqual(initial);
      while (p.redo()) { /* and back */ }
      expect(p.undoCount).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });

  it("a subscriber that throws during undo does not lose the redo step", () => {
    const p = fixture();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      p.paintTriangles(0, [4], 1);
      p.subscribe(() => { throw new Error("boom"); });
      expect(p.undo()).toBe(true);
      expect(p.canRedo).toBe(true);
      expect(p.redo()).toBe(true);
      expect(field(p).states[4]).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("interrupted strokes", () => {
  it("endAllStrokes closes a stroke that was begun twice and ended once", () => {
    const p = fixture();
    const sim = new ViewerSim(p);
    p.beginStroke();
    p.beginStroke();
    p.paintTriangles(0, [4], 1);
    p.endStroke();
    expect(p.strokeOpen).toBe(true);
    expect(p.canUndo).toBe(false);
    sim.clear();
    p.endAllStrokes();
    expect(p.strokeOpen).toBe(false);
    expect(p.undoCount).toBe(1);
    expect(p.canUndo).toBe(true);
    expect(sim.events).toEqual([{ kind: "history" }]);
    p.endAllStrokes(); // nothing open: harmless
    expect(sim.events).toHaveLength(1);
    p.endStroke();
    expect(p.undoCount).toBe(1);
  });

  it("announces opening and closing a stroke with a history event", () => {
    const p = fixture();
    const sim = new ViewerSim(p);
    p.beginStroke();
    expect(sim.events).toEqual([{ kind: "history" }]);
    p.beginStroke(); // nested: nothing new
    expect(sim.events).toHaveLength(1);
    p.endStroke();
    p.endStroke();
    expect(sim.events).toEqual([{ kind: "history" }, { kind: "history" }]);
  });

  it("works again after an interrupted stroke was closed", () => {
    const p = fixture();
    p.beginStroke();
    p.beginStroke();
    p.paintTriangles(0, [4], 1);
    p.endAllStrokes();
    p.paintTriangles(0, [5], 1);
    expect(p.undoCount).toBe(2);
    expect(p.undo()).toBe(true);
    expect(p.undo()).toBe(true);
  });

  it("batch stays safe when the stroke was closed from inside", () => {
    const p = fixture();
    p.batch(() => { p.paintTriangles(0, [4], 1); p.endAllStrokes(); });
    expect(p.strokeOpen).toBe(false);
    expect(p.undoCount).toBe(1);
  });
});

describe("setColor inside a stroke", () => {
  it("leaves no step, and keeps redo, when the value ends where it started", () => {
    const p = fixture();
    p.paintTriangles(0, [4], 1);
    p.undo();
    expect(p.canRedo).toBe(true);
    const palette = p.palette;
    p.beginStroke();
    p.setColor(1, "#101010");
    p.setColor(1, "#202020");
    p.setColor(1, "#FF0000"); // back to the start value
    p.endStroke();
    expect(p.undoCount).toBe(0);
    expect(p.canRedo).toBe(true);
    expect(p.palette).toBe(palette);
  });

  it("keeps the ColorMix hint when the value returns, and drops it when it does not", () => {
    const make = () => createProject(makeModel(cubeMesh(), {
      filaments: [RED, { color: "#30F845", mix: [{ extruder: 1, ratio: 1 }] }],
      paints: [leaf(2)],
    }));
    const p = make();
    p.beginStroke();
    p.setColor(2, "#000000");
    expect(p.palette[2].mix).toBeUndefined(); // while it differs
    p.setColor(2, "#30F845");
    expect(p.palette[2].mix).toEqual([{ extruder: 1, ratio: 1 }]);
    p.endStroke();
    expect(p.palette[2]).toEqual({ color: "#30F845", known: true, mix: [{ extruder: 1, ratio: 1 }] });
    expect(p.undoCount).toBe(0); // the value ended where it began: no step
  });

  it("drops the hint for a final value that differs", () => {
    const q = createProject(makeModel(cubeMesh(), { filaments: [RED, { color: "#30F845", mix: [{ extruder: 1, ratio: 1 }] }], paints: [leaf(2)] }));
    q.beginStroke();
    q.setColor(2, "#000000");
    q.setColor(2, "#111111");
    q.endStroke();
    expect(q.palette[2].mix).toBeUndefined();
    expect(q.undoCount).toBe(1);
    q.undo();
    expect(q.palette[2].mix).toEqual([{ extruder: 1, ratio: 1 }]);
  });

  it("does not let a dropped no-op change overwrite later edits of the same stroke", () => {
    const p = fixture();
    p.beginStroke();
    p.setColor(1, "#101010");
    p.setColor(1, "#FF0000"); // back where it began: this run is dropped
    p.paintTriangles(0, [4], 1);
    p.setColor(1, "#222222"); // a later, real change
    p.endStroke();
    expect(p.palette[1].color).toBe("#222222");
    p.undo();
    expect(p.palette[1].color).toBe("#FF0000");
    expect(field(p).states[4]).toBe(0);
  });

  it("still records a stroke that changes a color and also paints", () => {
    const p = fixture();
    p.batch(() => { p.setColor(1, "#101010"); p.setColor(1, "#FF0000"); p.paintTriangles(0, [4], 1); });
    expect(p.undoCount).toBe(1);
    p.undo();
    expect(field(p).states[4]).toBe(0);
  });
});

describe("palette events list the changed states", () => {
  it("names the states whose color changed, on edit, undo and redo", () => {
    const p = fixture();
    const sim = new ViewerSim(p);
    p.setColor(2, "#123456");
    expect(sim.events[0]).toEqual({ kind: "palette", renumbered: false, changed: [2] });
    sim.clear();
    p.undo();
    expect(sim.events[0]).toEqual({ kind: "palette", renumbered: false, changed: [2] });
    sim.clear();
    p.batch(() => { p.setColor(3, "#000003"); p.setColor(1, "#000001"); });
    p.undo();
    expect(sim.events.filter((e) => e.kind === "palette").at(-1)).toEqual({ kind: "palette", renumbered: false, changed: [1, 3] });
  });

  it("is empty when only the known flag changes, and for a renumbering", () => {
    const p = createProject(makeModel(cubeMesh(), { filaments: [RED, null], paints: [leaf(2)] }));
    const sim = new ViewerSim(p);
    p.setColor(2, p.palette[2].color); // accepts the generated color
    expect(sim.events[0]).toEqual({ kind: "palette", renumbered: false, changed: [] });
    sim.clear();
    p.deleteColor(2, 1);
    expect(sim.events[0]).toEqual({ kind: "palette", renumbered: true, changed: [] });
  });
});

describe("undo memory budget", () => {
  it("evicts the oldest steps beyond the byte budget, keeping the newest", () => {
    const probe = fixture({}, { undoByteLimit: 1e9 });
    probe.paintTriangles(0, [4], 1);
    const one = probe.undoBytes;
    expect(one).toBeGreaterThan(0);

    const p = fixture({}, { undoByteLimit: one * 5 + 1 });
    for (let i = 0; i < 40; i++) p.paintTriangles(0, [4], i % 2 === 0 ? 1 : 3);
    expect(p.undoCount).toBe(5);
    expect(p.undoBytes).toBeLessThanOrEqual(one * 5 + 1);
    let undone = 0;
    while (p.undo()) undone++;
    expect(undone).toBe(5);
  });

  it("always keeps the newest step even when it alone exceeds the budget", () => {
    const p = fixture({}, { undoByteLimit: 10 });
    p.paintTriangles(0, [4, 5, 6, 7, 8, 9], 1);
    expect(p.undoCount).toBe(1);
    expect(p.undoBytes).toBeGreaterThan(10);
    p.paintTriangles(0, [4, 5, 6], 2);
    expect(p.undoCount).toBe(1); // the older one made room
    expect(p.undo()).toBe(true);
    expect(field(p).states[4]).toBe(1);
  });

  it("evicts a compound step as a whole, and what is left still undoes consistently", () => {
    const probe = fixture({}, { undoByteLimit: 1e9 });
    probe.paintTriangles(0, [4], 1);
    const p = fixture({}, { undoByteLimit: probe.undoBytes * 6 });
    p.paintTriangles(0, [6], 3);
    p.deleteColor(1, 3); // a compound step: merge, renumber and palette
    const afterDelete = toSnapshot(p);
    for (let i = 0; i < 40; i++) p.paintTriangles(0, [4], i % 2 === 0 ? 1 : 2);
    expect(p.undoCount).toBeLessThan(40);
    while (p.undo()) { /* unwind what is left */ }
    // The delete is no longer undoable, so it stays fully applied: nothing half-reverted.
    expect(toSnapshot(p).paint.palette).toEqual(afterDelete.paint.palette);
    expect(p.palette).toHaveLength(3);
    expect(Math.max(...field(p).states)).toBeLessThanOrEqual(p.palette.length - 1);
    expect(toSnapshot(p).paint.objects[0].partBases).toEqual(afterDelete.paint.objects[0].partBases);
  });

  it("when a batch is the oldest step it goes whole, and the rest unwinds without touching it", () => {
    const probe = fixture({}, { undoByteLimit: 1e9 });
    probe.paintTriangles(0, [4], 1);
    const p = fixture({}, { undoByteLimit: probe.undoBytes * 12 });
    p.batch(() => { p.addColor("#010101"); p.paintTriangles(0, [5], 4); p.setBaseColor(0, 0, 4); });
    const afterBatch = toSnapshot(p);
    for (let i = 0; i < 30; i++) p.paintTriangles(0, [6], i % 2 === 0 ? 1 : 2);
    expect(p.undoCount).toBeLessThanOrEqual(12);
    while (p.undo()) { /* unwind */ }
    const left = toSnapshot(p);
    expect(left.paint.palette).toEqual(afterBatch.paint.palette);
    expect(left.paint.objects[0].partBases).toEqual(afterBatch.paint.objects[0].partBases);
    expect(left.paint.objects[0].states[5]).toBe(4);
  });

  it("stores a one-color fill without a per-triangle after array", () => {
    const quads = 1500;
    const p = createProject(makeModel(stripMesh(Array(quads - 1).fill(0)), { filaments: [RED, GREEN] }), { undoByteLimit: 1e9 });
    p.addColor("#336699");
    const n = quads * 2;
    p.paintTriangles(0, Array.from({ length: n }, (_, i) => i), 2);
    expect(p.undoBytes).toBeLessThan(n * 7); // tris (4) + before (2) + overhead, not + after (2)
  });

  it("uses the default budget of 256 MB", () => {
    expect(fixture().undoByteLimit).toBe(256 * 1024 * 1024);
  });
});

describe("modifier base colors", () => {
  const withModifier = () => fixture({
    parts: [
      { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
      { firstTri: 8, triCount: 4, extruder: 3, type: "ParameterModifier", name: null },
    ],
  });

  it("counts as a base use, and follows deletions", () => {
    const p = withModifier();
    expect(p.baseColor.get(partId(0, 1))).toBe(3);
    expect(p.basePartsOf(3)).toEqual([partId(0, 1)]);
    expect(p.isBaseColor(3)).toBe(true);
    expect(codeOf(() => p.deleteColor(3, 0))).toBe("BASE_IN_USE");
    p.deleteColor(3, 2); // blue into green: the modifier's extruder follows
    expect(p.baseColor.get(partId(0, 1))).toBe(2);
    p.undo();
    expect(p.baseColor.get(partId(0, 1))).toBe(3);
  });

  it("is in the palette even if nothing else uses it", () => {
    const p = createProject(makeModel(cubeMesh(), {
      filaments: [RED, GREEN, BLUE],
      parts: [
        { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
        { firstTri: 8, triCount: 4, extruder: 3, type: "ParameterModifier", name: null },
      ],
    }));
    expect(p.palette.slice(1).map((c) => c.color)).toEqual(["#FF0000", "#0000FF"]);
    expect(p.baseColor.get(partId(0, 1))).toBe(2);
  });

  it("can be set per part, but not by the object-wide recolor, and is never drawn or painted", () => {
    const p = withModifier();
    expect(p.setBaseColor(0, 1, 1)).toBe(true);
    expect(p.setObjectBaseColor(0, 2)).toBe(true);
    expect(p.baseColor.get(partId(0, 0))).toBe(2);
    expect(p.baseColor.get(partId(0, 1))).toBe(1); // untouched
    expect(p.paintTriangles(0, [8, 9], 1)).toBe(0);
    expect(p.stateShownAt(0, 9)).toBe(0);
    expect(Array.from(resolveDisplayStates(p, 0)).slice(8)).toEqual([0, 0, 0, 0]);
  });
});

describe("deleteColor is all or nothing", () => {
  it("leaves every object untouched when a later object cannot be renumbered", () => {
    const model = makeMultiModel(
      [{ mesh: cubeMesh(), spec: { paints: [leaf(1), leaf(3)] } }, { mesh: cubeMesh(), spec: { paints: [leaf(1), leaf(2)] } }],
      [RED, GREEN, BLUE],
    );
    const p = createProject(model);
    // Corrupt the second object so that its renumbering must fail (a state no table covers).
    field(p, 1).states[5] = 60000;
    const before = toSnapshot(p).paint;
    expect(() => p.deleteColor(1, 2)).toThrow(RangeError);
    const after = toSnapshot(p).paint;
    expect(after.palette).toEqual(before.palette);
    expect(after.objects[0]).toEqual(before.objects[0]); // object 0 was edited first, and rolled back
    expect(after.objects[1]).toEqual(before.objects[1]);
    expect(p.undoCount).toBe(0);
  });

  it("renumbering validates before it writes", () => {
    const f = new TrianglePaintField({ vertices: new Float64Array(9), tris: Int32Array.of(0, 1, 2), triCount: 1 }, Uint8Array.of(1), { states: Uint16Array.of(5) });
    expect(() => f.renumber(Uint16Array.of(0, 2), Uint16Array.of(0, 1))).toThrow(RangeError);
    expect(f.states[0]).toBe(5);
  });
});

describe("read-only field view", () => {
  it("does not offer edits on project.fields", () => {
    const p = fixture();
    const view = p.fields[0];
    // @ts-expect-error edits must go through the project: this must not compile
    void view.paintTriangles;
    expect(view.displayStates()).toBeInstanceOf(Uint16Array); // reading is fine
  });
});
