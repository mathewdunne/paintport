import { describe, expect, it } from "vitest";
import type { Model, PartRange } from "../core";
import { joinMeshes, makeModel, type MeshSpec } from "../../test/support/docFixtures";
import { dotChoice, dotIsCurrent, paletteFromModel, type PaletteDot } from "./palettePrint";

/** An axis-aligned box centered at (cx, cy) with half size `half` in X and Y, from z = 0 to `height`. */
function box(cx: number, cy: number, half: number, height: number): MeshSpec {
  const v = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]
    .flatMap(([x, y, z]) => [cx + x * half, cy + y * half, z * height]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { vertices: v, tris: f.flat() };
}

const WHITE = "#EBF7FF", CYAN = "#08ABFB", MAGENTA = "#D93B90";

/**
 * Filaments: 1 white, 2 cyan, 3 magenta, 4 cyan/magenta 0.85/0.15 (PrusaSlicer's fractions),
 * 5 a blend of 2 and an unknown extruder 6, 7 a cyan/magenta 1:1 blend.
 * Parts (12 triangles each): white base plate (40 x 40, 1 high), then dots of radius 2 and 5 high:
 * cyan at (-10, 0), the 85/15 blend at (10, 0), magenta at (0, 10), a modifier at (0, -10),
 * extruder 5 at (5, 5), extruder 6 at (-5, -5), the 1:1 blend at (0, -15).
 */
function palette(): Model {
  const meshes = [box(0, 0, 20, 1), box(-10, 0, 2, 5), box(10, 0, 2, 5), box(0, 10, 2, 5), box(0, -10, 2, 5), box(5, 5, 2, 5), box(-5, -5, 2, 5), box(0, -15, 2, 5)];
  const parts: PartRange[] = [
    { firstTri: 0, triCount: 12, extruder: 1, type: "ModelPart", name: "Base" },
    { firstTri: 12, triCount: 12, extruder: 2, type: "ModelPart", name: "1 Blue" },
    { firstTri: 24, triCount: 12, extruder: 4, type: "ModelPart", name: "7 B-R 85-15 &amp; more" },
    { firstTri: 36, triCount: 12, extruder: 3, type: "ModelPart", name: null },
    { firstTri: 48, triCount: 12, extruder: 2, type: "ParameterModifier", name: "modifier" },
    { firstTri: 60, triCount: 12, extruder: 5, type: "ModelPart", name: "broken recipe" },
    { firstTri: 72, triCount: 12, extruder: 6, type: "ModelPart", name: "unknown color" },
    { firstTri: 84, triCount: 12, extruder: 7, type: "ModelPart", name: "half and half" },
  ];
  return makeModel(joinMeshes(...meshes), {
    parts,
    filaments: [
      { color: WHITE }, { color: CYAN }, { color: MAGENTA },
      { color: "#0594E5", mix: [{ extruder: 2, ratio: 0.85 }, { extruder: 3, ratio: 0.15000000000000002 }] },
      { color: "#123456", mix: [{ extruder: 2, ratio: 0.5 }, { extruder: 6, ratio: 0.5 }] },
      null,
      { color: "#5E67B3", mix: [{ extruder: 2, ratio: 1 }, { extruder: 3, ratio: 1 }] },
    ],
  });
}

const byName = (dots: PaletteDot[], name: string) => dots.find((d) => d.name === name)!;

describe("paletteFromModel", () => {
  it("makes one dot per ModelPart with a known color: footprint, file color, ingredients", () => {
    const p = paletteFromModel(palette(), "pal")!;
    expect(p.name).toBe("pal");
    expect(p.dots.map((d) => d.name)).toEqual(["Base", "1 Blue", "7 B-R 85-15 & more", "", "half and half"]);
    expect(byName(p.dots, "1 Blue")).toEqual({ name: "1 Blue", x: -10, y: 0, r: 2, top: 5, color: CYAN, ingredients: [{ color: CYAN, weight: 1 }], backdrop: false });
    expect(byName(p.dots, "7 B-R 85-15 & more")).toMatchObject({ x: 10, y: 0, color: "#0594E5", ingredients: [{ color: CYAN, weight: 85 }, { color: MAGENTA, weight: 15 }] });
    expect(byName(p.dots, "half and half").ingredients).toEqual([{ color: CYAN, weight: 1 }, { color: MAGENTA, weight: 1 }]);
    expect(byName(p.dots, "")).toMatchObject({ x: 0, y: 10, color: MAGENTA });
  });

  it("marks the base plate as a backdrop, and only it", () => {
    const p = paletteFromModel(palette(), "pal")!;
    expect(p.dots.filter((d) => d.backdrop).map((d) => d.name)).toEqual(["Base"]);
    expect(byName(p.dots, "Base")).toMatchObject({ x: 0, y: 0, r: 20, top: 1 });
  });

  it("applies the build item's transform", () => {
    const m = palette();
    m.objects[0].transform = "1 0 0 0 1 0 0 0 1 100 50 2";
    const dot = byName(paletteFromModel(m, "pal")!.dots, "1 Blue");
    expect(dot).toMatchObject({ x: 90, y: 50, r: 2, top: 7 });
  });

  it("is null when no clickable dot is left", () => {
    const m = palette();
    m.filaments.forEach((f) => { f.colorKnown = false; });
    expect(paletteFromModel(m, "pal")).toBeNull();
    // Only a plate with nothing on it: not a backdrop, so still a (one-dot) palette.
    const plate = makeModel(box(0, 0, 20, 1), { filaments: [{ color: WHITE }] });
    expect(paletteFromModel(plate, "plate")!.dots).toHaveLength(1);
  });
});

describe("dotChoice", () => {
  const dots = paletteFromModel(palette(), "pal")!.dots;
  const blue = byName(dots, "1 Blue"), blend = byName(dots, "7 B-R 85-15 & more");
  const spools = [{ slot: 1, color: WHITE }, { slot: 2, color: CYAN }, { slot: 3, color: MAGENTA }];

  it("pins the spool of a single-color dot and the reduced recipe of a blend", () => {
    expect(dotChoice(blue, spools, true)).toEqual({ kind: "pin", pin: { kind: "spool", slot: 2 } });
    expect(dotChoice(blend, spools, true)).toEqual({ kind: "pin", pin: { kind: "blend", components: [{ slot: 2, ratio: 17 }, { slot: 3, ratio: 3 }] } });
  });

  it("matches by color, so reordered spools still work, sorted by slot", () => {
    const moved = [{ slot: 1, color: MAGENTA }, { slot: 6, color: CYAN }];
    expect(dotChoice(blend, moved, true)).toEqual({ kind: "pin", pin: { kind: "blend", components: [{ slot: 1, ratio: 3 }, { slot: 6, ratio: 17 }] } });
  });

  it("takes the lower slot when a color is on two spools", () => {
    expect(dotChoice(blue, [{ slot: 4, color: CYAN }, { slot: 7, color: CYAN }], true)).toEqual({ kind: "pin", pin: { kind: "spool", slot: 4 } });
  });

  it("names the missing colors, once each", () => {
    expect(dotChoice(blend, [{ slot: 1, color: WHITE }], true)).toEqual({ kind: "missing", colors: [CYAN, MAGENTA] });
    expect(dotChoice(blend, [{ slot: 2, color: CYAN }], false)).toEqual({ kind: "missing", colors: [MAGENTA] });
  });

  it("refuses blends while ColorMix is off, but not spools", () => {
    expect(dotChoice(blend, spools, false)).toEqual({ kind: "mixOff" });
    expect(dotChoice(blue, spools, false)).toEqual({ kind: "pin", pin: { kind: "spool", slot: 2 } });
  });

  it("adds up ingredients that land on the same spool", () => {
    const twins: PaletteDot = { ...blend, ingredients: [{ color: CYAN, weight: 60 }, { color: CYAN, weight: 25 }, { color: MAGENTA, weight: 15 }] };
    expect(dotChoice(twins, spools, true)).toEqual({ kind: "pin", pin: { kind: "blend", components: [{ slot: 2, ratio: 17 }, { slot: 3, ratio: 3 }] } });
    const same: PaletteDot = { ...blend, ingredients: [{ color: CYAN, weight: 85 }, { color: CYAN, weight: 15 }] };
    expect(dotChoice(same, spools, false)).toEqual({ kind: "pin", pin: { kind: "spool", slot: 2 } });
  });
});

describe("dotIsCurrent", () => {
  const choice = { kind: "pin", pin: { kind: "blend", components: [{ slot: 2, ratio: 17 }, { slot: 3, ratio: 3 }] } } as const;
  it("compares with the row's resolved target, recipes in reduced form", () => {
    const comps = [{ slot: 2, color: CYAN, ratio: 85 }, { slot: 3, color: MAGENTA, ratio: 15 }];
    expect(dotIsCurrent(choice, { kind: "blend", components: comps, color: "#000000", deltaE: 0, source: "hint" })).toBe(true);
    expect(dotIsCurrent(choice, { kind: "spool", slot: 2, color: CYAN, deltaE: 0, source: "auto" })).toBe(false);
    expect(dotIsCurrent({ kind: "mixOff" }, { kind: "none", source: "auto" })).toBe(false);
    expect(dotIsCurrent({ kind: "pin", pin: { kind: "spool", slot: 2 } }, { kind: "spool", slot: 2, color: CYAN, deltaE: 0, source: "pin" })).toBe(true);
  });
});
