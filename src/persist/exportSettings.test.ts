import { describe, expect, it } from "vitest";
import {
  CLASSIC_PRINTER_N_KEY, CLASSIC_SLOTS_KEY, defaultExportSettings, EXPORT_SETTINGS_KEY, loadExportSettings, saveExportSettings,
  type KeyValueStorage,
} from "./exportSettings";

/** In-memory storage that records writes; `broken` makes every call throw like a blocked localStorage. */
function memory(initial: Record<string, string> = {}, broken = false) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  const storage: KeyValueStorage = {
    getItem(k) {
      if (broken) throw new Error("denied");
      return data.get(k) ?? null;
    },
    setItem(k, v) {
      if (broken) throw new Error("denied");
      writes.push(k);
      data.set(k, v);
    },
  };
  return { storage, data, writes };
}

const stored = (m: ReturnType<typeof memory>) => JSON.parse(m.data.get(EXPORT_SETTINGS_KEY)!);

describe("defaults", () => {
  it("match the classic tool", () => {
    const d = defaultExportSettings();
    expect(d.target).toBe("prusa");
    expect(d.printerCount).toEqual({ prusa: 8, bambu: 16, snapmaker: 4 });
    expect(d.allowMix).toBe(true);
    expect(d.spools).toHaveLength(16);
    expect(d.spools.filter((s) => s.on).map((s) => s.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(d.spools[0]).toEqual({ slot: 1, color: "#FFFFFF", on: true });
  });

  it("are returned without touching storage when nothing is stored", () => {
    const m = memory();
    expect(loadExportSettings(m.storage)).toEqual(defaultExportSettings());
    expect(m.writes).toEqual([]);
  });

  it("are independent copies", () => {
    const a = defaultExportSettings();
    a.spools[0].color = "#123456";
    a.printerCount.prusa = 3;
    expect(defaultExportSettings().spools[0].color).toBe("#FFFFFF");
    expect(defaultExportSettings().printerCount.prusa).toBe(8);
  });
});

describe("save and load", () => {
  it("round-trips every setting", () => {
    const m = memory();
    const s = defaultExportSettings();
    s.target = "snapmaker";
    s.printerCount = { prusa: 6, bambu: 12, snapmaker: 4 };
    s.allowMix = false;
    s.spools[2] = { slot: 3, color: "#12AB34", on: false };
    s.spools[15] = { slot: 16, color: "#FEDCBA", on: true };
    expect(saveExportSettings(s, m.storage)).toBe(true);
    expect(loadExportSettings(m.storage)).toEqual(s);
    expect(m.writes).toEqual([EXPORT_SETTINGS_KEY]);
  });

  it("stores plain JSON under the new key, with normalized colors and slots by position", () => {
    const m = memory();
    const s = defaultExportSettings();
    s.spools[0].color = "#abc";
    saveExportSettings(s, m.storage);
    const o = stored(m);
    expect(o.spools).toHaveLength(16);
    expect(o.spools[0]).toEqual({ color: "#AABBCC", on: true });
    expect(o).toMatchObject({ version: 1, target: "prusa", allowMix: true });
  });

  it("reports a refused write", () => {
    expect(saveExportSettings(defaultExportSettings(), memory({}, true).storage)).toBe(false);
    expect(saveExportSettings(defaultExportSettings(), null)).toBe(false);
  });

  it("falls back to defaults when storage is unavailable", () => {
    expect(loadExportSettings(memory({}, true).storage)).toEqual(defaultExportSettings());
    expect(loadExportSettings(null)).toEqual(defaultExportSettings());
  });
});

describe("corrupt or odd stored data", () => {
  const load = (value: string) => loadExportSettings(memory({ [EXPORT_SETTINGS_KEY]: value }).storage);

  it("falls back to defaults for text that is not JSON or not an object", () => {
    for (const bad of ["", "{", "not json", "null", "42", "[1,2]", '"x"']) expect(load(bad), bad).toEqual(defaultExportSettings());
  });

  it("does not take over the classic keys when the new key exists but is damaged", () => {
    const m = memory({ [EXPORT_SETTINGS_KEY]: "{", [CLASSIC_PRINTER_N_KEY]: JSON.stringify({ prusa: 3 }) });
    expect(loadExportSettings(m.storage).printerCount.prusa).toBe(8);
    expect(m.writes).toEqual([]);
  });

  it("clamps printer counts to 1..16 and ignores values that are not numbers", () => {
    const s = load(JSON.stringify({ printerCount: { prusa: 99, bambu: -5, snapmaker: "3" } }));
    expect(s.printerCount).toEqual({ prusa: 16, bambu: 1, snapmaker: 4 });
    expect(load(JSON.stringify({ printerCount: { prusa: 5.9, bambu: 0, snapmaker: null } })).printerCount).toEqual({ prusa: 5, bambu: 1, snapmaker: 4 });
    expect(load(JSON.stringify({ printerCount: { prusa: 1e9, bambu: Infinity } })).printerCount).toEqual({ prusa: 16, bambu: 16, snapmaker: 4 });
    expect(load(JSON.stringify({ printerCount: [3, 4] })).printerCount).toEqual({ prusa: 8, bambu: 16, snapmaker: 4 });
  });

  it("runs colors through normalizeHex and keeps the default for fields of the wrong type", () => {
    const s = load(JSON.stringify({
      target: "bambu", allowMix: "yes",
      spools: [{ color: "f00", on: false }, { color: 5, on: "yes" }, null, "x", { color: "<script>", on: true }, { color: "#00ff00" }],
    }));
    expect(s.target).toBe("bambu");
    expect(s.allowMix).toBe(true);
    expect(s.spools[0]).toEqual({ slot: 1, color: "#FF0000", on: false });
    expect(s.spools[1]).toEqual({ slot: 2, color: "#000000", on: true }); // both fields defaulted
    expect(s.spools[2]).toEqual({ slot: 3, color: "#00FFFF", on: true });
    expect(s.spools[3]).toEqual({ slot: 4, color: "#FF00FF", on: true });
    expect(s.spools[4]).toEqual({ slot: 5, color: "#808080", on: true }); // unparseable -> normalizeHex' gray
    expect(s.spools[5]).toEqual({ slot: 6, color: "#00FF00", on: false });
  });

  it("ignores an unknown target and keeps always exactly 16 spools", () => {
    expect(load(JSON.stringify({ target: "cura" })).target).toBe("prusa");
    const many = load(JSON.stringify({ spools: Array.from({ length: 40 }, () => ({ color: "#010101", on: true })) }));
    expect(many.spools).toHaveLength(16);
    expect(many.spools.every((s) => s.color === "#010101")).toBe(true);
    expect(load(JSON.stringify({ spools: [] })).spools).toEqual(defaultExportSettings().spools);
    expect(load(JSON.stringify({ spools: "all" })).spools).toEqual(defaultExportSettings().spools);
  });
});

describe("seeding from the classic tool", () => {
  const classicSlots = JSON.stringify(Array.from({ length: 16 }, (_, i) => ({ c: i === 0 ? "#123456" : "#00ff00", on: i < 3 })));

  it("takes over spools and printer counts when the new key is absent, and saves them once", () => {
    const m = memory({ [CLASSIC_SLOTS_KEY]: classicSlots, [CLASSIC_PRINTER_N_KEY]: JSON.stringify({ prusa: 6, bambu: 12 }) });
    const s = loadExportSettings(m.storage);
    expect(s.spools[0]).toEqual({ slot: 1, color: "#123456", on: true });
    expect(s.spools[1]).toEqual({ slot: 2, color: "#00FF00", on: true });
    expect(s.spools[3].on).toBe(false);
    expect(s.printerCount).toEqual({ prusa: 6, bambu: 12, snapmaker: 4 });
    expect(s.target).toBe("prusa");
    expect(s.allowMix).toBe(true);
    expect(m.writes).toEqual([EXPORT_SETTINGS_KEY]); // the classic keys are only read
    expect(m.data.get(CLASSIC_SLOTS_KEY)).toBe(classicSlots);

    // Seeded once: later changes in the classic tool no longer matter.
    m.data.set(CLASSIC_PRINTER_N_KEY, JSON.stringify({ prusa: 2 }));
    expect(loadExportSettings(m.storage).printerCount.prusa).toBe(6);
  });

  it("seeds from either key alone", () => {
    expect(loadExportSettings(memory({ [CLASSIC_PRINTER_N_KEY]: JSON.stringify({ snapmaker: 2 }) }).storage).printerCount.snapmaker).toBe(2);
    const onlySlots = loadExportSettings(memory({ [CLASSIC_SLOTS_KEY]: classicSlots }).storage);
    expect(onlySlots.spools[0].color).toBe("#123456");
    expect(onlySlots.printerCount).toEqual(defaultExportSettings().printerCount);
  });

  it("applies the same validation to the classic values", () => {
    const m = memory({
      [CLASSIC_SLOTS_KEY]: JSON.stringify([{ c: "zzz", on: true }, { c: 7, on: 1 }, { c: "#ABC" }]),
      [CLASSIC_PRINTER_N_KEY]: JSON.stringify({ prusa: 100, bambu: "x" }),
    });
    const s = loadExportSettings(m.storage);
    expect(s.spools[0].color).toBe("#808080");
    expect(s.spools[1]).toEqual({ slot: 2, color: "#000000", on: true });
    expect(s.spools[2]).toEqual({ slot: 3, color: "#AABBCC", on: true });
    expect(s.printerCount).toEqual({ prusa: 16, bambu: 16, snapmaker: 4 });
  });

  it("falls back to defaults, without saving, when the classic keys are junk or absent", () => {
    for (const junk of ["{", "7", "null"]) {
      const m = memory({ [CLASSIC_SLOTS_KEY]: junk, [CLASSIC_PRINTER_N_KEY]: junk });
      expect(loadExportSettings(m.storage), junk).toEqual(defaultExportSettings());
    }
    const none = memory();
    loadExportSettings(none.storage);
    expect(none.writes).toEqual([]);
  });

  it("still returns the seeded settings when the write is refused", () => {
    const m = memory({ [CLASSIC_PRINTER_N_KEY]: JSON.stringify({ prusa: 5 }) });
    const guarded: KeyValueStorage = { getItem: (k) => m.storage.getItem(k), setItem: () => { throw new Error("quota"); } };
    expect(loadExportSettings(guarded).printerCount.prusa).toBe(5);
  });
});
