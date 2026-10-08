import type { BufferAttribute } from "three";
import { describe, expect, it } from "vitest";
import { ColorSurface } from "./colorSurface";
import { buildObjectGeometry } from "./objectGeometry";
import type { ViewObject, ViewScene } from "./viewScene";

function object(states: number[], mask: number[]): ViewObject {
  return {
    vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    tris: new Int32Array(states.length * 3).map((_, i) => [0, 1, 2][i % 3]),
    transform: null,
    states: new Uint16Array(states),
    mask: new Uint8Array(mask),
  };
}

function setup() {
  const scene: ViewScene = { palette: ["#000000", "#FF0000", "#00FF00"], objects: [object([1, 2], [1, 1]), object([1], [0])] };
  const surface = new ColorSurface();
  surface.setScene(scene);
  const full = buildObjectGeometry(scene.objects[0]);
  const empty = buildObjectGeometry(scene.objects[1]); // nothing drawn
  surface.add(0, full);
  surface.add(1, empty);
  return { scene, surface, full, empty, state: full.geometry.getAttribute("state") as BufferAttribute, emptyState: empty.geometry.getAttribute("state") as BufferAttribute };
}

describe("ColorSurface", () => {
  it("does nothing, and says so, before a scene is set", () => {
    const surface = new ColorSurface();
    const version = surface.table.texture.version;
    expect(surface.updateTriangleStates(0, [0])).toBe(false);
    expect(surface.refreshStates()).toBe(false);
    expect(surface.setPalette(["#000000", "#123456"])).toBe(false);
    expect(surface.table.texture.version).toBe(version);
  });

  it("does nothing after the scene is cleared", () => {
    const { surface, scene } = setup();
    surface.setScene(null);
    expect(surface.updateTriangleStates(0, [0])).toBe(false);
    expect(surface.refreshStates()).toBe(false);
    expect(surface.setPalette(scene.palette)).toBe(false);
  });

  it("ignores an object it has no geometry for", () => {
    const { surface } = setup();
    expect(surface.updateTriangleStates(7, [0])).toBe(false);
  });

  it("setPalette installs the Design colors in the table and the scene, and writes no attribute", () => {
    const { surface, scene, state } = setup();
    const version = state.version;
    expect(surface.setPalette(["#000000", "#102030", "#00FF00"])).toBe(true);
    expect(scene.palette[1]).toBe("#102030");
    expect(Array.from((surface.table.texture.image.data as Uint8Array).slice(4, 8))).toEqual([0x10, 0x20, 0x30, 255]);
    expect(state.version).toBe(version);
  });

  it("setScene installs the scene's palette as the Design colors", () => {
    const { surface } = setup();
    expect(Array.from((surface.table.texture.image.data as Uint8Array).slice(8, 12))).toEqual([0, 255, 0, 255]);
  });

  it("updateTriangleStates rewrites the scene's states for those triangles", () => {
    const { surface, scene, full } = setup();
    scene.objects[0].states[0] = 2;
    expect(surface.updateTriangleStates(0, [0])).toBe(true);
    expect(Array.from(full.vertexStates)).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it("refreshStates rewrites every object that draws something and skips the empty ones", () => {
    const { surface, scene, full, state, emptyState } = setup();
    scene.objects[0].states.set([2, 1]);
    const emptyVersion = emptyState.version;
    expect(surface.refreshStates()).toBe(true);
    expect(Array.from(full.vertexStates)).toEqual([2, 2, 2, 1, 1, 1]);
    expect(state.updateRanges).toEqual([{ start: 0, count: 6 }]);
    expect(emptyState.version).toBe(emptyVersion);
    expect(emptyState.updateRanges).toEqual([]);
  });

  it("setPrintColors switches the table without touching attributes, and survives a new scene", () => {
    const { surface, state } = setup();
    const version = state.version;
    surface.setPrintColors([undefined, "#101010"]);
    expect(surface.table.printing).toBe(true);
    expect(state.version).toBe(version);
    surface.setScene({ palette: ["#000000", "#FF0000"], objects: [] });
    expect(surface.table.printing).toBe(true);
    expect(Array.from((surface.table.texture.image.data as Uint8Array).slice(4, 8))).toEqual([16, 16, 16, 255]);
    surface.setPrintColors(null);
    expect(Array.from((surface.table.texture.image.data as Uint8Array).slice(4, 8))).toEqual([255, 0, 0, 255]);
  });
});
