import { ShaderLib, type BufferAttribute } from "three";
import { describe, expect, it } from "vitest";
import { patchVertexShader } from "./material";
import { buildObjectGeometry, paletteToBytes, updateTriangleColors } from "./objectGeometry";
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
const PALETTE = ["#000000", "#FF0000", "#00FF80"];

describe("paletteToBytes", () => {
  it("gives sRGB bytes per state and gray for junk", () => {
    expect(Array.from(paletteToBytes(["#000000", "#FF0000", "#00FF80", "nope"]))).toEqual([0, 0, 0, 255, 0, 0, 0, 255, 128, 128, 128, 128]);
  });
});

describe("buildObjectGeometry", () => {
  it("lays out 3 vertices per drawn triangle and skips masked ones", () => {
    const g = buildObjectGeometry(object(), paletteToBytes(PALETTE));
    expect(g.slotCount).toBe(2);
    expect(Array.from(g.slotOfTri)).toEqual([0, 1, -1]);
    const pos = g.geometry.getAttribute("position");
    expect(pos.count).toBe(6);
    expect(g.geometry.index).toBeNull(); // non-indexed
  });

  it("applies the build item transform (translation, row-vector convention)", () => {
    const g = buildObjectGeometry(object(), paletteToBytes(PALETTE));
    const pos = Array.from(g.geometry.getAttribute("position").array);
    expect(pos.slice(0, 9)).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
    const box = g.geometry.boundingBox!;
    expect([box.min.x, box.max.x, box.min.y, box.max.y]).toEqual([10, 11, 0, 1]);
  });

  it("applies a rotation (90 degrees about z maps x to y)", () => {
    const g = buildObjectGeometry(object({ transform: "0 1 0 -1 0 0 0 0 1 0 0 0" }), paletteToBytes(PALETTE));
    const pos = Array.from(g.geometry.getAttribute("position").array);
    expect(pos.slice(0, 9)).toEqual([0, 0, 0, 0, 1, 0, -1, 0, 0]);
  });

  it("writes one flat sRGB color per triangle as normalized bytes", () => {
    const g = buildObjectGeometry(object(), paletteToBytes(PALETTE));
    const attr = g.geometry.getAttribute("color");
    expect(attr.normalized).toBe(true);
    expect(attr.array).toBeInstanceOf(Uint8Array);
    expect(Array.from(attr.array)).toEqual([
      255, 0, 0, 255, 0, 0, 255, 0, 0, // state 1
      0, 255, 128, 0, 255, 128, 0, 255, 128, // state 2
    ]);
  });

  it("falls back to gray for a state outside the palette", () => {
    const g = buildObjectGeometry(object({ states: new Uint16Array([9, 1, 1]) }), paletteToBytes(PALETTE));
    expect(Array.from(g.geometry.getAttribute("color").array.slice(0, 3))).toEqual([128, 128, 128]);
  });

  it("handles an object with nothing to draw", () => {
    const g = buildObjectGeometry(object({ mask: new Uint8Array(3) }), paletteToBytes(PALETTE));
    expect(g.slotCount).toBe(0);
  });
});

describe("updateTriangleColors", () => {
  it("rewrites only the given triangles and flags just their range for upload", () => {
    const obj = object();
    const bytes = paletteToBytes(PALETTE);
    const g = buildObjectGeometry(obj, bytes);
    obj.states[1] = 1; // document changes triangle 1 from state 2 to state 1
    updateTriangleColors(g, obj.states, [1], bytes);
    const color = Array.from(g.geometry.getAttribute("color").array);
    expect(color).toEqual(Array(6).fill([255, 0, 0]).flat());
    const attr = g.geometry.getAttribute("color") as BufferAttribute;
    expect(attr.updateRanges).toEqual([{ start: 9, count: 9 }]);
  });

  it("keeps the ranges of several updates made before a render, one per contiguous run", () => {
    const n = 100;
    const tris = new Int32Array(n * 3);
    for (let i = 0; i < n; i++) { tris[i * 3] = 0; tris[i * 3 + 1] = 1; tris[i * 3 + 2] = 2; }
    const obj = object({ tris, states: new Uint16Array(n).fill(1), mask: new Uint8Array(n).fill(1) });
    const bytes = paletteToBytes(PALETTE);
    const g = buildObjectGeometry(obj, bytes);
    obj.states[5] = 2; obj.states[90] = 2; obj.states[6] = 2; obj.states[7] = 2;
    updateTriangleColors(g, obj.states, [5], bytes);
    updateTriangleColors(g, obj.states, [90, 7, 6, 6], bytes); // unsorted, with a duplicate
    const attr = g.geometry.getAttribute("color") as BufferAttribute;
    expect(attr.updateRanges).toEqual([
      { start: 5 * 9, count: 9 },
      { start: 6 * 9, count: 2 * 9 },
      { start: 90 * 9, count: 9 },
    ]);
    expect(Array.from(attr.array.slice(90 * 9, 90 * 9 + 3))).toEqual([0, 255, 128]);
  });

  it("ignores masked and out-of-range triangles without flagging an upload", () => {
    const obj = object();
    const bytes = paletteToBytes(PALETTE);
    const g = buildObjectGeometry(obj, bytes);
    const before = Array.from(g.geometry.getAttribute("color").array);
    const version = (g.geometry.getAttribute("color") as BufferAttribute).version;
    updateTriangleColors(g, obj.states, [2], bytes); // masked
    expect(Array.from(g.geometry.getAttribute("color").array)).toEqual(before);
    expect((g.geometry.getAttribute("color") as BufferAttribute).version).toBe(version);
  });
});

describe("patchVertexShader", () => {
  it("converts the sRGB vertex color after three's color_vertex chunk", () => {
    const src = ShaderLib.lambert.vertexShader;
    const patched = patchVertexShader(src);
    expect(patched).toContain("ppSrgbToLinear");
    expect(patched.indexOf("vColor.rgb = ppSrgbToLinear( color )")).toBeGreaterThan(patched.indexOf("#include <color_vertex>"));
  });

  it("throws if the shader has no color_vertex include (three.js changed)", () => {
    expect(() => patchVertexShader("void main() {}")).toThrow();
  });
});
