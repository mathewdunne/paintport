// Cost of what the Export tab and the Print view recompute, on a ~2.65M-triangle mesh.
// Opt-in: PERF=1 npx vitest run test/exportUiPerf.test.ts
import { describe, expect, it } from "vitest";
import { usedStates } from "../src/doc/mapping";
import { createProject } from "../src/doc/project";
import { parseStl } from "../src/formats/stl";
import { defaultExportSettings } from "../src/persist/exportSettings";
import { computeMapping, printColorTable } from "../src/ui/export/mappingView";
import { patchSpool } from "../src/ui/export/spoolOps";
import { SETTLE_MS, UsedStatesTracker, type TimerEnv } from "../src/ui/export/usedStates";
import { sphereStl } from "./support/fixtures";

const RINGS = 884, SEGMENTS = 1500; // 2 * 1500 * 883 = 2.649M triangles

describe.skipIf(!process.env.PERF)("2.65M-triangle export UI recompute", () => {
  it("keeps usedStates off the brush path and the mapping cheap", () => {
    const time = <T>(label: string, fn: () => T): T => {
      const t0 = performance.now();
      const r = fn();
      console.log(`${label}: ${(performance.now() - t0).toFixed(1)} ms`);
      return r;
    };
    const p = createProject(parseStl(sphereStl(RINGS, SEGMENTS), "sphere"));
    expect(p.objects[0].triCount).toBe(2 * SEGMENTS * (RINGS - 1));
    for (const hex of ["#00AA00", "#0000CC", "#DDDD00", "#AA00AA", "#00AAAA", "#884400", "#FF8800", "#FF0088", "#88FF00", "#0088FF", "#444444"]) p.addColor(hex);
    p.clearHistory();
    // Eleven bands, so twelve colors are used.
    const n = p.objects[0].triCount, band = Math.floor(n / 11);
    for (let c = 0; c < 11; c++) p.paintTriangles(0, Array.from({ length: band }, (_, i) => c * band + i), c + 2);
    p.clearHistory();

    const states = time("usedStates (one scan)", () => usedStates(p));
    expect(states.length).toBe(12);

    const settings = defaultExportSettings();
    const all16 = { ...settings, printerCount: { ...settings.printerCount, prusa: 16 }, spools: settings.spools.map((s) => ({ ...s, on: true })) };
    for (const [label, s] of [["5 spools on", settings], ["16 spools on", all16]] as const) {
      const model = time(`resolve + warnings, 12 colors, ${label}`, () => computeMapping(p, s, states));
      time(`print color table, ${label}`, () => printColorTable(p.palette.length, model.resolved));
    }
    // A color-picker drag: the spool color changes every frame.
    let spools = all16.spools;
    time("60 spool-color drag frames, 16 spools on (resolve + warnings each)", () => {
      for (let i = 0; i < 60; i++) {
        spools = patchSpool(spools, 3, { color: "#" + (0x100000 + i * 5000).toString(16).slice(-6) });
        computeMapping(p, { ...all16, spools }, states);
      }
    });

    // A brush stroke: 300 dabs, each a paint event. The tracker must scan once, not 300 times.
    let timer = 0; // 1 while a settle timer is pending
    const timers: TimerEnv = { setTimer: () => (timer = 1), clearTimer: () => { timer = 0; } };
    const tracker = new UsedStatesTracker(p, timers);
    tracker.subscribe(() => {});
    const dab = (i: number) => p.paintTriangles(0, Array.from({ length: 200 }, (_, k) => i * 200 + k), 2 + (i % 11));
    time("300 dabs while the tracker listens (no scans expected)", () => {
      p.beginStroke();
      for (let i = 0; i < 300; i++) dab(i);
    });
    expect(timer).toBe(1); // one pending settle timer, no scan yet
    time(`stroke end (the one scan, settle time ${SETTLE_MS} ms is not waited for)`, () => p.endStroke());
    expect(timer).toBe(0);
  }, 120_000);
});
