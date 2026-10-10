// Phase 5 spike: ground truth from PrusaSlicer itself. A slab whose top face carries a known split tree
// is sliced by the installed PrusaSlicer CLI; each top-layer infill line's tool is compared with the
// leaf our split geometry puts under it.
//   PRUSA_CLI="C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe" npx vitest run --config spike/subtri/vitest.config.ts prusaSlice
import { expect, it } from "vitest";
import { emitPaintTree } from "../../src/core/paint/codec";
import { baryIn, leaf, samples, sliceTopInfill, split, toStringOrder, type P } from "./slicer";
import { ALL_CONVENTIONS, conventionName, PRUSA, stateAt, type Convention } from "./splitGeometry";

const cli = process.env.PRUSA_CLI;

it.skipIf(!cli)("PrusaSlicer paints the top layer where our split geometry puts each leaf", async () => {
  const top: [P, P, P] = [[0, 0], [60, 0], [30, 52]];
  // Prusa child order. All three split kinds, with asymmetric states so a wrong rule shows.
  const tree = split(3, 0, [
    leaf(2),
    split(1, 1, [leaf(1), leaf(2)]),
    split(2, 2, [leaf(2), leaf(1), split(1, 0, [leaf(2), leaf(1)])]),
    leaf(1),
  ]);
  const paint = emitPaintTree(toStringOrder(tree), "prusa");
  const infill = await sliceTopInfill(cli!, top, 2, paint);
  console.log(`paint ${paint}; top layer: ${infill.length} infill lines, tools ${[...new Set(infill.map((s) => s.tool))].join(",")}`);

  // `t` is the tree in the child order PrusaSlicer is assumed to use; `c.reversed` picks the assumption
  // about the string: reversed (t as built) or not (then the string's order is the child order).
  const score = (c: Convention) => {
    const t = c.reversed ? tree : toStringOrder(tree);
    const childOrder = { ...c, reversed: false };
    let n = 0, ok = 0;
    for (const { p, tool } of samples(infill)) {
      const bary = baryIn(p, top);
      if (Math.min(...bary) < 0.02) continue;
      n++;
      if (stateAt(t, bary, childOrder) - 1 === tool) ok++;
    }
    return { n, ok };
  };
  for (const c of ALL_CONVENTIONS) {
    const { n, ok } = score(c);
    console.log(`  ${conventionName(c)}: ${((ok / n) * 100).toFixed(1)}% of ${n} samples`);
  }
  const { n, ok } = score(PRUSA);
  expect(ok / n).toBeGreaterThan(0.95);
}, 300_000);
