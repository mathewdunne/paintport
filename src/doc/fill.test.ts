import { describe, expect, it } from "vitest";
import { cubeMesh, joinMeshes, makeModel, stripMesh, weldMesh, type MeshSpec } from "../../test/support/docFixtures";
import { neighborFlipped, neighborTri, NEIGHBOR_NON_MANIFOLD, NEIGHBOR_NONE } from "./meshTopology";
import { createProject, type Project } from "./project";

/** A project over `mesh` with two design colors (1 = base, 2 = a second one). */
function projectOf(mesh: MeshSpec, extra: Parameters<typeof makeModel>[1] = {}): Project {
  const p = createProject(makeModel(mesh, extra));
  p.addColor("#336699");
  return p;
}
const sorted = (a: ArrayLike<number>) => Array.from(a).sort((x, y) => x - y);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("MeshTopology", () => {
  it("pairs every edge of a closed cube", () => {
    const topo = projectOf(cubeMesh()).topology(0);
    expect(topo.stats).toEqual({ manifoldEdges: 18, boundaryEdges: 0, nonManifoldEdges: 0, duplicateFaces: 0, shells: 1, weldedVertices: 0 });
    for (let t = 0; t < 12; t++) {
      for (let k = 0; k < 3; k++) {
        const code = topo.neighbors[t * 3 + k];
        expect(code).toBeGreaterThanOrEqual(0);
        const u = neighborTri(code);
        expect(u).not.toBe(t);
        expect(neighborFlipped(code)).toBe(false); // the cube is wound consistently
        // adjacency is symmetric
        expect([0, 1, 2].map((j) => neighborTri(topo.neighbors[u * 3 + j]))).toContain(t);
      }
    }
  });

  it("marks the open sides of a strip as boundary", () => {
    const quads = 4;
    const topo = projectOf(stripMesh([10, 20, 30])).topology(0);
    // 2 * quads triangles: 2 * quads - 1 interior edges, 2 * quads + 2 boundary edges
    expect(topo.stats.manifoldEdges).toBe(2 * quads - 1);
    expect(topo.stats.boundaryEdges).toBe(2 * quads + 2);
    expect(Array.from(topo.neighbors).filter((c) => c === NEIGHBOR_NONE)).toHaveLength(2 * quads + 2);
  });

  it("finds separate shells", () => {
    const mesh = joinMeshes(cubeMesh(), cubeMesh([5, 0, 0]));
    const topo = projectOf(mesh).topology(0);
    expect(topo.stats.shells).toBe(2);
    expect(topo.shellOfTri[0]).toBe(0);
    expect(topo.shellOfTri[12]).toBe(1);
  });

  it("ignores triangles that are not print surface", () => {
    const p = projectOf(cubeMesh(), {
      parts: [
        { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
        { firstTri: 8, triCount: 4, extruder: 1, type: "NegativeVolume", name: null },
      ],
    });
    const topo = p.topology(0);
    expect(Array.from(topo.shellOfTri.slice(8))).toEqual([-1, -1, -1, -1]);
    for (let t = 0; t < 8; t++) for (let k = 0; k < 3; k++) expect(topo.neighbors[t * 3 + k] === NEIGHBOR_NONE || neighborTri(topo.neighbors[t * 3 + k]) < 8).toBe(true);
  });

  it("treats a duplicated edge shared by three triangles as non-manifold", () => {
    // Three pages around the edge (0,0,0)-(1,0,0).
    const book: MeshSpec = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1], tris: [0, 1, 2, 0, 1, 3, 0, 1, 4] };
    const p = projectOf(book);
    const topo = p.topology(0);
    expect(topo.stats.nonManifoldEdges).toBe(1);
    expect(topo.stats.manifoldEdges).toBe(0);
    expect(Array.from(topo.neighbors).filter((c) => c === NEIGHBOR_NON_MANIFOLD)).toHaveLength(3);
    // The pages are one shell. Smart fill continues into the page with the smallest dihedral
    // angle only: page 1 lies flat against page 0 (180 degrees open, wound the other way), page 2 stands up.
    expect(sorted(p.shellFillRegion(0, 0).tris)).toEqual([0, 1, 2]);
    expect(sorted(p.smartFillRegion(0, 0, 180).tris)).toEqual([0, 1]);
    expect(sorted(p.smartFillRegion(0, 2, 30).tris)).toEqual([2]); // page 2 is 90 degrees from both
    expect(sorted(p.smartFillRegion(0, 2, 90).tris)).toEqual([0, 1, 2]); // page 2 -> page 0 (90 degrees) -> page 1 (flat against it)
  });

  it("is cached per object", () => {
    const p = projectOf(cubeMesh());
    expect(p.topology(0)).toBe(p.topology(0));
  });
});

describe("shell fill", () => {
  it("returns the whole connected shell under the seed, and only that", () => {
    const p = projectOf(joinMeshes(cubeMesh(), cubeMesh([5, 0, 0])));
    expect(sorted(p.shellFillRegion(0, 3).tris)).toEqual(range(0, 12));
    expect(sorted(p.shellFillRegion(0, 20).tris)).toEqual(range(12, 24));
  });

  it("ignores paint", () => {
    const p = projectOf(cubeMesh());
    p.paintTriangles(0, [0, 1, 2], 2);
    expect(sorted(p.shellFillRegion(0, 5).tris)).toEqual(range(0, 12));
  });

  it("stays on print surface and returns nothing from a negative volume", () => {
    const p = projectOf(cubeMesh(), {
      parts: [
        { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
        { firstTri: 8, triCount: 4, extruder: 1, type: "NegativeVolume", name: null },
      ],
    });
    expect(sorted(p.shellFillRegion(0, 0).tris)).toEqual(range(0, 8));
    expect(p.shellFillRegion(0, 9).tris).toHaveLength(0);
  });

  it("returns nothing for a seed that does not exist", () => {
    const p = projectOf(cubeMesh());
    expect(p.shellFillRegion(0, -1).tris).toHaveLength(0);
    expect(p.shellFillRegion(0, 12).tris).toHaveLength(0);
  });

  it("connects bodies that touch along an edge, and smart fill crosses it to the flattest neighbor", () => {
    // Two cubes sharing the vertical edge x = 1, y = 1: four triangles meet on it. Triangles 4 and 5 are
    // cube A's x = 1 face; in cube B (offset by 1, 1) the x = 1 face continues in the same plane.
    const p = projectOf(weldMesh(joinMeshes(cubeMesh(), cubeMesh([1, 1, 0]))));
    const topo = p.topology(0);
    expect(topo.stats.nonManifoldEdges).toBe(1);
    expect(topo.stats.shells).toBe(1);
    expect(p.shellFillRegion(0, 0).tris).toHaveLength(24);
    const flat = p.smartFillRegion(0, 6, 5).tris; // A's x = 1 face (triangles 6, 7 in the fixture's order)
    expect(flat).toHaveLength(4); // the face, and the coplanar face of B across the shared edge
    expect(flat.every((t) => t < 6 || t >= 12 || t === 6 || t === 7)).toBe(true);
    expect(sorted(p.smartFillRegion(0, 0, 180).tris)).toHaveLength(24);
  });
});

describe("smart fill", () => {
  // Quad i is triangles 2i and 2i+1. The joints turn by 10, 40 and 25 degrees.
  const strip = () => projectOf(stripMesh([10, 40, 25]));
  const quads = (from: number, to: number) => range(from * 2, to * 2);

  it("spreads across edges up to the angle threshold and stops at sharper ones", () => {
    const p = strip();
    expect(sorted(p.smartFillRegion(0, 0, 0).tris)).toEqual(quads(0, 1)); // only the coplanar partner
    expect(sorted(p.smartFillRegion(0, 0, 5).tris)).toEqual(quads(0, 1));
    expect(sorted(p.smartFillRegion(0, 0, 15).tris)).toEqual(quads(0, 2)); // passes the 10 degree joint
    expect(sorted(p.smartFillRegion(0, 0, 30).tris)).toEqual(quads(0, 2)); // the 40 degree joint blocks
    expect(sorted(p.smartFillRegion(0, 0, 45).tris)).toEqual(quads(0, 4));
    expect(sorted(p.smartFillRegion(0, 7, 30).tris)).toEqual(quads(2, 4)); // from the other end: 25 passes, 40 blocks
    expect(sorted(p.smartFillRegion(0, 7, 24).tris)).toEqual(quads(3, 4));
  });

  it("compares neighboring faces, so a gentle curve is followed around any total angle", () => {
    const p = projectOf(stripMesh(Array(11).fill(20))); // 12 quads, 20 degrees per joint: 220 degrees in total
    expect(p.smartFillRegion(0, 0, 25).tris).toHaveLength(24);
  });

  it("stops at existing paint boundaries", () => {
    const p = strip();
    p.paintTriangles(0, quads(1, 2), 2);
    expect(sorted(p.smartFillRegion(0, 0, 180).tris)).toEqual(quads(0, 1));
    expect(sorted(p.smartFillRegion(0, 2, 180).tris)).toEqual(quads(1, 2));
    expect(sorted(p.smartFillRegion(0, 6, 180).tris)).toEqual(quads(2, 4)); // unpainted beyond the painted quad
  });

  it("compares what is shown, not what is stored: painting with the base color is no boundary", () => {
    const p = strip();
    p.paintTriangles(0, quads(1, 2), 1); // explicitly the base color (state 1)
    expect(sorted(p.smartFillRegion(0, 0, 180).tris)).toEqual(quads(0, 4));
  });

  it("follows a changed base color", () => {
    const p = strip();
    p.paintTriangles(0, quads(0, 1), 2);
    p.setBaseColor(0, 0, 2); // now the unpainted quads show color 2, like the painted one
    expect(sorted(p.smartFillRegion(0, 0, 180).tris)).toEqual(quads(0, 4));
  });

  it("separates the faces of a cube at a moderate angle and covers it at a large one", () => {
    const p = projectOf(cubeMesh());
    expect(sorted(p.smartFillRegion(0, 4, 30).tris)).toEqual([4, 5]);
    expect(sorted(p.smartFillRegion(0, 4, 89).tris)).toEqual([4, 5]);
    expect(sorted(p.smartFillRegion(0, 4, 91).tris)).toEqual(range(0, 12));
  });

  it("composes with painting: a filled face is a paint boundary for the next fill", () => {
    const p = projectOf(cubeMesh());
    p.paintTriangles(0, p.smartFillRegion(0, 4, 30).tris, 2);
    expect(sorted(p.smartFillRegion(0, 4, 30).tris)).toEqual([4, 5]); // same state: still the same two
    expect(sorted(p.smartFillRegion(0, 0, 180).tris)).toEqual(sorted(range(0, 12).filter((t) => t !== 4 && t !== 5)));
  });

  it("is not confused by inconsistent winding", () => {
    // Two coplanar triangles sharing an edge; the second is wound the other way round.
    const flat: MeshSpec = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], tris: [0, 1, 2, 1, 2, 3] };
    const p = projectOf(flat);
    expect(neighborFlipped(p.topology(0).neighbors[1])).toBe(true);
    expect(sorted(p.smartFillRegion(0, 0, 5).tris)).toEqual([0, 1]);
    // A real 90 degree fold with the same flipped winding is still a crease.
    const fold: MeshSpec = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1], tris: [0, 1, 2, 1, 2, 3] };
    const q = projectOf(fold);
    expect(sorted(q.smartFillRegion(0, 0, 45).tris)).toEqual([0]);
    expect(sorted(q.smartFillRegion(0, 0, 135).tris)).toEqual([0, 1]);
  });

  it("lets a zero-area triangle pass the flood instead of cutting the surface in two", () => {
    // T0 and T2 are separated by the collinear T1. T2 is folded 90 degrees up from T0.
    const m: MeshSpec = {
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0.5, 0, 1, 0.5, 0.5],
      tris: [0, 1, 2, 1, 2, 3, 1, 3, 4],
    };
    const p = projectOf(m);
    expect(sorted(p.smartFillRegion(0, 0, 10).tris)).toEqual([0, 1, 2]);
  });

  it("gives the same result when repeated and when interleaved with other fills", () => {
    const p = strip();
    const a = Array.from(p.smartFillRegion(0, 0, 30).tris);
    p.smartFillRegion(0, 7, 90).tris;
    p.smartFillRegion(0, 3, 5).tris;
    expect(Array.from(p.smartFillRegion(0, 0, 30).tris)).toEqual(a);
  });

  it("fills nothing from a seed that is not print surface", () => {
    const p = projectOf(cubeMesh(), {
      parts: [
        { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
        { firstTri: 8, triCount: 4, extruder: 1, type: "NegativeVolume", name: null },
      ],
    });
    expect(p.smartFillRegion(0, 9, 180).tris).toHaveLength(0);
    expect(p.smartFillRegion(0, 99, 180).tris).toHaveLength(0);
  });
});
