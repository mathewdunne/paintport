// Phase 5: where building piece data costs time, on goldfish's trees.
//   SPIKE_FILES="D:/Downloads/goldfish_colormix_4t.3mf" npx vitest run --config spike/subtri/vitest.config.ts --disableConsoleIntercept piecesPerf
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { importProject } from "../../src/doc/importProject";
import { buildPieces } from "../../src/doc/pieces";
import { parseTree, treeLeaves } from "../../src/doc/splitTree";

const file = (process.env.SPIKE_FILES ?? "").split(";").filter(Boolean)[0];

it.skipIf(!file)("piece building timings", async () => {
  const bytes = readFileSync(file);
  const { project } = await importProject("goldfish.3mf", new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const trees = Array.from(project.fields[0].trees().values()).slice(0, 15000);
  const time = (label: string, fn: () => void) => { const t = performance.now(); fn(); console.log(`${label}: ${(performance.now() - t).toFixed(0)} ms`); };
  let roots: ReturnType<typeof parseTree>[] = [];
  time(`parseTree x${trees.length}`, () => { roots = trees.map(parseTree); });
  let leaves = 0;
  time("treeLeaves", () => { for (const r of roots) leaves += treeLeaves(r).length; });
  console.log(`${leaves} leaves`);
  time("buildPieces", () => { for (const r of roots) buildPieces(r); });
  time("buildPieces again", () => { for (const r of roots) buildPieces(r); });
}, 600_000);
