import { describe, expect, it } from "vitest";
import { emitPaintTree, parsePaintTree, remapPaintString } from "../core";
import { cubeMesh, leaf, makeModel, split2, split3, stripMesh, tree } from "../../test/support/docFixtures";
import { createProject } from "./project";
import { TrianglePaintField } from "./trianglePaintField";

/** Triangles of a cube: 0 unpainted, 1 whole state 1, 2 whole state 3, 3 split (1,2), 4 split (2,3,1), 5 painted 0, the rest unpainted. */
function project() {
  const paints = [null, leaf(1), leaf(3), tree(split2(1, 2)), tree(split3(2, 3, 1)), leaf(0)];
  return createProject(makeModel(cubeMesh(), { paints, filaments: [{ color: "#FF0000" }, { color: "#00FF00" }, { color: "#0000FF" }] }));
}

const fieldOf = (p: ReturnType<typeof project>) => p.fields[0] as TrianglePaintField;

describe("PaintField.serialize", () => {
  it("writes null for unpainted triangles and one-leaf strings for whole-triangle paint", () => {
    const p = project();
    const { paint, mesh } = p.fields[0].serialize("bbs");
    expect(mesh).toBe(p.fields[0].mesh);
    expect(paint).toHaveLength(12);
    expect(paint[0]).toBeNull();
    expect(paint[5]).toBeNull(); // painted with the base state: unpainted
    for (let t = 6; t < 12; t++) expect(paint[t]).toBeNull();
    // design states: file states 1,2,3 are used (the base extruder 1 too), so they keep their numbers
    expect(paint[1]).toBe(emitPaintTree({ state: 1 }, "bbs"));
    expect(paint[2]).toBe(emitPaintTree({ state: 3 }, "bbs"));
  });

  it("returns the preserved trees verbatim in the internal dialect", () => {
    const p = project();
    const { paint } = p.fields[0].serialize("bbs");
    expect(paint[3]).toBe(fieldOf(p).preserved.get(3));
    expect(paint[4]).toBe(fieldOf(p).preserved.get(4));
    expect(parsePaintTree(paint[3]!, "bbs")).toEqual(split2(1, 2));
    expect(parsePaintTree(paint[4]!, "bbs")).toEqual(split3(2, 3, 1));
  });

  it("converts the trees and the leaves to the prusa dialect with the codec", () => {
    const p = project();
    const { paint } = p.fields[0].serialize("prusa");
    expect(paint[1]).toBe(emitPaintTree({ state: 1 }, "prusa"));
    expect(paint[3]).toBe(remapPaintString(fieldOf(p).preserved.get(3)!, (s) => s, "bbs", "prusa").str);
    expect(parsePaintTree(paint[3]!, "prusa")).toEqual(split2(1, 2));
    expect(parsePaintTree(paint[4]!, "prusa")).toEqual(split3(2, 3, 1));
  });

  it("agrees with the codec for states beyond the 16 where the dialects differ", () => {
    // 20 file states, all used, so the compacted design palette keeps their numbers
    const paints = [...Array.from({ length: 19 }, (_, i) => leaf(i + 1)), leaf(20), tree(split2(19, 20))];
    const p = createProject(makeModel(stripMesh(Array(10).fill(0)), {
      paints,
      filaments: Array.from({ length: 20 }, (_, i) => ({ color: `#${(i + 1).toString(16).padStart(2, "0")}0000` })),
    }));
    expect([...p.fields[0].displayStates()].slice(0, 21)).toEqual(Array.from({ length: 21 }, (_, i) => (i < 20 ? i + 1 : 20)));
    for (const dialect of ["bbs", "prusa"] as const) {
      const { paint } = p.fields[0].serialize(dialect);
      for (let t = 0; t < 20; t++) expect(paint[t], `${dialect} triangle ${t}`).toBe(emitPaintTree({ state: t + 1 }, dialect));
      expect(parsePaintTree(paint[20]!, dialect)).toEqual(split2(19, 20));
    }
  });

  it("follows edits: a repainted preserved triangle becomes a plain leaf, undo brings the tree back", () => {
    const p = project();
    const before = p.fields[0].serialize("bbs").paint[3];
    p.paintTriangles(0, [3, 0], 2);
    const after = p.fields[0].serialize("bbs").paint;
    expect(after[3]).toBe(emitPaintTree({ state: 2 }, "bbs"));
    expect(after[0]).toBe(emitPaintTree({ state: 2 }, "bbs"));
    expect(after[4]).toBe(fieldOf(p).preserved.get(4)); // untouched tree survives
    p.undo();
    expect(p.fields[0].serialize("bbs").paint[3]).toBe(before);
    p.paintTriangles(0, [1], 0);
    expect(p.fields[0].serialize("bbs").paint[1]).toBeNull();
  });

  it("follows palette merges inside preserved trees", () => {
    const p = project();
    p.deleteColor(2, 1); // state 2 merges into 1, state 3 becomes 2
    const { paint } = p.fields[0].serialize("bbs");
    expect(parsePaintTree(paint[3]!, "bbs")).toEqual(split2(1, 1));
    expect(parsePaintTree(paint[4]!, "bbs")).toEqual(split3(1, 2, 1));
    expect(paint[2]).toBe(emitPaintTree({ state: 2 }, "bbs"));
  });
});
