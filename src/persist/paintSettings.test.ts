import { describe, expect, it } from "vitest";
import type { KeyValueStorage } from "./exportSettings";
import { defaultPaintPrefs, loadPaintPrefs, PAINT_SETTINGS_KEY, savePaintPrefs } from "./paintSettings";

function memory(initial: Record<string, string> = {}, broken = false): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(k) {
      if (broken) throw new Error("denied");
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      if (broken) throw new Error("denied");
      data.set(k, v);
    },
  };
}

describe("paint preferences", () => {
  it("default to the spec values with the feature size automatic and Advanced closed", () => {
    expect(defaultPaintPrefs()).toEqual({ radius: 3, smartAngle: 20, smartScale: null, fillAdvancedOpen: false });
    expect(loadPaintPrefs(memory())).toEqual(defaultPaintPrefs());
    expect(loadPaintPrefs(null)).toEqual(defaultPaintPrefs());
  });

  it("round-trip, including a manual feature size and the automatic one", () => {
    const m = memory();
    const manual = { radius: 1.5, smartAngle: 14.5, smartScale: 0.35, fillAdvancedOpen: true };
    expect(savePaintPrefs(manual, m)).toBe(true);
    expect(loadPaintPrefs(m)).toEqual(manual);
    savePaintPrefs({ ...manual, smartScale: null }, m);
    expect(loadPaintPrefs(m).smartScale).toBeNull();
  });

  it("keep the default of each malformed field on its own and clamp numbers", () => {
    const m = memory({ [PAINT_SETTINGS_KEY]: JSON.stringify({ radius: 500, smartAngle: "steep", smartScale: 7, fillAdvancedOpen: 1 }) });
    expect(loadPaintPrefs(m)).toEqual({ radius: 30, smartAngle: 20, smartScale: 1, fillAdvancedOpen: false });
    expect(loadPaintPrefs(memory({ [PAINT_SETTINGS_KEY]: "{not json" }))).toEqual(defaultPaintPrefs());
    expect(loadPaintPrefs(memory({ [PAINT_SETTINGS_KEY]: "[1,2]" }))).toEqual(defaultPaintPrefs());
  });

  it("survive a storage that refuses every access", () => {
    const m = memory({}, true);
    expect(loadPaintPrefs(m)).toEqual(defaultPaintPrefs());
    expect(savePaintPrefs(defaultPaintPrefs(), m)).toBe(false);
  });
});
