// Phase 5 spike: which split convention makes real painted files consistent across triangle edges?
//   SPIKE_FILES="D:/Downloads/yoshi.3mf;D:/Downloads/charizar.3mf" npx vitest run --config spike/subtri/vitest.config.ts edgeCheck
// For every edge shared by two triangles where at least one carries a split tree, the paint is sampled
// along the edge from both sides. With the right convention both sides mostly agree; a wrong one
// scrambles the leaves and agreement drops. Real files are read in place, never copied.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { it } from "vitest";
import { load3MF } from "../../src/core";
import { parsePaintTree, type PaintNode } from "../../src/core/paint/codec";
import { ALL_CONVENTIONS, SIDE_VARIANTS, conventionName, leaves, PRUSA, stateAt, type Bary } from "./splitGeometry";

const files = (process.env.SPIKE_FILES ?? "").split(";").filter(Boolean);
const SAMPLES = 16;
const CONVENTIONS = process.env.SPIKE_VARIANTS ? SIDE_VARIANTS : ALL_CONVENTIONS;

it.skipIf(!files.length)("edge consistency per convention", async () => {
  for (const path of files) {
    const bytes = readFileSync(path);
    const model = await load3MF(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    let splitTris = 0, leafCount = 0, maxDepth = 0, tris = 0;
    const sidesHist = [0, 0, 0, 0];
    const agree = new Map<string, { n: number; ok: number }>();
    for (const c of CONVENTIONS) agree.set(conventionName(c), { n: 0, ok: 0 });

    for (const o of model.objects) {
      const n = o.tris.length / 3;
      tris += n;
      const trees: (PaintNode | null)[] = o.paints.map((p) => (p ? parsePaintTree(p, model.paintDialect) : null));
      const key = (vi: number) => `${o.vertices[vi * 3]},${o.vertices[vi * 3 + 1]},${o.vertices[vi * 3 + 2]}`;
      const corner = (t: number, k: number) => key(o.tris[t * 3 + k]);
      for (const tree of trees) {
        if (!tree || !("children" in tree)) continue;
        splitTris++;
        for (const l of leaves(tree, PRUSA)) { leafCount++; if (l.depth > maxDepth) maxDepth = l.depth; }
        (function hist(nd: PaintNode) { if ("children" in nd) { sidesHist[nd.splitSides]++; nd.children.forEach(hist); } })(tree);
      }
      // Edge map by welded corner positions.
      const edges = new Map<string, number[]>();
      for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
          const a = corner(t, k), b = corner(t, (k + 1) % 3);
          const ek = a < b ? `${a}|${b}` : `${b}|${a}`;
          let list = edges.get(ek);
          if (!list) edges.set(ek, (list = []));
          list.push(t);
        }
      }
      const baryOf = (t: number, aKey: string, bKey: string, s: number): Bary => {
        const p: Bary = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const ck = corner(t, k);
          if (ck === aKey) p[k] = 1 - s;
          else if (ck === bKey) p[k] = s;
        }
        return p;
      };
      for (const [ek, list] of edges) {
        if (list.length !== 2) continue;
        const [t, u] = list;
        const tt = trees[t], tu = trees[u];
        const splitT = !!tt && "children" in tt, splitU = !!tu && "children" in tu;
        if (!splitT && !splitU) continue;
        const [aKey, bKey] = ek.split("|");
        for (const c of CONVENTIONS) {
          const tally = agree.get(conventionName(c))!;
          const st: number[] = [], su: number[] = [];
          for (let i = 0; i < SAMPLES; i++) {
            const s = (i + 0.5) / SAMPLES;
            st.push(tt ? stateAt(tt, baryOf(t, aKey, bKey, s), c) : 0);
            su.push(tu ? stateAt(tu, baryOf(u, aKey, bKey, s), c) : 0);
          }
          // Only samples where some side varies along the edge tell conventions apart.
          const varies = new Set(st).size > 1 || new Set(su).size > 1;
          if (!varies) continue;
          for (let i = 0; i < SAMPLES; i++) { tally.n++; if (st[i] === su[i]) tally.ok++; }
        }
      }
    }
    console.log(`\n${basename(path)}: ${tris} tris, ${splitTris} split (${((splitTris / tris) * 100).toFixed(1)}%), ${leafCount} leaves, max depth ${maxDepth}, split nodes by sides 1/2/3: ${sidesHist.slice(1).join("/")}`);
    for (const [name, { n, ok }] of agree) console.log(`  ${name}: ${n ? ((ok / n) * 100).toFixed(1) : "-"}% of ${n} informative samples agree`);
  }
}, 600_000);
