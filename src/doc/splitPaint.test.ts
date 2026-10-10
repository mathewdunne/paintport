import { describe, expect, it } from "vitest";
import type { Vec3 } from "./paintField";
import { emitTree, leafIndexAt, parseTree, treeLeaves, type Bary } from "./splitTree";
import { TrianglePaintField } from "./trianglePaintField";
import { makeModel } from "../../test/support/docFixtures";
import { resolveViewState, resolveViewStates } from "./display";
import { createProject } from "./project";

/** A 10 x 10 mm quad: triangle 0 = (0,0) (10,0) (10,10), triangle 1 = (0,0) (10,10) (0,10). */
function quad() {
  const mesh = { vertices: Float64Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]), tris: Int32Array.from([0, 1, 2, 0, 2, 3]), triCount: 2 };
  return new TrianglePaintField(mesh, Uint8Array.from([1, 1]));
}

/** Barycentric coordinates of (x, y) in triangle 0. */
const bary0 = (x: number, y: number): Bary => [1 - x / 10, (x - y) / 10, y / 10];
const SPLIT = { split: { limit: 0.5 } };

describe("split brush", () => {
  it("grows a tree on a crossed triangle: the color inside the sphere, unpainted outside", () => {
    const f = quad();
    const center: Vec3 = [8, 2, 0];
    f.paintSphere(center, 1.5, 2, SPLIT);
    expect(f.treeOf(0)).toBeDefined();
    expect(f.treeOf(1)).toBeUndefined(); // the sphere doesn't reach it
    expect(f.stateAt(0, bary0(8, 2))).toBe(2);
    expect(f.stateAt(0, bary0(3, 1))).toBe(0);
    expect(f.stateAt(0)).toBe(0); // the dominant state: mostly unpainted
    expect(f.leafStates(0)).toEqual(new Set([0, 2]));
    expect(f.serialize("bbs").paint[0]).toBe(f.treeOf(0));
  });

  it("paints whole triangles without the option, dropping their trees", () => {
    const f = quad();
    f.paintSphere([8, 2, 0], 1.5, 2, SPLIT);
    f.paintSphere([8, 2, 0], 1.5, 3);
    expect(f.treeOf(0)).toBeUndefined();
    expect(f.stateAt(0, bary0(3, 1))).toBe(3);
  });

  it("paints a triangle inside the sphere whole, even with the option", () => {
    const f = quad();
    f.paintSphere([5, 5, 0], 20, 4, SPLIT);
    expect(f.trees().size).toBe(0);
    expect(Array.from(f.states)).toEqual([4, 4]);
  });

  it("undoes and redoes trees exactly, also as a merged stroke", () => {
    const f = quad();
    const edits = [f.paintSphere([8, 2, 0], 1.5, 2, SPLIT), f.paintSphere([7, 3, 0], 1.5, 2, SPLIT), f.paintSphere([6, 4, 0], 1.5, 3, SPLIT)];
    const tree0 = f.treeOf(0), tree1 = f.treeOf(1), states = Array.from(f.states);
    const stroke = f.mergeEdits(edits);
    f.undoEdit(stroke);
    expect(f.trees().size).toBe(0);
    expect(Array.from(f.states)).toEqual([0, 0]);
    expect(f.stateAt(0, bary0(8, 2))).toBe(0);
    f.redoEdit(stroke);
    expect(f.treeOf(0)).toBe(tree0);
    expect(f.treeOf(1)).toBe(tree1);
    expect(Array.from(f.states)).toEqual(states);
    expect(f.stateAt(0, bary0(8, 2))).toBe(2);
  });

  it("collapses a tree that ends up one color", () => {
    const f = quad();
    f.paintSphere([8, 2, 0], 1.5, 2, SPLIT);
    f.paintSphere([8, 2, 0], 2, 0, SPLIT); // a larger eraser
    expect(f.trees().size).toBe(0);
    expect(f.states[0]).toBe(0);
  });

  it("records nothing when a dab changes nothing", () => {
    const f = quad();
    f.paintSphere([8, 2, 0], 1.5, 2, SPLIT);
    expect(f.paintSphere([8, 2, 0], 1.5, 2, SPLIT).size).toBe(0);
  });
});

describe("regions", () => {
  it("paints whole triangles and only the listed leaves of split ones", () => {
    const f = quad();
    f.paintSphere([8, 2, 0], 1.5, 2, SPLIT);
    const root = parseTree(f.treeOf(0)!);
    const painted = leafIndexAt(root, bary0(8, 2)); // a leaf of color 2
    const outside = leafIndexAt(root, bary0(3, 1));
    const edit = f.paintRegion({ tris: Uint32Array.of(1), pieces: new Map([[0, Uint32Array.of(outside)]]) }, 3);
    expect(f.states[1]).toBe(3);
    expect(f.stateAt(0, bary0(3, 1))).toBe(3);
    expect(f.stateAt(0, bary0(8, 2))).toBe(2);
    expect(treeLeaves(parseTree(f.treeOf(0)!))[painted].state).toBe(2);
    f.undoEdit(edit);
    expect(f.stateAt(0, bary0(3, 1))).toBe(0);
    expect(f.states[1]).toBe(0);
  });

  it("paints a pieces entry of a triangle without a tree whole", () => {
    const f = quad();
    f.paintRegion({ tris: new Uint32Array(0), pieces: new Map([[1, Uint32Array.of(0)]]) }, 5);
    expect(f.states[1]).toBe(5);
  });

  it("keeps leaf states current through remap", () => {
    const f = quad();
    f.paintSphere([8, 2, 0], 1.5, 2, SPLIT);
    f.remap((s) => (s === 2 ? 6 : s));
    expect(f.leafStates(0)).toEqual(new Set([0, 6]));
    expect(f.stateAt(0, bary0(8, 2))).toBe(6);
    expect(emitTree(parseTree(f.treeOf(0)!))).toBe(f.treeOf(0));
  });
});

describe("project", () => {
  function project() {
    const p = createProject(makeModel({ vertices: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], tris: [0, 1, 2, 0, 2, 3] }, {
      filaments: [{ color: "#FF0000" }, { color: "#00FF00" }],
      parts: [{ firstTri: 0, triCount: 2, extruder: 1, type: "ModelPart", name: null }],
    }));
    expect(p.addColor("#00FF00")).toBe(2);
    p.paintSphere(0, [8, 2, 0], 1.5, 2, SPLIT);
    p.clearHistory();
    return p;
  }

  it("shows the piece under a point; unpainted pieces show the part's base", () => {
    const p = project();
    expect(p.stateShownAt(0, 0, bary0(8, 2))).toBe(2);
    expect(p.stateShownAt(0, 0, bary0(3, 1))).toBe(1); // unpainted leaf -> base (extruder 1)
    expect(p.stateShownAt(0, 0)).toBe(1); // the dominant leaf is unpainted
  });

  it("gives the viewer the base for a split triangle and the shown state otherwise", () => {
    const p = project();
    p.paintTriangles(0, [1], 2);
    expect(resolveViewState(p, 0, 0)).toBe(1);
    expect(resolveViewState(p, 0, 1)).toBe(2);
    expect(Array.from(resolveViewStates(p, 0))).toEqual([1, 2]);
  });

  it("counts a color used only by pieces", () => {
    const p = project();
    expect(p.colorUsage()[2].painted).toBe(1);
    expect(p.colorUsage()[1].base).toBe(2); // the split triangle's unpainted pieces and triangle 1
  });

  it("paints a region as one undo step with one paint event", () => {
    const p = project();
    const events: unknown[] = [];
    p.subscribe((e) => events.push(e));
    const leaf = leafIndexAt(parseTree(p.fields[0].treeOf(0)!), bary0(3, 1));
    expect(p.paintRegion(0, { tris: Uint32Array.of(1), pieces: new Map([[0, Uint32Array.of(leaf)]]) }, 2)).toBe(2);
    expect(events.filter((e) => (e as { kind: string }).kind === "paint")).toHaveLength(1);
    expect(p.undoCount).toBe(1);
    p.undo();
    expect(p.stateShownAt(0, 0, bary0(3, 1))).toBe(1);
  });
});
