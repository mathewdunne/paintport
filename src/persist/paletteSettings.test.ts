import { describe, expect, it } from "vitest";
import type { PalettePrint } from "../doc/palettePrint";
import { loadPalettePrint, PALETTE_KEY, savePalettePrint, type PaletteStorage } from "./paletteSettings";

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

describe("palette settings", () => {
  it("round-trips a palette and removes it", () => {
    const storage = memoryStorage();
    expect(loadPalettePrint(storage)).toBeNull();
    expect(savePalettePrint(palette, storage)).toBe(true);
    expect(loadPalettePrint(storage)).toEqual(palette);
    expect(savePalettePrint(null, storage)).toBe(true);
    expect(storage.data.has(PALETTE_KEY)).toBe(false);
    expect(loadPalettePrint(storage)).toBeNull();
  });

  it("ignores a stored palette that is not valid, as a whole", () => {
    const storage = memoryStorage();
    const stored = (change: (o: { version: number; name: unknown; dots: Record<string, unknown>[] }) => void) => {
      const o = JSON.parse(JSON.stringify({ version: 1, ...palette }));
      change(o);
      storage.setItem(PALETTE_KEY, JSON.stringify(o));
      return loadPalettePrint(storage);
    };
    expect(stored(() => {})).toEqual(palette);
    expect(stored((o) => { o.version = 2; })).toBeNull();
    expect(stored((o) => { o.dots = []; })).toBeNull();
    expect(stored((o) => { o.name = 5; })).toBeNull();
    expect(stored((o) => { o.dots[1].color = "#0594e5"; })).toBeNull(); // not normalized
    expect(stored((o) => { o.dots[1].r = 0; })).toBeNull();
    expect(stored((o) => { o.dots[1].x = "1"; })).toBeNull();
    expect(stored((o) => { o.dots[1].backdrop = 1; })).toBeNull();
    expect(stored((o) => { o.dots[1].ingredients = []; })).toBeNull();
    expect(stored((o) => { (o.dots[1].ingredients as { weight: number }[])[0].weight = 0.85; })).toBeNull();
    expect(stored((o) => { (o.dots[1].ingredients as { weight: number }[])[0].weight = 101; })).toBeNull();
    storage.setItem(PALETTE_KEY, "{not json");
    expect(loadPalettePrint(storage)).toBeNull();
  });

  it("survives storage that throws or is missing", () => {
    const broken: PaletteStorage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("full"); },
      removeItem: () => { throw new Error("denied"); },
    };
    expect(loadPalettePrint(broken)).toBeNull();
    expect(savePalettePrint(palette, broken)).toBe(false);
    expect(savePalettePrint(null, broken)).toBe(false);
    expect(loadPalettePrint(null)).toBeNull();
    expect(savePalettePrint(palette, null)).toBe(false);
  });
});
