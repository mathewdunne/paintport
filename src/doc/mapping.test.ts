import { describe, expect, it } from "vitest";
import { bestMix, deltaE, normalizeHex, predictMix, topMixes } from "../core";
import { cubeMesh, leaf, makeModel, split3, tree } from "../../test/support/docFixtures";
import { loadClassicUi } from "../../test/support/classicUi";
import { makeRng } from "../../test/support/prng";
import {
  activeSpools, applyFileSpools, applyPreset, bestOption, blendCandidates, colorModeSuffix, DEFAULT_SPOOL_COLORS, defaultSpools,
  EXPORT_TARGETS, fileSpools, fileSpoolsDiffer, mappingWarnings, resolveMapping, SPOOL_PRESETS, usedStates,
  type MappingSettings, type Spool,
} from "./mapping";
import type { MappingPin } from "./pins";
import { createProject, type Project } from "./project";

const SEED = Number(process.env.PARITY_SEED ?? 20260926);
const classic = loadClassicUi();

const randomColor = (rng: ReturnType<typeof makeRng>) => "#" + rng.int(0, 0xffffff).toString(16).padStart(6, "0").toUpperCase();

describe("tables ported from the classic tool", () => {
  it("export targets match TARGETS", () => {
    expect(Object.keys(EXPORT_TARGETS).sort()).toEqual(Object.keys(classic.TARGETS).sort());
    for (const [id, c] of Object.entries(classic.TARGETS)) {
      const t = EXPORT_TARGETS[id as keyof typeof EXPORT_TARGETS];
      expect({ flavor: t.flavor, suffix: t.suffix, printerN: t.defaultPrinterCount, mix: true, bbsApp: t.bbsApp, mixFormat: t.mixFormat })
        .toEqual({ flavor: c.flavor, suffix: c.suffix, printerN: c.printerN, mix: c.mix, bbsApp: c.bbsApp, mixFormat: c.mixFormat });
    }
  });

  it("presets and default colors match PRESETS and DEFAULT_SLOTS", () => {
    expect(SPOOL_PRESETS.map((p) => ({ id: p.id, colors: p.colors }))).toEqual(classic.PRESETS.map((p) => ({ id: p.id, colors: p.colors })));
    expect(DEFAULT_SPOOL_COLORS).toEqual(classic.DEFAULT_SLOTS);
  });

  it("defaults to 16 spools with slots 1..5 on", () => {
    const spools = defaultSpools();
    expect(spools).toHaveLength(16);
    expect(spools.map((s) => s.slot)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(spools.filter((s) => s.on).map((s) => s.slot)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("bestOption", () => {
  const label = (t: ReturnType<typeof bestOption>) => (t === null ? null : t.kind === "spool" ? "p" + t.slot : "mix");

  it("agrees with the classic bestOption on random inputs", () => {
    const rng = makeRng(SEED, "bestOption");
    let blends = 0;
    for (let i = 0; i < 400; i++) {
      const n = rng.int(0, 7);
      const slots = rng.shuffle(Array.from({ length: 16 }, (_, k) => k + 1)).slice(0, n).sort((a, b) => a - b);
      const pool = Array.from({ length: 4 }, () => randomColor(rng));
      // Reusing colors makes exact ties between a blend and a spool likely.
      const active = slots.map((slot) => ({ slot, color: rng.bool(0.3) ? rng.pick(pool) : randomColor(rng) }));
      const color = rng.bool(0.3) ? rng.pick(pool) : randomColor(rng);
      const allowMix = rng.bool(0.7);
      const expected = classic.bestOption({ color }, active, allowMix);
      const actual = bestOption(color, active, allowMix);
      expect(label(actual), `case ${i}: ${color} ${JSON.stringify(active)} mix=${allowMix}`).toBe(expected);
      if (expected === "mix") {
        blends++;
        const mix = bestMix(color, active)!;
        expect(actual).toMatchObject({ kind: "blend", color: mix.predicted, deltaE: mix.deltaE });
      }
    }
    expect(blends).toBeGreaterThan(10); // the comparison really covered the blend branch
  });

  it("keeps the spool on an exact tie", () => {
    // Two identical spools: their blend predicts the same color, so its ΔE equals the spool's.
    const active = [{ slot: 2, color: "#336699" }, { slot: 5, color: "#336699" }];
    expect(bestOption("#FFFFFF", active, true)).toMatchObject({ kind: "spool", slot: 2 });
  });

  it("needs two active spools for a blend and returns null without spools", () => {
    expect(bestOption("#123456", [], true)).toBeNull();
    expect(bestOption("#123456", [{ slot: 3, color: "#000000" }], true)).toMatchObject({ kind: "spool", slot: 3 });
  });

  it("prefers a blend that beats the nearest spool, and never one when ColorMix is off", () => {
    const cmy = [{ slot: 1, color: "#00FFFF" }, { slot: 2, color: "#FF00FF" }, { slot: 3, color: "#FFFF00" }];
    const purple = "#8000FF";
    expect(bestOption(purple, cmy, true)?.kind).toBe("blend");
    expect(bestOption(purple, cmy, false)?.kind).toBe("spool");
  });

  it("reports the ΔE of the choice", () => {
    const t = bestOption("#FF0000", [{ slot: 1, color: "#FE0000" }, { slot: 2, color: "#0000FF" }], false)!;
    expect(t.deltaE).toBeCloseTo(deltaE("#FF0000", "#FE0000"), 10);
  });

  it("blendCandidates is topMixes", () => {
    const cmy = [{ slot: 1, color: "#00FFFF" }, { slot: 2, color: "#FF00FF" }, { slot: 3, color: "#FFFF00" }];
    expect(blendCandidates("#8000FF", cmy)).toEqual(topMixes("#8000FF", cmy, 6));
    expect(blendCandidates("#8000FF", cmy, 2)).toHaveLength(2);
    expect(blendCandidates("#8000FF", [cmy[0]])).toEqual([]);
  });
});

describe("activeSpools", () => {
  it("keeps spools that are on and within the printer's extruder count, by slot, with normalized colors", () => {
    const spools: Spool[] = [
      { slot: 3, color: "#abc", on: true },
      { slot: 1, color: "#ff0000", on: true },
      { slot: 2, color: "#00ff00", on: false },
      { slot: 9, color: "#0000ff", on: true },
    ];
    expect(activeSpools(spools, 8)).toEqual([{ slot: 1, color: "#FF0000" }, { slot: 3, color: "#AABBCC" }]);
    expect(activeSpools(spools, 9).map((s) => s.slot)).toEqual([1, 3, 9]);
    expect(activeSpools(spools, 1).map((s) => s.slot)).toEqual([1]);
  });
});

describe("colorModeSuffix", () => {
  const classicSuffix = (spools: Spool[], n: number) => classic.colorModeSuffix(spools.map((s) => ({ color: s.color, on: s.on })), n);

  it("names a preset when the spools are exactly that preset, else the active count", () => {
    for (const preset of SPOOL_PRESETS) {
      const spools = applyPreset(defaultSpools(), preset, 16).spools;
      expect(colorModeSuffix(spools, 16)).toBe("_" + preset.id);
    }
    expect(colorModeSuffix(defaultSpools(), 8)).toBe("_5T");
    const cmyk = applyPreset(defaultSpools(), SPOOL_PRESETS[2], 8).spools;
    expect(colorModeSuffix(cmyk, 8)).toBe("_CMYK");
    cmyk[2].color = "#00FFFE"; // one deviation: no preset any more
    expect(colorModeSuffix(cmyk, 8)).toBe("_4T");
  });

  it("agrees with the classic function on presets, near misses and random states", () => {
    const rng = makeRng(SEED, "colorModeSuffix");
    for (let i = 0; i < 300; i++) {
      let spools = defaultSpools();
      const n = rng.int(1, 16);
      const mode = rng.int(0, 2);
      if (mode < 2) {
        spools = applyPreset(spools, rng.pick(SPOOL_PRESETS), 16).spools;
        if (mode === 1) { // flip one thing
          const s = spools[rng.int(0, 7)];
          if (rng.bool()) s.on = !s.on; else s.color = randomColor(rng);
        }
      } else {
        spools.forEach((s) => { s.on = rng.bool(); if (rng.bool(0.3)) s.color = randomColor(rng); });
      }
      expect(colorModeSuffix(spools, n), `case ${i} n=${n}`).toBe(classicSuffix(spools, n));
    }
  });

  it("ignores spools above the printer's extruder count", () => {
    const spools = applyPreset(defaultSpools(), SPOOL_PRESETS[2], 16).spools;
    spools[10].on = true; // slot 11 is on but the printer has 8
    expect(colorModeSuffix(spools, 8)).toBe("_CMYK");
    expect(colorModeSuffix(spools, 16)).toBe("_5T");
  });

  it("does not match a preset that needs more slots than the printer has", () => {
    const spools = applyPreset(defaultSpools(), SPOOL_PRESETS[5], 16).spools; // PANCHROMA needs 4
    expect(colorModeSuffix(spools, 3)).toBe(classicSuffix(spools, 3));
    expect(colorModeSuffix(spools, 3)).toBe("_3T");
    expect(colorModeSuffix(spools, 4)).toBe("_PANCHROMA");
  });
});

describe("presets and file spools", () => {
  it("applyPreset switches slots 1..n on with the preset colors and the rest off, leaving slots beyond n alone", () => {
    const base = defaultSpools();
    base[9].on = true;
    const out = applyPreset(base, SPOOL_PRESETS[0], 8).spools;
    expect(out.slice(0, 8).map((s) => s.on)).toEqual([true, true, true, false, false, false, false, false]);
    expect(out.slice(0, 3).map((s) => s.color)).toEqual(["#00FFFF", "#FF00FF", "#FFFF00"]);
    expect(out[3].color).toBe(base[3].color); // off slots keep their color
    expect(out[9]).toEqual(base[9]);
    expect(base[0].color).toBe(DEFAULT_SPOOL_COLORS[0]); // input untouched
  });

  it("a preset longer than the printer is cut at the printer's slots", () => {
    const base = defaultSpools().map((s) => ({ ...s, on: false }));
    const { spools: out, truncated } = applyPreset(base, SPOOL_PRESETS[4], 4);
    expect(truncated).toBe(true);
    expect(applyPreset(base, SPOOL_PRESETS[4], 8).truncated).toBe(false);
    expect(out.filter((s) => s.on).map((s) => s.slot)).toEqual([1, 2, 3, 4]);
    expect(out[4]).toEqual(base[4]);
  });

  const source = {
    filaments: [
      { index: 1, color: "#ff0000", colorKnown: true },
      { index: 2, color: "#00ff00", colorKnown: false }, // fallback gray: not a spool color
      { index: 3, color: "#0000ff", colorKnown: true },
      { index: 4, color: "#800080", colorKnown: true, mix: [{ extruder: 1, ratio: 1 }, { extruder: 3, ratio: 1 }] },
      { index: 20, color: "#123456", colorKnown: true },
    ].map((f) => ({ ...f, paintedTris: 0, baseTris: 0, paintedShare: 0, baseShare: 0, isDefaultOf: 0 })),
  };

  it("fileSpools lists physical extruders with known colors only", () => {
    expect(fileSpools(source)).toEqual([{ slot: 1, color: "#FF0000" }, { slot: 3, color: "#0000FF" }]);
    expect(fileSpools({ filaments: [] })).toEqual([]);
  });

  it("applyFileSpools turns those slots on with those colors and the others off", () => {
    const out = applyFileSpools(defaultSpools(), fileSpools(source), 8);
    expect(out.filter((s) => s.on).map((s) => [s.slot, s.color])).toEqual([[1, "#FF0000"], [3, "#0000FF"]]);
  });

  it("fileSpoolsDiffer tells whether applying would change anything", () => {
    const file = fileSpools(source);
    expect(fileSpoolsDiffer(defaultSpools(), file, 8)).toBe(true);
    const applied = applyFileSpools(defaultSpools(), file, 8);
    expect(fileSpoolsDiffer(applied, file, 8)).toBe(false);
    // Off slots with other colors do not count as a difference.
    applied[1].color = "#ABCDEF";
    expect(fileSpoolsDiffer(applied, file, 8)).toBe(false);
    applied[0].color = "#FF0001";
    expect(fileSpoolsDiffer(applied, file, 8)).toBe(true);
    // A file without physical colors (STL/OBJ, unknown colors) offers nothing.
    expect(fileSpoolsDiffer(defaultSpools(), [], 8)).toBe(false);
    // Spools are compared by slot, not by position in the array.
    const shuffled = applyFileSpools(defaultSpools(), file, 8).reverse();
    expect(fileSpoolsDiffer(shuffled, file, 8)).toBe(false);
    shuffled.find((x) => x.slot === 3)!.color = "#000001";
    expect(fileSpoolsDiffer(shuffled, file, 8)).toBe(true);
  });
});

/**
 * File filaments: 1 red, 2 blue, 3 a ColorMix of 1 and 2 (a hint), 4 green.
 * Design palette after import: state 1 red (base), 2 purple with the hint (painted), 3 green (painted).
 */
function hintProject(): Project {
  return createProject(makeModel(cubeMesh(), {
    filaments: [{ color: "#FF0000" }, { color: "#0000FF" }, { color: "#800080", mix: [{ extruder: 1, ratio: 1 }, { extruder: 2, ratio: 1 }] }, { color: "#00FF00" }],
    paints: [leaf(3), leaf(4)],
  }));
}

function settings(spools: Spool[] = defaultSpools(), over: Partial<MappingSettings> = {}): MappingSettings {
  return { spools, printerCount: 8, allowMix: true, ...over };
}

/** Slots 1 and 2 on with the file's red and blue, everything else off. */
function matchingSpools(): Spool[] {
  const s = defaultSpools();
  s.forEach((x) => { x.on = x.slot <= 2; });
  s[0].color = "#FF0000";
  s[1].color = "#0000FF";
  return s;
}

describe("usedStates", () => {
  // File slots: 1..6 colored, 7 only used by a negative volume. Part 1 is painted over completely.
  const model = () => makeModel(cubeMesh(), {
    filaments: ["#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF", "#888888"].map((color) => ({ color })),
    parts: [
      { firstTri: 0, triCount: 8, extruder: 1, type: "ModelPart", name: null },
      { firstTri: 8, triCount: 2, extruder: 2, type: "ModelPart", name: null },
      { firstTri: 10, triCount: 1, extruder: 4, type: "ParameterModifier", name: null },
      { firstTri: 11, triCount: 1, extruder: 7, type: "NegativeVolume", name: null },
    ],
    paints: [null, tree(split3(5, 6, 0)), null, null, null, null, null, null, leaf(3), leaf(3)],
  });

  it("covers painted states, leaves that exist only inside preserved trees, and part and modifier bases", () => {
    const p = createProject(model());
    expect(p.palette).toHaveLength(7);
    expect(usedStates(p)).toEqual([1, 2, 3, 4, 5, 6]);
    // State 6 is the tree's dominant leaf; state 5 shows up nowhere else.
    expect(Array.from(p.fields[0].displayStates()).includes(5)).toBe(false);
    // State 2 is only the base of a part that is painted over completely, yet it needs a mapping.
    expect(p.colorUsage()[2]).toEqual({ painted: 0, base: 0 });
  });

  it("drops states that nothing uses any more but keeps every base color", () => {
    const p = createProject(model());
    p.paintTriangles(0, [1, 8, 9], 0);
    expect(usedStates(p)).toEqual([1, 2, 4]);
    p.setBaseColor(0, 0, 5);
    expect(usedStates(p)).toEqual([2, 4, 5]);
  });

  it("lists the base color of an unpainted model", () => {
    const p = createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }] }));
    expect(usedStates(p)).toEqual([1]);
  });
});

describe("resolveMapping", () => {
  it("resolves Auto to the nearest spool or best blend, with its ΔE", () => {
    const p = hintProject();
    const s = settings(); // white, black, cyan, magenta, yellow
    const r = resolveMapping(p, s);
    expect([...r.keys()]).toEqual([1, 2, 3]);
    for (const [state, t] of r) {
      expect(t.source).toBe("auto");
      const expected = bestOption(p.palette[state].color, activeSpools(s.spools, 8), true)!;
      expect(t).toMatchObject({ kind: expected.kind, color: expected.color, deltaE: expected.deltaE });
    }
    // Auto follows spool edits.
    const s2 = settings(defaultSpools().map((x) => (x.slot === 1 ? { ...x, color: "#FE0000" } : x)));
    expect(resolveMapping(p, s2).get(1)).toMatchObject({ kind: "spool", slot: 1, color: "#FE0000" });
  });

  it("gives no target without active spools", () => {
    const p = hintProject();
    const s = settings(defaultSpools().map((x) => ({ ...x, on: false })));
    expect(resolveMapping(p, s).get(1)).toEqual({ kind: "none", source: "auto" });
  });

  it("only resolves the states asked for", () => {
    const p = hintProject();
    expect([...resolveMapping(p, settings(), [3]).keys()]).toEqual([3]);
  });

  describe("pins", () => {
    it("a valid spool pin wins over Auto", () => {
      const p = hintProject();
      p.setPin(1, { kind: "spool", slot: 2 }); // red -> black, although cyan or magenta fit better
      expect(resolveMapping(p, settings()).get(1)).toMatchObject({ kind: "spool", slot: 2, color: "#000000", source: "pin" });
    });

    it("a spool pin above the printer's count or on a switched-off slot is ignored", () => {
      const p = hintProject();
      const s = settings();
      p.setPin(1, { kind: "spool", slot: 9 });
      s.spools[8].on = true; // slot 9 is on, but the printer has 8 extruders
      const above = resolveMapping(p, s).get(1)!;
      expect(above.source).toBe("auto");
      expect(above).toMatchObject(bestOption(p.palette[1].color, activeSpools(s.spools, 8), true)!);
      p.setPin(1, { kind: "spool", slot: 7 }); // slot 7 is within range but off
      expect(resolveMapping(p, s).get(1)!.source).toBe("auto");
      s.spools[6].on = true;
      expect(resolveMapping(p, s).get(1)).toMatchObject({ kind: "spool", slot: 7, source: "pin" });
      expect(resolveMapping(p, { ...s, printerCount: 6 }).get(1)!.source).toBe("auto"); // 7 > 6
    });

    const blendPin: MappingPin = { kind: "blend", components: [{ slot: 3, ratio: 1 }, { slot: 4, ratio: 3 }] };

    it("a blend pin resolves with the spools' current colors and the predicted color", () => {
      const p = hintProject();
      p.setPin(1, blendPin);
      const t = resolveMapping(p, settings()).get(1)!;
      const predicted = predictMix([{ color: "#00FFFF", ratio: 1 }, { color: "#FF00FF", ratio: 3 }]);
      expect(t).toMatchObject({ kind: "blend", color: predicted, source: "pin" });
      expect(t.kind === "blend" && t.components.map((c) => [c.slot, c.ratio, c.color])).toEqual([[3, 1, "#00FFFF"], [4, 3, "#FF00FF"]]);
      expect(t.kind === "blend" && t.deltaE).toBeCloseTo(deltaE(p.palette[1].color, predicted), 10);
    });

    it("a blend pin falls back to Auto when a component is inactive or ColorMix is off", () => {
      const p = hintProject();
      p.setPin(1, blendPin);
      const off = settings();
      off.spools[3].on = false; // magenta
      expect(resolveMapping(p, off).get(1)!.source).toBe("auto");
      expect(resolveMapping(p, settings(undefined, { allowMix: false })).get(1)).toMatchObject({ kind: "spool", source: "auto" });
      expect(resolveMapping(p, settings(undefined, { printerCount: 3 })).get(1)!.source).toBe("auto"); // slot 4 does not exist
    });
  });

  describe("recipe hints", () => {
    it("resolves to the recipe when its spools are active and match the file's colors", () => {
      const p = hintProject();
      const t = resolveMapping(p, settings(matchingSpools())).get(2)!;
      expect(t).toMatchObject({ kind: "blend", source: "hint", color: predictMix([{ color: "#FF0000", ratio: 1 }, { color: "#0000FF", ratio: 1 }]) });
      expect(t.kind === "blend" && t.components.map((c) => [c.slot, c.ratio])).toEqual([[1, 1], [2, 1]]);
      expect(t.kind === "blend" && t.deltaE).toBeCloseTo(deltaE("#800080", t.kind === "blend" ? t.color : "#000000"), 10);
    });

    it("matches colors by normalized value", () => {
      const p = hintProject();
      const s = matchingSpools();
      s[0].color = "#f00";
      s[1].color = "#0000ff";
      expect(resolveMapping(p, settings(s)).get(2)!.source).toBe("hint");
    });

    it("does not apply when a component's color differs from the file's", () => {
      const p = hintProject();
      const s = matchingSpools();
      s[1].color = "#0000FE";
      expect(resolveMapping(p, settings(s)).get(2)!.source).toBe("auto");
    });

    it("does not apply when a component's spool is off or beyond the printer's count", () => {
      const p = hintProject();
      const s = matchingSpools();
      s[1].on = false;
      expect(resolveMapping(p, settings(s)).get(2)!.source).toBe("auto");
      expect(resolveMapping(p, settings(matchingSpools(), { printerCount: 1 })).get(2)!.source).toBe("auto");
    });

    it("does not apply when ColorMix is off", () => {
      const p = hintProject();
      expect(resolveMapping(p, settings(matchingSpools(), { allowMix: false })).get(2)).toMatchObject({ kind: "spool", source: "auto" });
    });

    it("does not apply once the color was edited (the project drops the stale recipe)", () => {
      const p = hintProject();
      p.setColor(2, "#810081");
      expect(p.palette[2].mix).toBeUndefined();
      expect(resolveMapping(p, settings(matchingSpools())).get(2)!.source).toBe("auto");
    });

    it("a pin wins over the hint, and Auto without a hint stays Auto", () => {
      const p = hintProject();
      p.setPin(2, { kind: "spool", slot: 1 });
      expect(resolveMapping(p, settings(matchingSpools())).get(2)).toMatchObject({ kind: "spool", slot: 1, source: "pin" });
      expect(resolveMapping(p, settings(matchingSpools())).get(1)!.source).not.toBe("hint");
    });

    it("needs a physical color the file really defines", () => {
      // Extruder 2 has no known color in this file, so a spool with the fallback gray must not match.
      const p = createProject(makeModel(cubeMesh(), {
        filaments: [{ color: "#FF0000" }, null, { color: "#800080", mix: [{ extruder: 1, ratio: 1 }, { extruder: 2, ratio: 1 }] }],
        paints: [leaf(3)],
      }));
      const s = matchingSpools();
      s[1].color = "#26A69A";
      expect(resolveMapping(p, settings(s)).get(2)!.source).toBe("auto");
    });

    it("falls back to Auto for ratios that are not integers 1..100", () => {
      for (const ratio of [0, 0.5, 1.5, 101, -1, NaN]) {
        const p = createProject(makeModel(cubeMesh(), {
          filaments: [{ color: "#FF0000" }, { color: "#0000FF" }, { color: "#800080", mix: [{ extruder: 1, ratio }, { extruder: 2, ratio: 1 }] }],
          paints: [leaf(3)],
        }));
        expect(resolveMapping(p, settings(matchingSpools())).get(2)!.source, `ratio ${ratio}`).toBe("auto");
      }
    });

    it("reduces a recipe's ratios, so 2:2 is the same blend as 1:1", () => {
      const mk = (a: number, b: number) => createProject(makeModel(cubeMesh(), {
        filaments: [{ color: "#FF0000" }, { color: "#0000FF" }, { color: "#800080", mix: [{ extruder: 1, ratio: a }, { extruder: 2, ratio: b }] }],
        paints: [leaf(3)],
      }));
      const t = resolveMapping(mk(2, 2), settings(matchingSpools())).get(2)!;
      expect(t.kind === "blend" && t.components.map((c) => c.ratio)).toEqual([1, 1]);
      expect(t).toMatchObject({ source: "hint", color: predictMix([{ color: "#FF0000", ratio: 1 }, { color: "#0000FF", ratio: 1 }]) });
      const u = resolveMapping(mk(2, 6), settings(matchingSpools())).get(2)!;
      expect(u.kind === "blend" && u.components.map((c) => c.ratio)).toEqual([1, 3]);
    });

    it("ignores a recipe with fewer than two components", () => {
      const p = createProject(makeModel(cubeMesh(), {
        filaments: [{ color: "#FF0000" }, { color: "#0000FF" }, { color: "#800080", mix: [{ extruder: 1, ratio: 2 }] }],
        paints: [leaf(3)],
      }));
      expect(resolveMapping(p, settings(matchingSpools())).get(2)!.source).toBe("auto");
    });
  });
});

describe("mappingWarnings", () => {
  const twoColors = () => createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }, { color: "#00FF00" }], paints: [leaf(2)] }));

  it("flags distinct design colors that end up as nearly the same result", () => {
    const p = twoColors();
    const s = settings(defaultSpools().map((x) => ({ ...x, on: x.slot === 1, color: x.slot === 1 ? "#FF0000" : x.color })), { allowMix: false });
    const r = resolveMapping(p, s);
    expect(deltaE("#FF0000", "#00FF00")).toBeGreaterThan(15);
    expect(mappingWarnings(p.palette, r, s, "prusa").collisions).toEqual([[1, 2]]);
    // With a spool each there is no collision.
    const s2 = settings(defaultSpools().map((x) => ({ ...x, on: x.slot <= 2, color: x.slot === 1 ? "#FF0000" : x.slot === 2 ? "#00FF00" : x.color })), { allowMix: false });
    expect(mappingWarnings(p.palette, resolveMapping(p, s2), s2, "prusa").collisions).toEqual([]);
  });

  it("does not flag similar design colors, and skips colors without a target", () => {
    const p = createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }, { color: "#FE0101" }], paints: [leaf(2)] }));
    const s = settings();
    expect(mappingWarnings(p.palette, resolveMapping(p, s), s, "prusa").collisions).toEqual([]);
    const none = settings(defaultSpools().map((x) => ({ ...x, on: false })));
    expect(mappingWarnings(p.palette, resolveMapping(p, none), none, "prusa").collisions).toEqual([]);
  });

  it("tips a real spool for poor blends only while the printer has free slots", () => {
    const p = twoColors();
    const bw = defaultSpools().map((x) => ({ ...x, on: x.slot <= 2, color: x.slot === 1 ? "#FFFFFF" : x.slot === 2 ? "#000000" : x.color }));
    p.setPin(1, { kind: "spool", slot: 1 });
    p.setPin(2, { kind: "blend", components: [{ slot: 1, ratio: 1 }, { slot: 2, ratio: 1 }] }); // green as gray: a poor match
    const s = settings(bw);
    const r = resolveMapping(p, s);
    expect(r.get(2)).toMatchObject({ kind: "blend" });
    expect((r.get(2) as { deltaE: number }).deltaE).toBeGreaterThan(40);
    expect(mappingWarnings(p.palette, r, s, "prusa").poorBlends).toEqual({ states: [2], freeSlots: 6 });
    const full = settings(bw, { printerCount: 2 });
    expect(mappingWarnings(p.palette, resolveMapping(p, full), full, "prusa").poorBlends).toBeNull();
  });

  it("warns before Bambu's 16-filament limit: highest active slot plus distinct recipes", () => {
    const p = twoColors();
    const spools = defaultSpools().map((x) => ({ ...x, on: x.slot === 15 || x.slot === 16 }));
    const recipe: MappingPin = { kind: "blend", components: [{ slot: 15, ratio: 1 }, { slot: 16, ratio: 1 }] };
    p.setPin(1, recipe);
    p.setPin(2, { kind: "spool", slot: 15 });
    const s = settings(spools, { printerCount: 16 });
    let r = resolveMapping(p, s);
    expect(mappingWarnings(p.palette, r, s, "bambu").bambuLimit).toEqual({ total: 17 });
    // The same recipe for two colors is one virtual extruder, not two; Snapmaker and Prusa have no cap.
    p.setPin(2, recipe);
    r = resolveMapping(p, s);
    expect(mappingWarnings(p.palette, r, s, "bambu").bambuLimit).toEqual({ total: 17 });
    expect(mappingWarnings(p.palette, r, s, "snapmaker").bambuLimit).toBeNull();
    expect(mappingWarnings(p.palette, r, s, "prusa").bambuLimit).toBeNull();
    // Highest slot 15 + 1 recipe = 16 is fine.
    const lower = defaultSpools().map((x) => ({ ...x, on: x.slot === 14 || x.slot === 15 }));
    p.setPin(1, { kind: "blend", components: [{ slot: 14, ratio: 1 }, { slot: 15, ratio: 1 }] });
    p.setPin(2, { kind: "spool", slot: 14 });
    const s2 = settings(lower, { printerCount: 16 });
    expect(mappingWarnings(p.palette, resolveMapping(p, s2), s2, "bambu").bambuLimit).toBeNull();
  });

  it("is quiet when nothing blends", () => {
    const p = twoColors();
    const s = settings(undefined, { allowMix: false });
    expect(mappingWarnings(p.palette, resolveMapping(p, s), s, "bambu")).toEqual({ collisions: expect.any(Array), poorBlends: null, bambuLimit: null });
  });
});

describe("normalizeHex use", () => {
  it("resolves colors case-insensitively", () => {
    const p = hintProject();
    const s = settings(defaultSpools().map((x) => (x.slot === 1 ? { ...x, color: normalizeHex("#ff0000").toLowerCase() } : x)));
    expect(resolveMapping(p, s).get(1)).toMatchObject({ kind: "spool", slot: 1, color: "#FF0000" });
  });
});
