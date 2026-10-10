import { describe, expect, it } from "vitest";
import type { PalettePrint } from "../doc/palettePrint";
import { loadPalettePrints, MAX_PALETTES, PALETTE_KEY, savePalettePrints, type PaletteStorage } from "./paletteSettings";

function memoryStorage(): PaletteStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

const palette: PalettePrint = {
  name: "FullSpectrumPallette",
  dots: [
    { name: "Base", x: 0, y: 0, r: 45, top: 1, color: "#EBF7FF", ingredients: [{ color: "#EBF7FF", weight: 1 }], backdrop: true },
    { name: "7 B-R 85-15", x: 12.3, y: -33.8, r: 4.5, top: 9, color: "#0594E5", ingredients: [{ color: "#08ABFB", weight: 85 }, { color: "#D93B90", weight: 15 }], backdrop: false },
  ],
};

const other: PalettePrint = { name: "Black mix", dots: [palette.dots[1]] };

describe("palette settings", () => {
  it("round-trips palettes in order and removes them", () => {
    const storage = memoryStorage();
    expect(loadPalettePrints(storage)).toEqual([]);
    expect(savePalettePrints([palette, other], storage)).toBe(true);
    expect(loadPalettePrints(storage)).toEqual([palette, other]);
    expect(savePalettePrints([], storage)).toBe(true);
    expect(storage.data.has(PALETTE_KEY)).toBe(false);
    expect(loadPalettePrints(storage)).toEqual([]);
  });

  it("reads a version 1 record (one palette) as a list of one", () => {
    const storage = memoryStorage();
    storage.setItem(PALETTE_KEY, JSON.stringify({ version: 1, ...palette }));
    expect(loadPalettePrints(storage)).toEqual([palette]);
    storage.setItem(PALETTE_KEY, JSON.stringify({ version: 1, ...palette, dots: [] }));
    expect(loadPalettePrints(storage)).toEqual([]);
  });

  it("drops a stored palette that is not valid, as a whole, and keeps the others", () => {
    const storage = memoryStorage();
    const stored = (change: (o: { version: number; name: unknown; dots: Record<string, unknown>[] }) => void) => {
      const o = JSON.parse(JSON.stringify(palette));
      change(o);
      storage.setItem(PALETTE_KEY, JSON.stringify({ version: 2, palettes: [o, other] }));
      return loadPalettePrints(storage);
    };
    expect(stored(() => {})).toEqual([palette, other]);
    expect(stored((o) => { o.dots = []; })).toEqual([other]);
    expect(stored((o) => { o.name = 5; })).toEqual([other]);
    expect(stored((o) => { o.name = "x".repeat(201); })).toEqual([other]);
    expect(stored((o) => { o.dots[1].color = "#0594e5"; })).toEqual([other]); // not normalized
    expect(stored((o) => { o.dots[1].r = 0; })).toEqual([other]);
    expect(stored((o) => { o.dots[1].x = "1"; })).toEqual([other]);
    expect(stored((o) => { o.dots[1].backdrop = 1; })).toEqual([other]);
    expect(stored((o) => { o.dots[1].ingredients = []; })).toEqual([other]);
    expect(stored((o) => { (o.dots[1].ingredients as { weight: number }[])[0].weight = 0.85; })).toEqual([other]);
    expect(stored((o) => { (o.dots[1].ingredients as { weight: number }[])[0].weight = 101; })).toEqual([other]);
    storage.setItem(PALETTE_KEY, JSON.stringify({ version: 3, palettes: [palette] }));
    expect(loadPalettePrints(storage)).toEqual([]);
    storage.setItem(PALETTE_KEY, JSON.stringify({ version: 2, palettes: {} }));
    expect(loadPalettePrints(storage)).toEqual([]);
    storage.setItem(PALETTE_KEY, "{not json");
    expect(loadPalettePrints(storage)).toEqual([]);
  });

  it("reads at most MAX_PALETTES palettes", () => {
    const storage = memoryStorage();
    storage.setItem(PALETTE_KEY, JSON.stringify({ version: 2, palettes: Array.from({ length: MAX_PALETTES + 3 }, () => other) }));
    expect(loadPalettePrints(storage)).toHaveLength(MAX_PALETTES);
  });

  it("survives storage that throws or is missing", () => {
    const broken: PaletteStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("full"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(loadPalettePrints(broken)).toEqual([]);
    expect(savePalettePrints([palette], broken)).toBe(false);
    expect(savePalettePrints([], broken)).toBe(false);
    expect(loadPalettePrints(null)).toEqual([]);
    expect(savePalettePrints([palette], null)).toBe(false);
  });
});
