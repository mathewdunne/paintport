import { describe, expect, it } from "vitest";
import { emitTree, paintSphereTree, stateAtBary, treeLeaves, type Bary, type TreeNode } from "../doc/splitTree";
import { ATLAS_WIDTH, HIGHLIGHT_BIT, TreeAtlas, walkAtlas } from "./treeAtlas";

const corners = [[0, 0, 0], [100, 0, 0], [0, 100, 0]] as const;

/** A tree with a stroke of dabs, mixing depths. */
function strokeTree(seed: number, dabs = 8): TreeNode {
  let t: TreeNode = { state: 0 };
  for (let i = 0; i < dabs; i++) t = paintSphereTree(t, corners, [10 + seed + i * 4, 10 + i * 2, 0], 4, 1 + ((seed + i) % 3), 1);
  return t;
}

function randomBary(rand: () => number): Bary {
  let a = rand(), b = rand();
  if (a + b > 1) { a = 1 - a; b = 1 - b; }
  return [1 - a - b, a, b];
}

function lcg(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("TreeAtlas", () => {
  it("answers like the tree at random points (the shader's walk on the CPU)", () => {
    const atlas = new TreeAtlas();
    const rand = lcg(7);
    const trees = [0, 1, 2, 3].map((s) => strokeTree(s * 5));
    const roots = trees.map((t, i) => atlas.set(0, i, emitTree(t)));
    trees.forEach((t, i) => {
      for (let k = 0; k < 200; k++) {
        const p = randomBary(rand);
        expect(walkAtlas(atlas.words, roots[i] - 1, p) & 0xffff).toBe(stateAtBary(t, p));
      }
    });
  });

  it("stores no tree for a single leaf or none, and frees on removal", () => {
    const atlas = new TreeAtlas();
    expect(atlas.set(0, 0, emitTree({ state: 3 }))).toBe(0);
    expect(atlas.set(0, 1, undefined)).toBe(0);
    const root = atlas.set(0, 2, emitTree(strokeTree(1)));
    expect(root).toBeGreaterThan(0);
    expect(atlas.rootOf(0, 2)).toBe(root);
    expect(atlas.set(0, 2, emitTree(strokeTree(1)))).toBe(root); // unchanged tree: same place
    atlas.set(0, 2, undefined);
    expect(atlas.rootOf(0, 2)).toBe(0);
  });

  it("highlights leaves by leaf index", () => {
    const atlas = new TreeAtlas();
    const tree = strokeTree(2);
    const root = atlas.set(1, 5, emitTree(tree)) - 1;
    const leaves = treeLeaves(tree);
    const chosen = new Set([0, leaves.length - 1]);
    atlas.highlight(1, 5, chosen);
    leaves.forEach((l, i) => {
      const c = l.tri.map((_, k) => (l.tri[0][k] + l.tri[1][k] + l.tri[2][k]) / 3) as Bary;
      const word = walkAtlas(atlas.words, root, c);
      expect((word & HIGHLIGHT_BIT) !== 0, `leaf ${i}`).toBe(chosen.has(i));
      expect(word & 0xffff).toBe(l.state);
    });
    atlas.highlight(1, 5, null);
    leaves.forEach((l) => {
      const c = l.tri.map((_, k) => (l.tri[0][k] + l.tri[1][k] + l.tri[2][k]) / 3) as Bary;
      expect(walkAtlas(atlas.words, root, c) & HIGHLIGHT_BIT).toBe(0);
    });
  });

  it("grows past one texture row and keeps earlier trees valid", () => {
    const atlas = new TreeAtlas();
    const rand = lcg(3);
    const trees: TreeNode[] = [];
    let words = 0;
    for (let i = 0; words < ATLAS_WIDTH * 3; i++) {
      const t = strokeTree(i % 40, 12);
      trees.push(t);
      atlas.set(0, i, emitTree(t));
      words = atlas.rootOf(0, i);
    }
    expect(atlas.texture.image.height).toBeGreaterThan(1);
    trees.forEach((t, i) => {
      const p = randomBary(rand);
      expect(walkAtlas(atlas.words, atlas.rootOf(0, i) - 1, p) & 0xffff).toBe(stateAtBary(t, p));
    });
  });

  it("compacts garbage and reports it, keeping every tree and highlight", () => {
    const atlas = new TreeAtlas();
    const rand = lcg(11);
    const keep = strokeTree(9, 12);
    atlas.set(0, 0, emitTree(keep));
    atlas.highlight(0, 0, new Set([1]));
    let compacted = false;
    for (let round = 0; round < 400 && !compacted; round++) {
      atlas.set(0, 1, emitTree(strokeTree(round % 30, 12)));
      compacted = atlas.takeCompacted();
    }
    expect(compacted).toBe(true);
    const root = atlas.rootOf(0, 0) - 1;
    for (let k = 0; k < 100; k++) {
      const p = randomBary(rand);
      expect(walkAtlas(atlas.words, root, p) & 0xffff).toBe(stateAtBary(keep, p));
    }
    const l1 = treeLeaves(keep)[1];
    const c = l1.tri.map((_, k) => (l1.tri[0][k] + l1.tri[1][k] + l1.tri[2][k]) / 3) as Bary;
    expect(walkAtlas(atlas.words, root, c) & HIGHLIGHT_BIT).not.toBe(0);
  });

  it("flags uploads per texture row", () => {
    const atlas = new TreeAtlas();
    atlas.texture.clearUpdateRanges();
    atlas.set(0, 0, emitTree(strokeTree(4)));
    const ranges = atlas.texture.updateRanges;
    expect(ranges.length).toBeGreaterThan(0);
    for (const r of ranges) {
      const first = r.start / 4, last = (r.start + r.count) / 4 - 1;
      expect(Math.floor(first / ATLAS_WIDTH)).toBe(Math.floor(last / ATLAS_WIDTH));
    }
  });
});
