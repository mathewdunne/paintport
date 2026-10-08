import { describe, expect, it } from "vitest";
import { deltaE, parsePaintTree, type PaintNode, type PaintSplit } from "../core";
import { cubeMesh, leaf, makeModel, split2, split3, tree } from "../../test/support/docFixtures";
import { generateDistinctColors } from "./colors";
import { resolveDisplayStates } from "./display";
import { createProject } from "./project";
import { partId } from "./types";
import { TrianglePaintField } from "./trianglePaintField";

const RED = { color: "#FF0000" }, GREEN = { color: "#00FF00" }, BLUE = { color: "#0000FF" };
const YELLOW = { color: "#FFFF00" }, PURPLE = { color: "#800080" };

const leavesOf = (str: string, dialect: "bbs" | "prusa" = "bbs"): number[] => {
  const out: number[] = [];
  (function walk(n: PaintNode) {
    if ((n as PaintSplit).children) (n as PaintSplit).children.forEach(walk);
    else out.push((n as { state: number }).state);
  })(parsePaintTree(str, dialect));
  return out;
};

describe("design palette on import", () => {
  // File slots: 1 red, 2 green, 3 undefined, 4 blue, 5 yellow, 6 purple. The part's base is
  // slot 4; triangle 0 is a plain leaf of slot 6; triangle 1 is a split tree whose leaves
  // are slots 2, 5 and 0. Slots 2 and 5 occur ONLY inside the tree, so triState (the
  // dominant leaf) hides slot 5 completely.
  const model = () => makeModel(cubeMesh(), {
    filaments: [RED, GREEN, null, BLUE, YELLOW, PURPLE],
    parts: [{ firstTri: 0, triCount: 12, extruder: 4, type: "ModelPart", name: null }],
    paints: [leaf(6), tree(split3(2, 5, 0))],
  });

  it("keeps exactly the used colors, including leaves only present inside split trees", () => {
    const p = createProject(model());
    expect(p.palette.slice(1).map((c) => c.color)).toEqual(["#00FF00", "#0000FF", "#FFFF00", "#800080"]); // slots 2, 4, 5, 6 in file order
    expect(p.palette.slice(1).every((c) => c.known)).toBe(true);
  });

  it("remaps field states, preserved trees and base colors consistently", () => {
    const p = createProject(model());
    const field = p.fields[0] as TrianglePaintField;
    // file slot -> design state: 2->1, 4->2, 5->3, 6->4
    expect(p.baseColor.get(partId(0, 0))).toBe(2);
    expect(field.states[0]).toBe(4);
    expect(field.preserved.get(1)).toBe(tree(split3(1, 3, 0)));
    // The dominant state is recomputed from the remapped tree: three leaves tie, the higher state wins.
    expect(field.states[1]).toBe(3);
    expect(Array.from(field.preserved.keys())).toEqual([1]);
    expect(Array.from(resolveDisplayStates(p, 0))).toEqual([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it("orders the palette by file state, not by where the states occur", () => {
    const p = createProject(makeModel(cubeMesh(), { filaments: [RED, GREEN, BLUE, YELLOW, PURPLE], paints: [leaf(5), leaf(2)] }));
    expect(p.palette.slice(1).map((c) => c.color)).toEqual(["#FF0000", "#00FF00", "#800080"]); // base 1, painted 2 and 5
  });

  it("maps trees from the prusa dialect, where states above 16 need the 8-bit escape", () => {
    const p = createProject(makeModel(cubeMesh(), { dialect: "prusa", filaments: [RED], paints: [tree(split2(20, 1), "prusa")] }));
    const field = p.fields[0] as TrianglePaintField;
    expect(p.palette).toHaveLength(3); // base slot, file slot 1 (red), file slot 20
    expect(p.palette[1].color).toBe("#FF0000");
    expect(p.palette[2].known).toBe(false); // slot 20 is not defined by the file
    expect(leavesOf(field.preserved.get(0)!)).toEqual([2, 1]); // stored in the internal "bbs" dialect
    expect(field.states[0]).toBe(2);
  });

  it("ignores paint and extruders of volumes that are not print surface", () => {
    const p = createProject(makeModel(cubeMesh(), {
      filaments: [RED, GREEN, BLUE, YELLOW, PURPLE, { color: "#00FFFF" }],
      parts: [
        { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
        { firstTri: 8, triCount: 4, extruder: 6, type: "NegativeVolume", name: null },
      ],
      paints: [null, null, null, null, null, null, null, null, leaf(3), tree(split2(4, 5))],
    }));
    expect(p.palette).toHaveLength(2);
    const field = p.fields[0] as TrianglePaintField;
    expect(Array.from(field.states).every((s) => s === 0)).toBe(true);
    expect(field.preserved.size).toBe(0);
    expect(p.baseColor.has(partId(0, 1))).toBe(false);
  });

  it("marks colors the file defines as known and gives the others distinct generated colors", () => {
    const p = createProject(makeModel(cubeMesh(), {
      filaments: [RED, null, null, { color: "#123456", mix: [{ extruder: 1, ratio: 2 }] }],
      paints: [leaf(2), leaf(3), leaf(4)],
    }));
    expect(p.palette.slice(1).map((c) => c.known)).toEqual([true, false, false, true]);
    expect(p.palette[4].mix).toEqual([{ extruder: 1, ratio: 2 }]);
    const colors = p.palette.slice(1).map((c) => c.color);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) expect(deltaE(colors[i], colors[j])).toBeGreaterThan(25);
    }
    expect(colors).not.toContain("#26A69A"); // the core's fallback color is not reused for undefined slots
  });

  it("is deterministic", () => {
    const build = () => createProject(makeModel(cubeMesh(), { filaments: [null, RED, null], paints: [leaf(1), leaf(3)] })).palette;
    expect(build()).toEqual(build());
  });
});

describe("generateDistinctColors", () => {
  const minPairwise = (colors: string[]) => {
    let min = Infinity;
    for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) min = Math.min(min, deltaE(colors[i], colors[j]));
    return min;
  };

  it("separates new colors from each other and from the taken ones", () => {
    const taken = ["#FF0000", "#00FF00", "#0000FF", "#FFFFFF", "#000000"];
    const colors = generateDistinctColors(12, taken);
    expect(colors).toHaveLength(12);
    expect(minPairwise([...taken, ...colors])).toBeGreaterThanOrEqual(25);
  });

  it("is deterministic and a longer request extends a shorter one", () => {
    const a = generateDistinctColors(6, ["#808080"]);
    expect(generateDistinctColors(6, ["#808080"])).toEqual(a);
    expect(generateDistinctColors(9, ["#808080"]).slice(0, 6)).toEqual(a);
  });

  it("never repeats a color, even when the palette is crowded", () => {
    const colors = generateDistinctColors(120, ["#D9D9D9"]);
    expect(new Set(colors).size).toBe(120);
    expect(colors).not.toContain("#D9D9D9");
    expect(minPairwise(colors)).toBeGreaterThan(5);
  });

  it("returns valid hex colors and nothing for a request of zero", () => {
    expect(generateDistinctColors(0, [])).toEqual([]);
    for (const c of generateDistinctColors(30, [])) expect(c).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("suggestColor differs from every palette color", () => {
    const p = createProject(makeModel(cubeMesh(), { filaments: [RED, GREEN], paints: [leaf(2)] }));
    const suggestion = p.suggestColor();
    for (const c of p.palette.slice(1)) expect(deltaE(suggestion, c.color)).toBeGreaterThan(25);
  });
});
