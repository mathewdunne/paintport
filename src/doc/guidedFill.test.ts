import { describe, expect, it } from "vitest";
import { cubeMesh, makeModel, type MeshSpec } from "../../test/support/docFixtures";
import { centroidX, coverage, plateTriAt as triAt, texturedPlate } from "../../test/support/plates";
import { createProject, type Project } from "./project";

function projectOf(mesh: MeshSpec): Project {
  const p = createProject(makeModel(mesh));
  p.addColor("#336699");
  return p;
}
const sorted = (a: ArrayLike<number>) => Array.from(a).sort((x, y) => x - y);

describe("guided fill", () => {
  const leaky = texturedPlate({ gap: 0.6 });
  const xs = centroidX(leaky);

  it("is the smart fill, or the union of them, without outside marks", () => {
    const p = projectOf(leaky);
    expect(sorted(p.guidedFillRegion(0, [triAt(1, 1)], [], 20, 0.3).tris)).toEqual(sorted(p.smartFillRegion(0, triAt(1, 1), 20, 0.3).tris));
    const plate = projectOf(texturedPlate());
    const left = plate.smartFillRegion(0, triAt(1, 3), 20, 0.3).tris, right = plate.smartFillRegion(0, triAt(5, 3), 20, 0.3).tris;
    expect(sorted(plate.guidedFillRegion(0, [triAt(1, 3), triAt(5, 3)], [], 20, 0.3).tris)).toEqual(sorted([...new Set([...left, ...right])]));
    expect(p.guidedFillRegion(0, [], [triAt(1, 1)], 20, 0.3).tris).toHaveLength(0);
  });

  it("an outside mark beyond a leaky groove cuts the fill back to the groove", () => {
    const p = projectOf(leaky);
    const leaked = p.smartFillRegion(0, triAt(1, 1), 20, 0.3).tris;
    expect(coverage(leaked, xs, 3.4, 6)).toBeGreaterThan(0.9); // through the gap at y = 3

    const region = p.guidedFillRegion(0, [triAt(1, 1)], [triAt(5, 5)], 20, 0.3).tris;
    expect(coverage(region, xs, 0, 2.6)).toBe(1);
    expect(coverage(region, xs, 3.4, 6)).toBeLessThan(0.02);
  });

  it("splits a surface without any crease between the marks", () => {
    const flat = texturedPlate({ flat: true });
    const fx = centroidX(flat);
    const p = projectOf(flat);
    const region = p.guidedFillRegion(0, [triAt(1, 3)], [triAt(5, 3)], 20, 0.3).tris;
    // About halfway; the grid's diagonals all run one way, which skews distances on it a little.
    expect(coverage(region, fx, 0, 1.8)).toBe(1);
    expect(coverage(region, fx, 4.2, 6)).toBe(0);
  });

  it("stops both floods at existing paint, and ignores outside marks on other colors", () => {
    const p = projectOf(leaky);
    const wall = Array.from({ length: leaky.tris.length / 3 }, (_, t) => t).filter((t) => xs[t] >= 1.5 && xs[t] < 1.6);
    p.paintTriangles(0, wall, 2);
    const region = p.guidedFillRegion(0, [triAt(0.5, 3)], [wall[0]], 20, 0.3).tris;
    expect(coverage(region, xs, 0, 1.45)).toBe(1);
    expect(coverage(region, xs, 1.5, 6)).toBe(0);
  });

  it("works edge by edge on a mesh of flat facets", () => {
    const p = projectOf(cubeMesh());
    expect(p.smartFillRegion(0, 0, 100).tris).toHaveLength(12);
    const faceOf = (t: number) => Math.floor(t / 2);
    const region = p.guidedFillRegion(0, [0], [2], 100, 0.3).tris;
    const faces = new Set(Array.from(region, faceOf));
    expect(faces.has(0)).toBe(true);
    expect(faces.has(1)).toBe(false);
    expect(region.length).toBeLessThan(12);
  });
});
