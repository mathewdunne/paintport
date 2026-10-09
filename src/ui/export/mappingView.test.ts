import { describe, expect, it } from "vitest";
import { cubeMesh, leaf, makeModel } from "../../../test/support/docFixtures";
import { activeSpools } from "@/doc/mapping";
import { createProject, type Project } from "@/doc/project";
import { defaultExportSettings, type ExportSettings } from "@/persist/exportSettings";
import { AUTO_VALUE, computeMapping, DORMANT_VALUE, mappingRows, pinName, pinValue, printColorTable, rowChoices, targetName } from "./mappingView";
import { patchSpool, printerCountOf } from "./spoolOps";

/** Palette: 1 red (base), 2 green, 3 blue; triangle 0 is green, 1 is blue. */
function project(): Project {
  return createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }, { color: "#00FF00" }, { color: "#0000FF" }], paints: [leaf(2), leaf(3)] }));
}

const noSpools = (s: ExportSettings): ExportSettings => ({ ...s, spools: s.spools.map((x) => ({ ...x, on: false })) });

describe("printColorTable", () => {
  it("has the color each mapped state prints as, and nothing for the rest", () => {
    const p = project();
    const model = computeMapping(p, defaultExportSettings(), [2, 3]);
    const table = printColorTable(p.palette.length, model.resolved);
    expect(table).toHaveLength(p.palette.length);
    expect(table[0]).toBeUndefined();
    expect(table[1]).toBeUndefined(); // not asked: the viewer shows the design color
    expect(table[2]).toBe(model.resolved.get(2) && (model.resolved.get(2) as { color: string }).color);
    expect(table[3]).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("follows the spools: the same design color prints as another spool after an edit", () => {
    const p = project();
    const settings = defaultExportSettings();
    const before = printColorTable(p.palette.length, computeMapping(p, settings, [2]).resolved)[2];
    // Only a pure-green spool in slot 1, mixing off: green must print as that spool.
    const edited: ExportSettings = { ...noSpools(settings), allowMix: false, spools: patchSpool(noSpools(settings).spools, 1, { color: "#00CC00", on: true }) };
    const after = printColorTable(p.palette.length, computeMapping(p, edited, [2]).resolved)[2];
    expect(after).toBe("#00CC00");
    expect(after).not.toBe(before);
  });

  it("leaves a color unmapped when no spool is on", () => {
    const p = project();
    const model = computeMapping(p, noSpools(defaultExportSettings()), [2, 3]);
    expect(model.resolved.get(2)?.kind).toBe("none");
    expect(printColorTable(p.palette.length, model.resolved).every((c) => c === undefined)).toBe(true);
  });

  it("uses a pin over Auto", () => {
    const p = project();
    p.setPin(2, { kind: "spool", slot: 2 }); // black
    const model = computeMapping(p, defaultExportSettings(), [2]);
    expect(printColorTable(p.palette.length, model.resolved)[2]).toBe("#000000");
    p.setPin(2, null);
    expect(printColorTable(p.palette.length, computeMapping(p, defaultExportSettings(), [2]).resolved)[2]).not.toBe("#000000");
  });
});

describe("mapping rows", () => {
  it("one row per used state, showing Auto unless a pin is honored", () => {
    const p = project();
    const settings = defaultExportSettings();
    p.setPin(2, { kind: "spool", slot: 4 });
    const rows = mappingRows(p, settings, computeMapping(p, settings, [1, 2, 3]));
    expect(rows.map((r) => r.state)).toEqual([1, 2, 3]);
    expect(rows[0].designColor).toBe("#FF0000");
    expect(rows[1].value).toBe(pinValue({ kind: "spool", slot: 4 }));
    expect(rows[1].resolved.source).toBe("pin");
    expect(rows[2].value).toBe(AUTO_VALUE);
  });

  it("shows Auto for a pin that cannot be honored now, and what Auto alone would give", () => {
    const p = project();
    const settings = { ...defaultExportSettings(), spools: patchSpool(defaultExportSettings().spools, 4, { on: false }) };
    p.setPin(2, { kind: "spool", slot: 4 }); // spool 4 is off
    const [row] = mappingRows(p, settings, computeMapping(p, settings, [2]));
    expect(row.resolved.source).toBe("auto");
    expect(row.auto).toEqual(row.resolved);
    expect(row.pinned).toEqual({ kind: "spool", slot: 4 });
    expect(row.dormant).toEqual({ kind: "spool", slot: 4 });
    // Not the Auto value: choosing Auto from here must fire a change that clears the pin.
    expect(row.value).toBe(DORMANT_VALUE);
    expect(row.value).not.toBe(AUTO_VALUE);
    expect(pinName(row.dormant!)).toBe("Spool 4");
  });

  it("a blend pin is dormant while ColorMix is off, and a plain Auto row has no pin", () => {
    const p = project();
    const pin = { kind: "blend", components: [{ slot: 3, ratio: 1 }, { slot: 4, ratio: 1 }] } as const;
    p.setPin(2, pin);
    const settings = { ...defaultExportSettings(), allowMix: false };
    const rows = mappingRows(p, settings, computeMapping(p, settings, [2, 3]));
    expect(rows[0].dormant).toEqual(pin);
    expect(rows[0].value).toBe(DORMANT_VALUE);
    expect(rows[1].pinned).toBeUndefined();
    expect(rows[1].dormant).toBeUndefined();
    expect(rows[1].value).toBe(AUTO_VALUE);
    const on = defaultExportSettings();
    const [row] = mappingRows(p, on, computeMapping(p, on, [2]));
    expect(row.dormant).toBeUndefined();
    expect(row.value).toBe(pinValue(pin));
  });

  it("keeps the Auto result next to a pin, so the dropdown can say what Auto means", () => {
    const p = project();
    const settings = defaultExportSettings();
    p.setPin(3, { kind: "spool", slot: 1 });
    const [row] = mappingRows(p, settings, computeMapping(p, settings, [3]));
    expect(row.resolved).toMatchObject({ kind: "spool", slot: 1, source: "pin" });
    expect(row.auto.source).toBe("auto");
    expect(targetName(row.auto)).not.toBe(targetName(row.resolved));
  });
});

describe("row choices", () => {
  const setup = () => {
    const p = project();
    const settings = defaultExportSettings();
    const [row] = mappingRows(p, settings, computeMapping(p, settings, [2]));
    const active = activeSpools(settings.spools, printerCountOf(settings));
    return { p, settings, row, active };
  };

  it("lists each active spool with its ΔE, and no blends while the dropdown is closed", () => {
    const { row, active } = setup();
    const choices = rowChoices(row, active, true, false);
    expect(choices.spools.map((o) => o.pin)).toEqual(active.map((s) => ({ kind: "spool", slot: s.slot })));
    expect(choices.spools.every((o) => o.deltaE !== undefined && o.color)).toBe(true);
    expect(choices.blends).toEqual([]);
  });

  it("adds the top blends when open, best first, each with its predicted color and ΔE", () => {
    const { row, active } = setup();
    const { blends } = rowChoices(row, active, true, true);
    expect(blends.length).toBeGreaterThan(0);
    expect(blends.length).toBeLessThanOrEqual(6);
    expect(blends.map((o) => o.deltaE!)).toEqual([...blends.map((o) => o.deltaE!)].sort((a, b) => a - b));
    expect(blends.every((o) => o.pin?.kind === "blend" && o.color)).toBe(true);
  });

  it("offers no blends when ColorMix is off", () => {
    const { row, active } = setup();
    expect(rowChoices(row, active, false, true).blends).toEqual([]);
  });

  it("lists a pinned blend that is not among the top candidates", () => {
    const { p, settings, active } = setup();
    const pin = { kind: "blend", components: [{ slot: 1, ratio: 1 }, { slot: 2, ratio: 3 }] } as const; // white + black: far from green
    p.setPin(2, pin);
    const [row] = mappingRows(p, settings, computeMapping(p, settings, [2]));
    expect(row.value).toBe(pinValue(pin));
    const { blends } = rowChoices(row, active, true, true);
    expect(blends[0].value).toBe(pinValue(pin));
    expect(blends.filter((o) => o.value === pinValue(pin))).toHaveLength(1);
  });
});
