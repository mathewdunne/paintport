// Phase 5: fill cost on a real file with many split triangles (goldfish: 77k trees, 2.4M pieces).
//   SPIKE_FILES="D:/Downloads/goldfish_colormix_4t.3mf" npx vitest run --config spike/subtri/vitest.config.ts --disableConsoleIntercept fillPerf
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { importProject } from "../../src/doc/importProject";

const file = (process.env.SPIKE_FILES ?? "").split(";").filter(Boolean)[0];

it.skipIf(!file)("smart fill timings", async () => {
  const bytes = readFileSync(file);
  const { project } = await importProject("goldfish.3mf", new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const t0 = performance.now();
  project.topology(0);
  console.log(`topology ${(performance.now() - t0).toFixed(0)} ms`);
  const scale = project.autoFeatureScale(0);
  const trees = (project.fields[0] as { trees?: () => ReadonlyMap<number, string> }).trees?.();
  const split = trees ? Array.from(trees.keys()) : [];
  const seeds = [1000, 500000, 1200000, ...split.slice(0, 3), ...split.slice(5000, 5003)];
  for (const s of [0, scale]) {
    for (const seed of seeds) {
      const t = performance.now();
      const r = project.smartFillRegion(0, seed, 20, s) as unknown as { tris?: Uint32Array; length?: number; pieces?: Map<number, Uint32Array> };
      const size = r.tris ? r.tris.length : r.length;
      console.log(`scale ${s.toFixed(3)} seed ${seed}${trees?.has(seed) ? " (split)" : ""}: ${(performance.now() - t).toFixed(0)} ms, ${size} tris, ${r.pieces?.size ?? 0} split`);
    }
  }
}, 600_000);
