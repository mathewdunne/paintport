// Mesh topology on imperfect input: triangle soup, duplicate faces, parts, hostile angles.
import { describe, expect, it } from "vitest";
import { cubeMesh, joinMeshes, makeModel, stripMesh, type MeshSpec } from "../../test/support/docFixtures";
import { CUBE_TRIS } from "../../test/support/fixtures";
import { createProject, type Project } from "./project";

function projectOf(mesh: MeshSpec, extra: Parameters<typeof makeModel>[1] = {}): Project {
  const p = createProject(makeModel(mesh, extra));
  p.addColor("#336699");
  return p;
}
const sorted = (a: ArrayLike<number>) => Array.from(a).sort((x, y) => x - y);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/** The unit cube as triangle soup: every triangle owns its three vertices. */
const soupCube = (): MeshSpec => ({ vertices: CUBE_TRIS.flat(), tris: range(0, 36) });

describe("triangle soup", () => {
  it("is welded by coordinates for adjacency, without changing the mesh", () => {
    const mesh = soupCube();
    const p = projectOf(mesh);
    const topo = p.topology(0);
    expect(topo.stats).toEqual({ manifoldEdges: 18, boundaryEdges: 0, nonManifoldEdges: 0, duplicateFaces: 0, shells: 1, weldedVertices: 28 });
    expect(p.objects[0].mesh.vertices.length / 3).toBe(36); // untouched
    expect(Array.from(p.objects[0].mesh.tris)).toEqual(range(0, 36));
  });

  it("fills like the welded cube", () => {
    const p = projectOf(soupCube());
    expect(sorted(p.smartFillRegion(0, 4, 30).tris)).toEqual([4, 5]);
    expect(sorted(p.smartFillRegion(0, 4, 91).tris)).toEqual(range(0, 12));
    expect(p.shellFillRegion(0, 0).tris).toHaveLength(12);
  });

  it("keeps separate bodies separate", () => {
    const soup = soupCube();
    const second = { vertices: soup.vertices.map((v, i) => (i % 3 === 0 ? v + 5 : v)), tris: range(0, 36) };
    const p = projectOf(joinMeshes(soup, second));
    expect(p.topology(0).stats.shells).toBe(2);
  });
});

describe("welding is per part", () => {
  const twoCubes = () => joinMeshes(cubeMesh(), cubeMesh([1, 0, 0])); // they touch on the plane x = 1 with coincident corners
  it("never connects two parts, even where their vertices coincide", () => {
    const p = projectOf(twoCubes(), {
      parts: [
        { firstTri: 0, triCount: 12, extruder: 1, type: "ModelPart", name: null },
        { firstTri: 12, triCount: 12, extruder: 1, type: "ModelPart", name: null },
      ],
    });
    const topo = p.topology(0);
    expect(topo.stats.shells).toBe(2);
    expect(topo.stats.weldedVertices).toBe(0);
    expect(p.shellFillRegion(0, 0).tris).toHaveLength(12);
    expect(p.smartFillRegion(0, 0, 180).tris).toHaveLength(12);
  });
});

describe("duplicate faces", () => {
  const doubled = (): MeshSpec => {
    const cube = cubeMesh();
    return { vertices: cube.vertices, tris: [...cube.tris, ...cube.tris] }; // triangle t + 12 repeats triangle t
  };

  it("are linked to their twin instead of turning every edge non-manifold", () => {
    const topo = projectOf(doubled()).topology(0);
    expect(topo.stats).toMatchObject({ duplicateFaces: 12, manifoldEdges: 18, nonManifoldEdges: 0, shells: 1 });
    expect(topo.duplicateOf![16]).toBe(4);
    expect(topo.duplicateOf![4]).toBe(-1);
    expect(topo.duplicateGroups!.get(16)).toEqual([4, 16]);
  });

  it("are filled together with their twin", () => {
    const p = projectOf(doubled());
    expect(sorted(p.smartFillRegion(0, 4, 30).tris)).toEqual([4, 5, 16, 17]);
    expect(sorted(p.smartFillRegion(0, 16, 30).tris)).toEqual([4, 5, 16, 17]); // starting from the copy
    expect(sorted(p.smartFillRegion(0, 4, 91).tris)).toEqual(range(0, 24));
    expect(p.shellFillRegion(0, 20).tris).toHaveLength(24);
  });

  it("follow the display state: a copy painted differently is not swept along", () => {
    const p = projectOf(doubled());
    p.paintTriangles(0, [16], 2);
    expect(sorted(p.smartFillRegion(0, 4, 30).tris)).toEqual([4, 5, 17]);
    expect(sorted(p.smartFillRegion(0, 16, 180).tris)).toEqual([16]); // from the painted copy only itself matches
  });

  it("do not leave holes in the surface", () => {
    // A flat strip of 4 quads with the second quad doubled (triangles 8 and 9 repeat 2 and 3).
    const strip = stripMesh([0, 0, 0]);
    const p = projectOf({ vertices: strip.vertices, tris: [...strip.tris, ...strip.tris.slice(6, 12)] }); // quad 1 is triangles 2 and 3
    expect(p.topology(0).stats.nonManifoldEdges).toBe(0);
    expect(sorted(p.smartFillRegion(0, 0, 5).tris)).toEqual(range(0, 10)); // everything, including beyond the doubled quad
  });

  it("are recognised when wound the other way round", () => {
    const cube = cubeMesh();
    const flipped = cube.tris.slice(0, 3).reverse();
    const p = projectOf({ vertices: cube.vertices, tris: [...cube.tris, ...flipped] });
    expect(p.topology(0).stats).toMatchObject({ duplicateFaces: 1, nonManifoldEdges: 0, manifoldEdges: 18 });
    expect(sorted(p.smartFillRegion(0, 0, 30).tris)).toContain(12);
  });

  it("combine with soup", () => {
    const soup = soupCube();
    const p = projectOf({ vertices: [...soup.vertices, ...soup.vertices], tris: range(0, 72) });
    expect(p.topology(0).stats).toMatchObject({ duplicateFaces: 12, manifoldEdges: 18, shells: 1 });
  });
});

describe("non-manifold edges", () => {
  const book: MeshSpec = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1], tris: [0, 1, 2, 0, 1, 3, 0, 1, 4] };

  it("continue into the flattest face only, and honor the threshold", () => {
    const p = projectOf(book);
    const topo = p.topology(0);
    expect(topo.nonManifoldLinks!.size).toBe(3);
    expect(sorted(p.smartFillRegion(0, 0, 30).tris)).toEqual([0, 1]);
    expect(sorted(p.smartFillRegion(0, 2, 45).tris)).toEqual([2]); // both other pages are 90 degrees away
  });
});

describe("smart fill angle", () => {
  const p = () => projectOf(stripMesh([10, 40, 25]));
  it("treats NaN and infinities as 0 instead of flooding everything", () => {
    const zero = sorted(p().smartFillRegion(0, 0, 0).tris);
    expect(zero).toEqual([0, 1]);
    for (const bad of [NaN, Infinity, -Infinity, -5]) expect(sorted(p().smartFillRegion(0, 0, bad).tris)).toEqual(zero);
  });
  it("clamps a huge finite angle to 180", () => {
    expect(p().smartFillRegion(0, 0, 1e9).tris).toHaveLength(8);
  });
});
