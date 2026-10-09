// load3MF is load3MFFiles after unzipping: the same Model, or the same error, on seeded random archives.
import { describe, expect, it } from "vitest";
import { load3MF, load3MFFiles, PaintPortCore, unzipAll, zipAll } from "./index";
import { attemptAsync, firstDiff, norm } from "../../test/support/parity";
import { makeRng, PARITY_SCALE, PARITY_SEED } from "../../test/support/prng";
import { genScenario } from "../../test/support/synth";

describe("load3MFFiles", () => {
  it("returns exactly what load3MF returns", async () => {
    const rng = makeRng(PARITY_SEED, "load3MFFiles");
    let loaded = 0, failed = 0;
    for (let i = 0; i < Math.round(60 * PARITY_SCALE); i++) {
      const bytes = await zipAll(genScenario(rng, PaintPortCore).files);
      const a = await attemptAsync(() => load3MF(bytes));
      const b = await attemptAsync(async () => load3MFFiles(await unzipAll(bytes)));
      expect(firstDiff(norm(a), norm(b)), `case ${i}`).toBeNull();
      if ("ok" in a) loaded++; else failed++;
    }
    expect(loaded).toBeGreaterThan(20);
    expect(failed).toBeGreaterThan(0);
  });
});
