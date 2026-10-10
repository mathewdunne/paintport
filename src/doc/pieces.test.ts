import { describe, expect, it } from "vitest";
import { cubeMesh } from "../../test/support/docFixtures";
import { edgeNeighbors } from "./featureField";
import { MeshTopology, neighborTri } from "./meshTopology";
import { buildPieces, NodeBuffer, PieceGraph } from "./pieces";
import { emitTree, paintSphereTree, treeLeaves, type Bary, type TreeNode } from "./splitTree";

const leaf = (state: number): TreeNode => ({ state });
const split = (splitSides: number, special: number, children: TreeNode[]): TreeNode => ({ splitSides, special, children });

/** Brute force: two leaves touch along a stretch if points spread along one's sides lie on the other's sides. */
function touches(a: [Bary, Bary, Bary], b: [Bary, Bary, Bary]): boolean {
  let hits = 0;
  for (let e = 0; e < 3; e++) {
    for (let k = 1; k < 64; k++) {
      const s = k / 64, p = a[e].map((v, i) => v * (1 - s) + a[(e + 1) % 3][i] * s);
      for (let f = 0; f < 3; f++) {
        const q0 = b[f], q1 = b[(f + 1) % 3];
        // p on segment q0-q1 (2D in coordinates 1, 2)?
        const dx = q1[1] - q0[1], dy = q1[2] - q0[2], px = p[1] - q0[1], py = p[2] - q0[2];
        const cross = dx * py - dy * px, len2 = dx * dx + dy * dy, t = (px * dx + py * dy) / len2;
        if (Math.abs(cross) < 1e-12 && t > 1e-9 && t < 1 - 1e-9) hits++;
      }
    }
  }
  return hits >= 2;
}

function checkAgainstBruteForce(root: TreeNode) {
  const leaves = treeLeaves(root);
  const p = buildPieces(root);
  for (let i = 0; i < leaves.length; i++) {
    const mine = new Set(Array.from(p.adjacent.subarray(p.adjacentStart[i], p.adjacentStart[i + 1])));
    for (let j = 0; j < leaves.length; j++) {
      if (i === j) continue;
      expect(mine.has(j), `leaves ${i} and ${j}`).toBe(touches(leaves[i].tri, leaves[j].tri));
    }
  }
}

describe("pieces of a tree", () => {
  it("links the centre of a 3-side split to its corners, and the corners not to each other", () => {
    const p = buildPieces(split(3, 0, [leaf(1), leaf(2), leaf(3), leaf(4)]));
    const adj = (i: number) => Array.from(p.adjacent.subarray(p.adjacentStart[i], p.adjacentStart[i + 1])).sort();
    expect(adj(3)).toEqual([0, 1, 2]);
    expect(adj(0)).toEqual([3]);
    // Side 0 (corner 0 to 1) is touched by leaf 0 on [0, .5] and leaf 1 on [.5, 1].
    const side0 = [0, 1, 2, 3].flatMap((i) => {
      const out: [number, number, number][] = [];
      for (let c = p.contactStart[i]; c < p.contactStart[i + 1]; c++) if (p.side[c] === 0) out.push([i, p.from[c], p.to[c]]);
      return out;
    });
    expect(side0).toEqual([[0, 0, 0.5], [1, 0.5, 1]]);
    expect(p.areaShare.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("matches brute force for T-junctions and every split kind", () => {
    checkAgainstBruteForce(split(3, 0, [split(3, 0, [leaf(1), leaf(2), leaf(3), leaf(4)]), leaf(5), leaf(6), leaf(7)]));
    checkAgainstBruteForce(split(1, 2, [split(2, 1, [leaf(1), leaf(2), leaf(3)]), split(1, 0, [leaf(4), leaf(5)])]));
    let t: TreeNode = leaf(0);
    const corners = [[0, 0, 0], [10, 0, 0], [0, 10, 0]] as const;
    for (let i = 0; i < 4; i++) t = paintSphereTree(t, corners, [2 + i, 2 + i * 0.5, 0], 1.2, 2, 0.3);
    checkAgainstBruteForce(t);
  });
});

/** A 10 x 10 quad: triangle 0 = (0,0) (10,0) (10,10), triangle 1 = (0,0) (10,10) (0,10); they share the diagonal. */
function quadGraph(trees: Map<number, string>) {
  const mesh = { vertices: Float64Array.from([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]), tris: Int32Array.from([0, 1, 2, 0, 2, 3]), triCount: 2 };
  const topology = new MeshTopology(mesh, Uint8Array.from([1, 1]));
  const display = { painted: new Uint16Array(2), triPart: new Uint32Array(2), baseOfPart: [1] };
  return new PieceGraph(topology, display, trees);
}

describe("PieceGraph", () => {
  // Triangle 0 split once on all sides: its side 2 (corner 2 (10,10) to corner 0 (0,0)) is the shared diagonal,
  // touched by leaf 2 (from corner 2) and leaf 0 (to corner 0).
  const tree0 = emitTree(split(3, 0, [leaf(2), leaf(0), leaf(3), leaf(0)]));

  it("an unsplit neighbor sees exactly the pieces on the shared edge", () => {
    const g = quadGraph(new Map([[0, tree0]]));
    const buf = new NodeBuffer();
    const n = g.neighbors(1, buf);
    const nodes = Array.from(buf.nodes.subarray(0, n));
    expect(nodes.map((x) => g.triOf(x))).toEqual([0, 0]);
    const leaves = nodes.map((x) => x - g.triCount).sort();
    expect(leaves).toEqual([0, 2]);
    expect(nodes.map((x) => g.stateOf(x)).sort()).toEqual([2, 3]);
  });

  it("a piece sees its tree's neighbors and the triangle across its stretch of side", () => {
    const g = quadGraph(new Map([[0, tree0]]));
    const corner2 = g.nodeOf({ tri: 0, bary: [0.1, 0.1, 0.8] }); // near corner 2: leaf 2
    expect(corner2 - g.triCount).toBe(2);
    const buf = new NodeBuffer();
    const n = g.neighbors(corner2, buf);
    const out = Array.from(buf.nodes.subarray(0, n)).map((x) => (x < g.triCount ? `tri ${x}` : `leaf ${x - g.triCount}`)).sort();
    expect(out).toEqual(["leaf 3", "tri 1"]);
    expect(buf.codes[Array.from(buf.nodes.subarray(0, n)).indexOf(g.triCount + 3)]).toBe(-1);
  });

  it("maps the stretch when the neighbor runs the edge the other way", () => {
    // Both triangles split once: on the diagonal, triangle 1's side 0 (corner 0 (0,0) to 1 (10,10)) runs opposite to triangle 0's side 2.
    const tree1 = emitTree(split(3, 0, [leaf(4), leaf(5), leaf(6), leaf(7)]));
    const g = quadGraph(new Map([[0, tree0], [1, tree1]]));
    const buf = new NodeBuffer();
    const leaf2 = g.nodeOf({ tri: 0, bary: [0.1, 0.1, 0.8] }); // touches the diagonal near (10,10)
    const n = g.neighbors(leaf2, buf);
    const across = Array.from(buf.nodes.subarray(0, n)).filter((x) => g.triOf(x) === 1).map((x) => g.stateOf(x));
    expect(across).toEqual([5]); // triangle 1's leaf at its corner 1 = (10,10)
  });

  it("splits a node list into a region", () => {
    const g = quadGraph(new Map([[0, tree0]]));
    const a = g.nodeOf({ tri: 0, bary: [0.8, 0.1, 0.1] }), b = g.nodeOf({ tri: 0, bary: [0.1, 0.1, 0.8] });
    const region = g.toRegion(Uint32Array.of(1, b, a));
    expect(Array.from(region.tris)).toEqual([1]);
    expect(Array.from(region.pieces.get(0)!)).toEqual([0, 2]);
  });

  it("is the triangle graph when nothing is split", () => {
    const mesh = cubeMesh();
    const m = { vertices: Float64Array.from(mesh.vertices), tris: Int32Array.from(mesh.tris), triCount: 12 };
    const topology = new MeshTopology(m, new Uint8Array(12).fill(1));
    const g = new PieceGraph(topology, { painted: new Uint16Array(12), triPart: new Uint32Array(12), baseOfPart: [1] }, new Map());
    const buf = new NodeBuffer(), codes = new Int32Array(3);
    for (let t = 0; t < 12; t++) {
      const n = g.neighbors(t, buf);
      const c = edgeNeighbors(topology, topology.faceNormals(), t, codes);
      expect(Array.from(buf.codes.subarray(0, n))).toEqual(Array.from(codes.subarray(0, c)));
      expect(Array.from(buf.nodes.subarray(0, n))).toEqual(Array.from(codes.subarray(0, c)).map(neighborTri));
    }
  });
});
