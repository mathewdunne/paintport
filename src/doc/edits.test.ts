import { describe, expect, it } from "vitest";
import { cubeMesh, leaf, makeModel, split2, tree, type ModelSpec } from "../../test/support/docFixtures";
import { ViewerSim } from "../../test/support/viewerSim";
import { resolveDisplayStates } from "./display";
import { DocError } from "./errors";
import { createProject, DEFAULT_UNDO_LIMIT, type Project } from "./project";
import { toSnapshot } from "./snapshot";
import { partId } from "./types";
import { TrianglePaintField } from "./trianglePaintField";

const RED = { color: "#FF0000" }, GREEN = { color: "#00FF00" }, BLUE = { color: "#0000FF" };

/**
 * A cube (12 triangles) with colors 1 red, 2 green, 3 blue and base color 2 (green):
 * tri 0 leaf 1, tri 1 leaf 2, tri 2 split tree (1 | 3), tri 3 leaf 3, the rest unpainted.
 */
function fixture(spec: ModelSpec = {}): Project {
  return createProject(makeModel(cubeMesh(), {
    filaments: [RED, GREEN, BLUE],
    parts: [{ firstTri: 0, triCount: 12, extruder: 2, type: "ModelPart", name: null }],
    paints: [leaf(1), leaf(2), tree(split2(1, 3)), leaf(3)],
    ...spec,
  }));
}

const field = (p: Project) => p.fields[0] as TrianglePaintField;
const codeOf = (fn: () => void): string | undefined => {
  try { fn(); } catch (e) { return e instanceof DocError ? e.code : `other: ${String(e)}`; }
  return undefined;
};

describe("paintTriangles", () => {
  it("sets states, drops preserved detail, and undo/redo restore the exact state", () => {
    const p = fixture();
    const initial = toSnapshot(p);
    expect(field(p).preserved.get(2)).toBe(tree(split2(1, 3)));
    expect(p.paintTriangles(0, [2, 4], 2)).toBe(2);
    const painted = toSnapshot(p);
    expect(field(p).states[2]).toBe(2);
    expect(field(p).preserved.has(2)).toBe(false);

    expect(p.undo()).toBe(true);
    expect(toSnapshot(p)).toEqual(initial);
    expect(field(p).preserved.get(2)).toBe(tree(split2(1, 3)));
    expect(field(p).states[2]).toBe(3); // dominant of the restored tree: tie -> higher state
    expect(p.redo()).toBe(true);
    expect(toSnapshot(p)).toEqual(painted);
  });

  it("erases with state 0, which also drops preserved detail", () => {
    const p = fixture();
    p.paintTriangles(0, [0, 2], 0);
    expect(field(p).states[0]).toBe(0);
    expect(field(p).states[2]).toBe(0);
    expect(field(p).preserved.size).toBe(0);
  });

  it("changes nothing, records nothing and notifies nobody when nothing would change", () => {
    const p = fixture();
    const sim = new ViewerSim(p);
    const before = p.undoCount;
    expect(p.paintTriangles(0, [3], 3)).toBe(0); // tri 3 already has state 3
    expect(p.paintTriangles(0, [], 1)).toBe(0);
    expect(p.undoCount).toBe(before);
    expect(sim.events).toEqual([]);
  });

  it("skips triangles that are not print surface and ids that do not exist", () => {
    const p = fixture({
      parts: [
        { firstTri: 0, triCount: 8, extruder: 2, type: "ModelPart", name: null },
        { firstTri: 8, triCount: 4, extruder: 2, type: "NegativeVolume", name: null },
      ],
    });
    const sim = new ViewerSim(p);
    expect(p.paintTriangles(0, [7, 8, 9, 99, -1], 1)).toBe(1);
    expect(sim.events[0]).toEqual({ kind: "paint", object: 0, tris: Uint32Array.of(7) });
    expect(Array.from(field(p).states.slice(8))).toEqual([0, 0, 0, 0]);
  });

  it("reports exactly the triangles that changed, then the history change", () => {
    const p = fixture();
    const sim = new ViewerSim(p);
    p.paintTriangles(0, [5, 3, 3, 0, 7], 3); // tri 3 is already 3; listed twice
    expect(sim.events).toEqual([{ kind: "paint", object: 0, tris: Uint32Array.of(5, 0, 7) }, { kind: "history" }]);
    sim.expectInSync();
  });

  it("rejects states outside the palette", () => {
    const p = fixture();
    expect(codeOf(() => p.paintTriangles(0, [0], 4))).toBe("STATE_RANGE");
    expect(codeOf(() => p.paintTriangles(0, [0], -1))).toBe("STATE_RANGE");
    expect(codeOf(() => p.paintTriangles(0, [0], 1.5))).toBe("STATE_RANGE");
  });
});

describe("strokes", () => {
  it("merge the dabs of one drag into a single undo step (first before wins)", () => {
    const p = fixture();
    const sim = new ViewerSim(p);
    const initial = toSnapshot(p);
    p.beginStroke();
    p.paintTriangles(0, [4, 5, 6], 3);
    p.paintTriangles(0, [5, 6, 7], 1);
    p.paintTriangles(0, [6, 2], 2); // tri 2 starts with preserved detail
    p.endStroke();
    expect(p.undoCount).toBe(1);
    const final = toSnapshot(p);
    expect(Array.from(field(p).states.slice(4, 8))).toEqual([3, 1, 2, 1]);
    // The viewer got every dab as it happened.
    expect(sim.events.filter((e) => e.kind === "paint")).toHaveLength(3);
    sim.expectInSync();

    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
    sim.expectInSync();
    p.redo();
    expect(toSnapshot(p)).toEqual(final);
    sim.expectInSync();
  });

  it("restore preserved detail exactly when a later dab repaints the triangle with its old state", () => {
    const p = fixture();
    const initial = toSnapshot(p);
    p.beginStroke();
    p.paintTriangles(0, [2], 1);
    p.paintTriangles(0, [2], 3); // back to the tree's dominant state, but the tree is gone
    p.endStroke();
    expect(field(p).preserved.has(2)).toBe(false);
    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
    expect(field(p).preserved.get(2)).toBe(tree(split2(1, 3)));
  });

  it("nest, and a stroke that changed nothing leaves no step", () => {
    const p = fixture();
    p.beginStroke();
    p.beginStroke();
    p.paintTriangles(0, [4], 1);
    p.endStroke();
    expect(p.undoCount).toBe(0); // still inside the outer stroke
    p.paintTriangles(0, [5], 1);
    p.endStroke();
    expect(p.undoCount).toBe(1);
    p.beginStroke();
    p.paintTriangles(0, [4], 1); // already 1
    p.endStroke();
    expect(p.undoCount).toBe(1);
    p.endStroke(); // an unbalanced end is ignored
    expect(p.undoCount).toBe(1);
  });

  it("cannot be undone from the middle", () => {
    const p = fixture();
    p.paintTriangles(0, [4], 1);
    p.beginStroke();
    p.paintTriangles(0, [5], 1);
    expect(p.canUndo).toBe(false);
    expect(p.undo()).toBe(false);
    p.endStroke();
    expect(p.undoCount).toBe(2);
  });

  it("batch closes the step even when its body throws", () => {
    const p = fixture();
    expect(() => p.batch(() => { p.paintTriangles(0, [4], 1); throw new Error("boom"); })).toThrow("boom");
    expect(p.undoCount).toBe(1);
    expect(p.canUndo).toBe(true);
  });
});

describe("undo history", () => {
  it("keeps 200 steps by default and drops the oldest", () => {
    const p = fixture();
    expect(p.undoLimit).toBe(DEFAULT_UNDO_LIMIT);
    expect(DEFAULT_UNDO_LIMIT).toBe(200);
    const states: number[] = [];
    for (let i = 0; i < 250; i++) {
      p.paintTriangles(0, [4], i % 2 === 0 ? 1 : 3);
      states.push(field(p).states[4]);
    }
    expect(p.undoCount).toBe(200);
    for (let i = 0; i < 200; i++) expect(p.undo()).toBe(true);
    expect(p.undo()).toBe(false);
    // 200 steps back from step 250 is the state after step 50.
    expect(field(p).states[4]).toBe(states[49]);
  });

  it("clears the redo steps on a new edit", () => {
    const p = fixture();
    p.paintTriangles(0, [4], 1);
    p.undo();
    expect(p.canRedo).toBe(true);
    p.paintTriangles(0, [5], 1);
    expect(p.canRedo).toBe(false);
    expect(p.redo()).toBe(false);
  });

  it("emits the same events on undo and redo as the edit did, plus a history change", () => {
    const p = fixture();
    p.paintTriangles(0, [4, 5], 1);
    const sim = new ViewerSim(p);
    p.undo();
    expect(sim.events).toEqual([{ kind: "paint", object: 0, tris: Uint32Array.of(4, 5) }, { kind: "history" }]);
    sim.clear();
    p.redo();
    expect(sim.events).toEqual([{ kind: "paint", object: 0, tris: Uint32Array.of(4, 5) }, { kind: "history" }]);
  });

  it("clearHistory forgets everything", () => {
    const p = fixture();
    p.paintTriangles(0, [4], 1);
    p.undo();
    p.clearHistory();
    expect(p.canUndo || p.canRedo).toBe(false);
  });

  it("has a change token that grows with every event but not on no-ops", () => {
    const p = fixture();
    const v0 = p.version;
    p.paintTriangles(0, [4], 1);
    expect(p.version).toBeGreaterThan(v0);
    const v1 = p.version;
    p.paintTriangles(0, [4], 1); // no-op
    expect(p.version).toBe(v1);
  });

  it("stops notifying after unsubscribe", () => {
    const p = fixture();
    let calls = 0;
    const off = p.subscribe(() => calls++);
    p.paintTriangles(0, [4], 1);
    const seen = calls;
    off();
    p.paintTriangles(0, [5], 1);
    expect(calls).toBe(seen);
  });
});

describe("palette operations", () => {
  it("addColor appends a known color; undo removes it", () => {
    const p = fixture();
    const before = p.palette;
    const sim = new ViewerSim(p);
    expect(p.addColor("#abc")).toBe(4);
    expect(p.palette[4]).toEqual({ color: "#AABBCC", known: true });
    expect(sim.events[0]).toEqual({ kind: "palette", renumbered: false, changed: [4] });
    p.undo();
    expect(p.palette).toBe(before); // the very same array: palette entries are immutable values
    p.redo();
    expect(p.palette[4].color).toBe("#AABBCC");
    sim.expectInSync();
  });

  it("setColor recolors everything painted with it, marks it known, and drops a stale ColorMix hint", () => {
    const p = createProject(makeModel(cubeMesh(), {
      filaments: [RED, { color: "#30F845", mix: [{ extruder: 1, ratio: 1 }] }],
      paints: [leaf(2)],
    }));
    const sim = new ViewerSim(p);
    expect(p.palette[2].mix).toBeDefined();
    expect(p.setColor(2, "#112233")).toBe(true);
    expect(p.palette[2]).toEqual({ color: "#112233", known: true });
    sim.expectInSync();
    p.undo();
    expect(p.palette[2].mix).toEqual([{ extruder: 1, ratio: 1 }]);
    expect(p.palette[2].color).toBe("#30F845");
    sim.expectInSync();
  });

  it("setColor with the generated color's own value accepts it as known", () => {
    const p = createProject(makeModel(cubeMesh(), { filaments: [RED, null], paints: [leaf(2)] }));
    expect(p.palette[2].known).toBe(false);
    expect(p.setColor(2, p.palette[2].color)).toBe(true);
    expect(p.palette[2].known).toBe(true);
    expect(p.setColor(2, p.palette[2].color)).toBe(false);
  });

  it("merges a color-picker drag into one undo step", () => {
    const p = fixture();
    const before = p.palette;
    p.beginStroke();
    for (const hex of ["#101010", "#202020", "#303030", "#404040"]) p.setColor(1, hex);
    p.endStroke();
    expect(p.undoCount).toBe(1);
    expect(p.palette[1].color).toBe("#404040");
    p.undo();
    expect(p.palette).toBe(before);
  });

  it("rejects colors that do not exist", () => {
    const p = fixture();
    expect(codeOf(() => p.setColor(0, "#000000"))).toBe("STATE_RANGE");
    expect(codeOf(() => p.setColor(4, "#000000"))).toBe("STATE_RANGE");
  });

  it("counts triangles per color, painted and base", () => {
    const p = fixture();
    // painted: tri 0 -> 1, tri 1 -> 2, tri 2 (a tree of 1 and 3) and tri 3 -> 3; base 2 for the other 8.
    // A split triangle counts once for every color its pieces show.
    expect(p.colorUsage()).toEqual([{ painted: 0, base: 0 }, { painted: 2, base: 0 }, { painted: 1, base: 8 }, { painted: 2, base: 0 }]);
  });
});

describe("deleteColor", () => {
  it("merges into another color, renumbers everything, and undoes exactly", () => {
    const p = fixture();
    const sim = new ViewerSim(p);
    const initial = toSnapshot(p);
    p.deleteColor(1, 3); // red into blue; green and blue become 1 and 2
    expect(p.palette.map((c) => c.color)).toEqual(["#808080", "#00FF00", "#0000FF"]);
    expect(p.baseColor.get(partId(0, 0))).toBe(1);
    expect(Array.from(field(p).states.slice(0, 5))).toEqual([2, 1, 2, 2, 0]);
    expect(field(p).preserved.get(2)).toBe(tree(split2(2, 2))); // leaves 1|3 -> 3|3 -> 2|2
    expect(sim.events).toEqual([{ kind: "palette", renumbered: true, changed: [] }, { kind: "history" }]);
    sim.expectInSync();

    expect(p.undoCount).toBe(1);
    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
    sim.expectInSync();
    p.redo();
    expect(p.palette).toHaveLength(3);
    sim.expectInSync();
  });

  it("merges into base: painted triangles fall back to their part's base color", () => {
    const p = fixture();
    const initial = toSnapshot(p);
    p.deleteColor(3, 0); // blue is not a base color
    expect(p.palette).toHaveLength(3);
    expect(Array.from(field(p).states.slice(0, 5))).toEqual([1, 2, 1, 0, 0]);
    expect(field(p).preserved.get(2)).toBe(tree(split2(1, 0))); // 1|3 -> 1|unpainted; the leaves tie, the higher state wins
    expect(Array.from(resolveDisplayStates(p, 0)).slice(0, 5)).toEqual([1, 2, 1, 2, 2]);
    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
  });

  it("refuses to merge a base color into base and says which parts use it", () => {
    const p = fixture();
    const initial = toSnapshot(p);
    expect(p.isBaseColor(2)).toBe(true);
    expect(p.isBaseColor(1)).toBe(false);
    expect(p.basePartsOf(2)).toEqual([partId(0, 0)]);
    expect(codeOf(() => p.deleteColor(2, 0))).toBe("BASE_IN_USE");
    expect(toSnapshot(p)).toEqual(initial);
    expect(p.undoCount).toBe(0);
  });

  it("moves part bases to the concrete target", () => {
    const p = fixture();
    const initial = toSnapshot(p);
    const sim = new ViewerSim(p);
    p.deleteColor(2, 1); // green (the base) into red
    expect(p.baseColor.get(partId(0, 0))).toBe(1);
    expect(p.palette.map((c) => c.color)).toEqual(["#808080", "#FF0000", "#0000FF"]);
    expect(Array.from(resolveDisplayStates(p, 0)).slice(0, 5)).toEqual([1, 1, 2, 2, 1]);
    sim.expectInSync();
    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
    sim.expectInSync();
  });

  it("keeps states contiguous through repeated deletes, and unwinds them in order", () => {
    const p = fixture();
    p.addColor("#FFFFFF");
    p.paintTriangles(0, [8, 9], 4);
    const snaps = [toSnapshot(p)];
    p.deleteColor(4, 1);
    snaps.push(toSnapshot(p));
    p.deleteColor(1, 0);
    snaps.push(toSnapshot(p));
    p.deleteColor(1, 2); // green is the base here: it moves to blue
    expect(p.palette).toHaveLength(2);
    expect(p.baseColor.get(partId(0, 0))).toBe(1);
    expect(Math.max(...field(p).states)).toBeLessThanOrEqual(1);
    p.undo();
    expect(toSnapshot(p)).toEqual(snaps.pop());
    p.undo();
    expect(toSnapshot(p)).toEqual(snaps.pop());
    p.undo();
    expect(toSnapshot(p)).toEqual(snaps.pop());
  });

  it("validates its arguments", () => {
    const p = fixture();
    expect(codeOf(() => p.deleteColor(0, 1))).toBe("STATE_RANGE");
    expect(codeOf(() => p.deleteColor(4, 1))).toBe("STATE_RANGE");
    expect(codeOf(() => p.deleteColor(1, 4))).toBe("STATE_RANGE");
    expect(codeOf(() => p.deleteColor(1, 1))).toBe("SAME_COLOR");
  });

  it("joins a larger step when called inside a batch", () => {
    const p = fixture();
    const initial = toSnapshot(p);
    p.batch(() => {
      p.paintTriangles(0, [9], 1);
      p.deleteColor(3, 1);
      p.addColor("#010203");
    });
    expect(p.undoCount).toBe(1);
    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
  });
});

describe("base colors", () => {
  const twoParts = () => fixture({
    parts: [
      { firstTri: 0, triCount: 6, extruder: 2, type: "ModelPart", name: null },
      { firstTri: 6, triCount: 4, extruder: 3, type: "ModelPart", name: null },
      { firstTri: 10, triCount: 2, extruder: 1, type: "NegativeVolume", name: null },
    ],
  });

  it("setBaseColor recolors the unpainted surface of that part only", () => {
    const p = twoParts();
    const sim = new ViewerSim(p);
    const initial = toSnapshot(p);
    expect(p.setBaseColor(0, 1, 1)).toBe(true);
    expect(sim.events[0]).toEqual({ kind: "base", object: 0, parts: [1] });
    expect(Array.from(resolveDisplayStates(p, 0)).slice(4, 12)).toEqual([2, 2, 1, 1, 1, 1, 0, 0]);
    sim.expectInSync();
    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
    sim.expectInSync();
    p.redo();
    expect(p.baseColor.get(partId(0, 1))).toBe(1);
  });

  it("setObjectBaseColor changes every ModelPart in one step", () => {
    const p = twoParts();
    const sim = new ViewerSim(p);
    const initial = toSnapshot(p);
    expect(p.setObjectBaseColor(0, 1)).toBe(true);
    expect(sim.events[0]).toEqual({ kind: "base", object: 0, parts: [0, 1] });
    expect(p.baseColor.get(partId(0, 0))).toBe(1);
    expect(p.baseColor.get(partId(0, 1))).toBe(1);
    expect(p.baseColor.has(partId(0, 2))).toBe(false);
    expect(p.undoCount).toBe(1);
    expect(p.setObjectBaseColor(0, 1)).toBe(false);
    sim.expectInSync();
    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
  });

  it("only ModelParts have a base color, and it must be a palette color", () => {
    const p = twoParts();
    expect(codeOf(() => p.setBaseColor(0, 2, 1))).toBe("NOT_BASE_PART");
    expect(codeOf(() => p.setBaseColor(0, 9, 1))).toBe("NOT_BASE_PART");
    expect(codeOf(() => p.setBaseColor(5, 0, 1))).toBe("NOT_BASE_PART");
    expect(codeOf(() => p.setBaseColor(0, 0, 0))).toBe("STATE_RANGE");
    expect(codeOf(() => p.setBaseColor(0, 0, 9))).toBe("STATE_RANGE");
    expect(p.setBaseColor(0, 0, 2)).toBe(false);
  });

  it("answers the eyedropper with the painted state, else the part's base", () => {
    const p = twoParts();
    expect(p.stateShownAt(0, 0)).toBe(1); // painted
    expect(p.stateShownAt(0, 4)).toBe(2); // unpainted, part 0 base
    expect(p.stateShownAt(0, 7)).toBe(3); // unpainted, part 1 base
    expect(p.stateShownAt(0, 11)).toBe(0); // negative volume: not print surface
  });
});

describe("compound steps", () => {
  it("batch makes palette, paint and base edits one step, with in-order events on undo", () => {
    const p = fixture();
    const sim = new ViewerSim(p);
    const initial = toSnapshot(p);
    const palette = p.palette;
    p.batch(() => {
      const s = p.addColor("#FFAA00");
      p.paintTriangles(0, [4, 5], s);
      p.setBaseColor(0, 0, s);
    });
    expect(p.undoCount).toBe(1);
    sim.expectInSync();
    sim.clear();
    p.undo();
    expect(toSnapshot(p)).toEqual(initial);
    expect(p.palette).toBe(palette);
    expect(sim.events.map((e) => e.kind)).toEqual(["palette", "paint", "base", "history"]);
    sim.expectInSync();
  });
});
