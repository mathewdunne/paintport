import { describe, expect, it } from "vitest";
import { cubeMesh, leaf, makeModel } from "../../../test/support/docFixtures";
import { defaultSpools, type MappingPin } from "@/doc/mapping";
import { createProject, type Project } from "@/doc/project";
import { defaultExportSettings } from "@/persist/exportSettings";
import { patchSpool, printerCountOf, swapPinSlots, swapSpoolSlots, swapSpools } from "./spoolOps";

const spool = (slot: number): MappingPin => ({ kind: "spool", slot });
const blend = (...parts: [number, number][]): MappingPin => ({ kind: "blend", components: parts.map(([slot, ratio]) => ({ slot, ratio })) });

/** Palette: 1 red (base), 2 green, 3 blue, each painted on one triangle. */
function project(): Project {
  return createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }, { color: "#00FF00" }, { color: "#0000FF" }], paints: [leaf(2), leaf(3)] }));
}

describe("patchSpool", () => {
  it("changes one spool, normalizes the color and keeps the rest", () => {
    const spools = defaultSpools();
    const next = patchSpool(spools, 2, { color: "#abc" });
    expect(next[1]).toEqual({ slot: 2, color: "#AABBCC", on: true });
    expect(next[0]).toBe(spools[0]);
    expect(spools[1].color).toBe("#000000");
  });

  it("returns the same array when nothing changes", () => {
    const spools = defaultSpools();
    expect(patchSpool(spools, 1, { on: true, color: spools[0].color })).toBe(spools);
    expect(patchSpool(spools, 99, { on: false })).toBe(spools);
  });
});

describe("swapSpools", () => {
  it("exchanges color and on/off, not the slot numbers", () => {
    const spools = patchSpool(defaultSpools(), 3, { on: false });
    const next = swapSpools(spools, 2, 3);
    expect(next[1]).toEqual({ slot: 2, color: "#00FFFF", on: false });
    expect(next[2]).toEqual({ slot: 3, color: "#000000", on: true });
    expect(next.map((s) => s.slot)).toEqual(spools.map((s) => s.slot));
  });

  it("ignores a slot that does not exist or a swap with itself", () => {
    const spools = defaultSpools();
    expect(swapSpools(spools, 1, 1)).toBe(spools);
    expect(swapSpools(spools, 1, 17)).toBe(spools);
  });
});

describe("swapPinSlots", () => {
  it("moves a spool pin with its spool", () => {
    expect(swapPinSlots(spool(2), 2, 3)).toEqual(spool(3));
    expect(swapPinSlots(spool(3), 2, 3)).toEqual(spool(2));
  });

  it("leaves a pin on another slot alone (the same object)", () => {
    const pin = spool(5);
    expect(swapPinSlots(pin, 2, 3)).toBe(pin);
    const mix = blend([1, 1], [4, 3]);
    expect(swapPinSlots(mix, 2, 3)).toBe(mix);
  });

  it("keeps a blend's components sorted by slot, each ratio staying with its spool", () => {
    expect(swapPinSlots(blend([1, 1], [2, 3]), 2, 3)).toEqual(blend([1, 1], [3, 3]));
    expect(swapPinSlots(blend([2, 1], [3, 3]), 2, 3)).toEqual(blend([2, 3], [3, 1]));
    expect(swapPinSlots(blend([1, 3], [2, 1]), 1, 6)).toEqual(blend([2, 1], [6, 3]));
    expect(swapPinSlots(blend([1, 1], [2, 3], [4, 1]), 1, 4)).toEqual(blend([1, 1], [2, 3], [4, 1]));
  });
});

describe("swapSpoolSlots", () => {
  it("swaps the spools and the project's pins follow them", () => {
    const p = project();
    p.setPin(1, spool(2));
    p.setPin(2, blend([1, 1], [3, 3]));
    p.setPin(3, spool(5));
    const settings = defaultExportSettings();
    const next = swapSpoolSlots(p, settings, 2, 3);
    expect(next.spools[1].color).toBe(settings.spools[2].color);
    expect(next.spools[2].color).toBe(settings.spools[1].color);
    expect(settings.spools[1].color).toBe("#000000"); // the input is not touched
    expect(p.mapping.get(1)).toEqual(spool(3));
    expect(p.mapping.get(2)).toEqual(blend([1, 1], [2, 3]));
    expect(p.mapping.get(3)).toEqual(spool(5));
  });

  it("emits one mapping event per pin that moved, and none for the others", () => {
    const p = project();
    p.setPin(1, spool(2));
    p.setPin(3, spool(5));
    let events = 0;
    p.subscribe((e) => { if (e.kind === "mapping") events++; });
    swapSpoolSlots(p, defaultExportSettings(), 2, 3);
    expect(events).toBe(1);
  });

  it("works without a project and does nothing for a swap that is not possible", () => {
    const settings = defaultExportSettings();
    expect(swapSpoolSlots(null, settings, 1, 2).spools[0].color).toBe(settings.spools[1].color);
    expect(swapSpoolSlots(project(), settings, 3, 3)).toBe(settings);
  });
});

describe("printerCountOf", () => {
  it("is the extruder count of the chosen target", () => {
    const s = defaultExportSettings();
    expect(printerCountOf(s)).toBe(8);
    expect(printerCountOf({ ...s, target: "snapmaker" })).toBe(4);
    expect(printerCountOf({ ...s, target: "bambu" })).toBe(16);
  });
});
