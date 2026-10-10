// Phase 5 spike: our sub-triangle brush, end to end and for cost.
//   PRUSA_CLI=... npx vitest run --config spike/subtri/vitest.config.ts brush
import { expect, it } from "vitest";
import { emitPaintTree, parsePaintTree, type PaintNode } from "../../src/core/paint/codec";
import { countLeaves, paintSphereTree, toChildOrder, toStringOrder, type V3 } from "./brush";
import { baryIn, samples, sliceTopInfill, type P } from "./slicer";

const cli = process.env.PRUSA_CLI;

/** A stroke of dabs along a line, painted into one triangle's tree. */
function stroke(tree: PaintNode, corners: [V3, V3, V3], from: V3, to: V3, dabs: number, radius: number, state: number, limit: number) {
  for (let i = 0; i < dabs; i++) {
    const f = dabs === 1 ? 0 : i / (dabs - 1);
    const c: V3 = [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, from[2] + (to[2] - from[2]) * f];
    tree = paintSphereTree(tree, corners, c, radius, state, limit);
  }
  return tree;
}

it.skipIf(!cli)("PrusaSlicer prints a stroke painted with our brush where we painted it", async () => {
  const top: [P, P, P] = [[0, 0], [60, 0], [30, 52]];
  const corners = top.map(([x, y]) => [x, y, 2]) as [V3, V3, V3];
  const radius = 5, limit = 0.5, from: V3 = [15, 12, 2], to: V3 = [42, 22, 2];
  const tree = stroke({ state: 0 }, corners, from, to, 20, radius, 2, limit);
  const paint = emitPaintTree(toStringOrder(tree), "prusa");
  console.log(`stroke: ${countLeaves(tree)} leaves, ${paint.length} hex chars`);
  // Round trip through our codec keeps the tree.
  expect(toChildOrder(parsePaintTree(paint, "prusa"))).toEqual(tree);

  const infill = await sliceTopInfill(cli!, top, 2, paint);
  // Truth: distance to the stroke's segment (the union of the dabs, closely enough at 20 dabs).
  const dist = ([x, y]: P) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const t = Math.max(0, Math.min(1, ((x - from[0]) * dx + (y - from[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - from[0] - dx * t, y - from[1] - dy * t);
  };
  let n = 0, ok = 0, far = 0, farOk = 0;
  for (const { p, tool } of samples(infill)) {
    if (Math.min(...baryIn(p, top)) < 0.02) continue;
    const want = dist(p) <= radius ? 1 : 0; // state 2 -> T1, unpainted -> the object's extruder 1 -> T0
    n++; if (tool === want) ok++;
    if (Math.abs(dist(p) - radius) > limit) { far++; if (tool === want) farOk++; }
  }
  console.log(`  ${((ok / n) * 100).toFixed(1)}% of ${n} samples; ${((farOk / far) * 100).toFixed(2)}% of ${far} farther than the edge limit from the stroke's edge`);
  expect(farOk / far).toBeGreaterThan(0.99);
}, 300_000);

it("cost of a stroke across a large triangle, by edge limit", () => {
  const corners: [V3, V3, V3] = [[0, 0, 0], [100, 0, 0], [0, 100, 0]];
  for (const limit of [1, 0.5, 0.25, 0.1]) {
    const t0 = performance.now();
    let tree: PaintNode = { state: 0 };
    tree = stroke(tree, corners, [10, 10, 0], [60, 30, 0], 100, 3, 2, limit);
    const ms = performance.now() - t0;
    const str = emitPaintTree(toStringOrder(tree), "prusa");
    const t1 = performance.now();
    const back = parsePaintTree(str, "prusa");
    const parseMs = performance.now() - t1;
    console.log(`limit ${limit} mm (radius 3): 100 dabs ${ms.toFixed(0)} ms (${(ms / 100).toFixed(2)} ms/dab), ${countLeaves(tree)} leaves, ${str.length} hex chars, parse ${parseMs.toFixed(1)} ms`);
    expect(countLeaves(back)).toBe(countLeaves(tree));
  }
});

it("erasing the same stroke merges the tree back to one leaf", () => {
  const corners: [V3, V3, V3] = [[0, 0, 0], [100, 0, 0], [0, 100, 0]];
  let tree = stroke({ state: 0 }, corners, [10, 10, 0], [60, 30, 0], 50, 3, 2, 0.5);
  expect(countLeaves(tree)).toBeGreaterThan(100);
  tree = stroke(tree, corners, [10, 10, 0], [60, 30, 0], 50, 3.6, 0, 0.5); // a slightly larger eraser
  expect(tree).toEqual({ state: 0 });
});
