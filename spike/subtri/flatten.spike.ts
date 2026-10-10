// Phase 5 spike: the flattened layout answers like the tree, on real files.
//   SPIKE_FILES="D:/Downloads/Pikachu+AMS.3mf" npx vitest run --config spike/subtri/vitest.config.ts flatten
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { expect, it } from "vitest";
import { load3MF } from "../../src/core";
import { parsePaintTree } from "../../src/core/paint/codec";
import { appendTree, walk } from "./flatten";
import { PRUSA, stateAt, type Bary } from "./splitGeometry";

const files = (process.env.SPIKE_FILES ?? "").split(";").filter(Boolean);

it.skipIf(!files.length)("flattened trees give the same state as the tree walk", async () => {
  let seed = 1;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (const path of files) {
    const bytes = readFileSync(path);
    const model = await load3MF(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const nodes: number[] = [];
    let checked = 0, trees = 0;
    const t0 = performance.now();
    const roots: [ReturnType<typeof parsePaintTree>, number][] = [];
    for (const o of model.objects) for (const p of o.paints) {
      if (!p || p.length < 2) continue;
      const tree = parsePaintTree(p, model.paintDialect);
      if (!("children" in tree)) continue;
      roots.push([tree, appendTree(nodes, tree)]);
      trees++;
    }
    const ms = performance.now() - t0;
    for (const [tree, root] of roots.slice(0, 5000)) {
      for (let i = 0; i < 20; i++) {
        let a = rand(), b = rand();
        if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const p: Bary = [1 - a - b, a, b];
        expect(walk(nodes, root, p)).toBe(stateAt(tree, p, PRUSA));
        checked++;
      }
    }
    console.log(`${basename(path)}: ${trees} trees -> ${nodes.length} nodes (${(nodes.length * 4 / 1e6).toFixed(1)} MB) in ${ms.toFixed(0)} ms; ${checked} points agree`);
  }
}, 600_000);
