import { ShaderLib, type BufferAttribute } from "three";
import { describe, expect, it } from "vitest";
import { patchVertexShader } from "./material";
import { buildObjectGeometry, isTriangleHighlighted, rebuildStates, setTriangleHighlight, updateTriangleStates } from "./objectGeometry";
import type { ViewObject } from "./viewScene";

// Two triangles on a shared edge, one hidden triangle, translated by +10 in x.
function object(overrides: Partial<ViewObject> = {}): ViewObject {
  return {
    vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 5, 5, 5]),
    tris: new Int32Array([0, 1, 2, 1, 3, 2, 0, 3, 4]),
    transform: "1 0 0 0 1 0 0 0 1 10 0 0",
    states: new Uint16Array([1, 2, 1]),
    mask: new Uint8Array([1, 1, 0]),
    ...overrides,
  };
}
describe("buildObjectGeometry", () => {
  it("lays out 3 vertices per drawn triangle and skips masked ones", () => {
    const g = buildObjectGeometry(object());
    expect(g.slotCount).toBe(2);
    expect(Array.from(g.slotOfTri)).toEqual([0, 1, -1]);
    const pos = g.geometry.getAttribute("position");
    expect(pos.count).toBe(6);
    expect(g.geometry.index).toBeNull(); // non-indexed
  });

  it("applies the build item transform (translation, row-vector convention)", () => {
    const g = buildObjectGeometry(object());
    const pos = Array.from(g.geometry.getAttribute("position").array);
    expect(pos.slice(0, 9)).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
    const box = g.geometry.boundingBox!;
    expect([box.min.x, box.max.x, box.min.y, box.max.y]).toEqual([10, 11, 0, 1]);
  });

  it("applies a rotation (90 degrees about z maps x to y)", () => {
    const g = buildObjectGeometry(object({ transform: "0 1 0 -1 0 0 0 0 1 0 0 0" }));
    const pos = Array.from(g.geometry.getAttribute("position").array);
    expect(pos.slice(0, 9)).toEqual([0, 0, 0, 0, 1, 0, -1, 0, 0]);
  });

  it("writes the triangle's design state on all 3 of its vertices, as unnormalized Uint16", () => {
    const g = buildObjectGeometry(object());
    const attr = g.geometry.getAttribute("state");
    expect(attr.normalized).toBe(false);
    expect(attr.itemSize).toBe(1);
    expect(attr.array).toBeInstanceOf(Uint16Array);
    expect(Array.from(attr.array)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(g.geometry.getAttribute("color")).toBeUndefined(); // colors come from the color table
  });

  it("keeps a state outside the palette as is (the color table shows it gray)", () => {
    const g = buildObjectGeometry(object({ states: new Uint16Array([9, 1, 1]) }));
    expect(Array.from(g.geometry.getAttribute("state").array.slice(0, 3))).toEqual([9, 9, 9]);
  });

  it("handles an object with nothing to draw", () => {
    const g = buildObjectGeometry(object({ mask: new Uint8Array(3) }));
    expect(g.slotCount).toBe(0);
  });
});

describe("updateTriangleStates", () => {
  it("rewrites only the given triangles and flags just their range for upload", () => {
    const obj = object();
    const g = buildObjectGeometry(obj);
    obj.states[1] = 1; // document changes triangle 1 from state 2 to state 1
    updateTriangleStates(g, obj.states, [1]);
    expect(Array.from(g.geometry.getAttribute("state").array)).toEqual([1, 1, 1, 1, 1, 1]);
    const attr = g.geometry.getAttribute("state") as BufferAttribute;
    expect(attr.updateRanges).toEqual([{ start: 3, count: 3 }]);
  });

  it("keeps the ranges of several updates made before a render, one per contiguous run", () => {
    const n = 100;
    const tris = new Int32Array(n * 3);
    for (let i = 0; i < n; i++) { tris[i * 3] = 0; tris[i * 3 + 1] = 1; tris[i * 3 + 2] = 2; }
    const obj = object({ tris, states: new Uint16Array(n).fill(1), mask: new Uint8Array(n).fill(1) });
    const g = buildObjectGeometry(obj);
    obj.states[5] = 2; obj.states[90] = 2; obj.states[6] = 2; obj.states[7] = 2;
    updateTriangleStates(g, obj.states, [5]);
    updateTriangleStates(g, obj.states, [90, 7, 6, 6]); // unsorted, with a duplicate
    const attr = g.geometry.getAttribute("state") as BufferAttribute;
    expect(attr.updateRanges).toEqual([
      { start: 5 * 3, count: 3 },
      { start: 6 * 3, count: 2 * 3 },
      { start: 90 * 3, count: 3 },
    ]);
    expect(Array.from(attr.array.slice(90 * 3, 90 * 3 + 3))).toEqual([2, 2, 2]);
  });

  it("ignores masked and out-of-range triangles without flagging an upload", () => {
    const obj = object();
    const g = buildObjectGeometry(obj);
    const before = Array.from(g.geometry.getAttribute("state").array);
    const version = (g.geometry.getAttribute("state") as BufferAttribute).version;
    updateTriangleStates(g, obj.states, [2, 99]); // masked, out of range
    expect(Array.from(g.geometry.getAttribute("state").array)).toEqual(before);
    expect((g.geometry.getAttribute("state") as BufferAttribute).version).toBe(version);
  });
});

describe("setTriangleHighlight", () => {
  it("marks the 3 vertices of the given triangles and flags only their range for upload", () => {
    const g = buildObjectGeometry(object());
    const attr = g.geometry.getAttribute("highlight") as BufferAttribute;
    expect(attr.normalized).toBe(true);
    expect(Array.from(attr.array)).toEqual([0, 0, 0, 0, 0, 0]);
    setTriangleHighlight(g, [1], true);
    expect(Array.from(attr.array)).toEqual([0, 0, 0, 255, 255, 255]);
    expect(attr.updateRanges).toEqual([{ start: 3, count: 3 }]);
    expect(isTriangleHighlighted(g, 1)).toBe(true);
    expect(isTriangleHighlighted(g, 0)).toBe(false);
    setTriangleHighlight(g, [1], false);
    expect(isTriangleHighlighted(g, 1)).toBe(false);
  });

  it("leaves the states alone: setting and clearing a preview restores exactly what was shown", () => {
    const g = buildObjectGeometry(object());
    const state = g.geometry.getAttribute("state") as BufferAttribute;
    const before = Array.from(state.array);
    const version = state.version;
    setTriangleHighlight(g, [0, 1], true);
    setTriangleHighlight(g, [0, 1], false);
    expect(Array.from(state.array)).toEqual(before);
    expect(state.version).toBe(version);
    expect(state.updateRanges).toEqual([]);
  });

  it("ignores masked and out-of-range triangles", () => {
    const g = buildObjectGeometry(object());
    setTriangleHighlight(g, [2, 99], true);
    expect(Array.from(g.highlight)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(isTriangleHighlighted(g, 2)).toBe(false);
    expect(isTriangleHighlighted(g, 99)).toBe(false);
  });

  it("uploads everything in one range for a big region, without sorting", () => {
    const n = 10000;
    const tris = new Int32Array(n * 3).fill(0);
    for (let i = 0; i < n; i++) { tris[i * 3 + 1] = 1; tris[i * 3 + 2] = 2; }
    const obj = object({ tris, states: new Uint16Array(n).fill(1), mask: new Uint8Array(n).fill(1) });
    const g = buildObjectGeometry(obj);
    const region = Uint32Array.from({ length: n / 2 }, (_, i) => (i * 7919) % n); // unsorted, half of the mesh
    setTriangleHighlight(g, region, true);
    const attr = g.geometry.getAttribute("highlight") as BufferAttribute;
    expect(attr.updateRanges).toEqual([{ start: 0, count: n * 3 }]);
  });
});

describe("rebuildStates", () => {
  it("rewrites every drawn triangle from the states and uploads the attribute in one range", () => {
    const g = buildObjectGeometry(object());
    const attr = g.geometry.getAttribute("state") as BufferAttribute;
    updateTriangleStates(g, new Uint16Array([1, 1, 1]), [1]); // a pending partial range
    rebuildStates(g, new Uint16Array([2, 2, 1]));
    expect(Array.from(g.vertexStates)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(attr.updateRanges).toEqual([{ start: 0, count: 6 }]);
  });
});

describe("patchVertexShader", () => {
  it("declares the state and highlight attributes and mixes the highlight into the vertex color", () => {
    const patched = patchVertexShader(ShaderLib.lambert.vertexShader);
    expect(patched).toContain("attribute float state;");
    expect(patched).toContain("attribute float highlight;");
    expect(patched).toContain("highlight * 0.6");
  });

  it("looks the state up in the color table and converts it from sRGB, replacing color_vertex", () => {
    const patched = patchVertexShader(ShaderLib.lambert.vertexShader);
    expect(patched).toContain("uniform sampler2D ppColorTable;");
    expect(patched).toContain("texelFetch( ppColorTable, ivec2( ppState & 255, ppState >> 8 ), 0 )");
    expect(patched).toContain("ppSrgbToLinear( texelFetch");
    expect(patched).not.toContain("#include <color_vertex>");
  });

  it("throws if the shader has no color_vertex include (three.js changed)", () => {
    expect(() => patchVertexShader("void main() {}")).toThrow();
  });
});
