import { describe, expect, it } from "vitest";
import { CLASSIC_SLOTS_KEY, EXPORT_SETTINGS_KEY, type KeyValueStorage } from "@/persist/exportSettings";
import { patchSpool } from "./spoolOps";
import { createExportSettingsStore, SAVE_DELAY_MS, type SaveTimers } from "./settingsStore";

class MemoryStorage implements KeyValueStorage {
  data = new Map<string, string>();
  writes = 0;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes++; this.data.set(key, value); }
}

class FakeTimers implements SaveTimers {
  now = 0;
  private timers = new Map<number, { cb: () => void; at: number }>();
  private next = 1;
  setTimer(cb: () => void, ms: number) { const id = this.next++; this.timers.set(id, { cb, at: this.now + ms }); return id; }
  clearTimer(id: number) { this.timers.delete(id); }
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.timers]) if (t.at <= this.now) { this.timers.delete(id); t.cb(); }
  }
}

const setup = (storage = new MemoryStorage()) => {
  const timers = new FakeTimers();
  return { storage, timers, store: createExportSettingsStore(storage, timers) };
};

describe("export settings store", () => {
  it("starts from the defaults on a first run, without writing anything", () => {
    const { store, storage, timers } = setup();
    expect(store.getSnapshot().target).toBe("prusa");
    expect(store.getSnapshot().allowMix).toBe(true);
    timers.advance(10_000);
    expect(storage.writes).toBe(0);
  });

  it("loads what was saved, once", () => {
    const { store, storage, timers } = setup();
    store.update((s) => ({ ...s, target: "bambu", allowMix: false, spools: patchSpool(s.spools, 1, { color: "#123456" }) }));
    timers.advance(SAVE_DELAY_MS);
    const second = createExportSettingsStore(storage, timers);
    expect(second.getSnapshot().target).toBe("bambu");
    expect(second.getSnapshot().allowMix).toBe(false);
    expect(second.getSnapshot().spools[0].color).toBe("#123456");
    storage.data.set(EXPORT_SETTINGS_KEY, "{}"); // changes behind its back are not picked up: it loads once
    expect(second.getSnapshot().target).toBe("bambu");
  });

  it("updates the snapshot and tells the listeners at once, but writes only after the delay", () => {
    const { store, storage, timers } = setup();
    let notified = 0;
    const off = store.subscribe(() => notified++);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.update((s) => ({ ...s, printerCount: { ...s.printerCount, prusa: 5 } }));
    expect(notified).toBe(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot().printerCount.prusa).toBe(5);
    expect(storage.writes).toBe(0);
    timers.advance(SAVE_DELAY_MS - 1);
    expect(storage.writes).toBe(0);
    timers.advance(1);
    expect(storage.writes).toBe(1);
    expect(JSON.parse(storage.data.get(EXPORT_SETTINGS_KEY)!).printerCount.prusa).toBe(5);
    off();
    store.update((s) => ({ ...s, allowMix: false }));
    expect(notified).toBe(1);
  });

  it("writes once for a burst of changes (a color-picker drag), with the latest value", () => {
    const { store, storage, timers } = setup();
    for (let i = 0; i < 60; i++) {
      store.update((s) => ({ ...s, spools: patchSpool(s.spools, 1, { color: "#" + (0x100000 + i * 1000).toString(16) }) }));
      timers.advance(16); // faster than the delay
    }
    expect(storage.writes).toBe(0);
    timers.advance(SAVE_DELAY_MS);
    expect(storage.writes).toBe(1);
    expect(JSON.parse(storage.data.get(EXPORT_SETTINGS_KEY)!).spools[0].color).toBe(store.getSnapshot().spools[0].color);
  });

  it("flush writes a pending change at once, and does nothing when nothing is pending", () => {
    const { store, storage, timers } = setup();
    store.flush();
    expect(storage.writes).toBe(0);
    store.update((s) => ({ ...s, target: "snapmaker" }));
    store.flush();
    expect(storage.writes).toBe(1);
    expect(JSON.parse(storage.data.get(EXPORT_SETTINGS_KEY)!).target).toBe("snapmaker");
    timers.advance(SAVE_DELAY_MS * 2);
    store.flush();
    expect(storage.writes).toBe(1);
  });

  it("neither saves nor notifies when an update returns the same settings", () => {
    const { store, storage, timers } = setup();
    let notified = 0;
    store.subscribe(() => notified++);
    store.update((s) => s);
    store.update((s) => (patchSpool(s.spools, 1, { on: s.spools[0].on }) === s.spools ? s : { ...s }));
    store.flush();
    timers.advance(SAVE_DELAY_MS);
    expect(notified).toBe(0);
    expect(storage.writes).toBe(0);
  });

  it("keeps working when the browser refuses to store", () => {
    const refusing: KeyValueStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    const timers = new FakeTimers();
    const store = createExportSettingsStore(refusing, timers);
    store.update((s) => ({ ...s, target: "snapmaker" }));
    expect(() => timers.advance(SAVE_DELAY_MS)).not.toThrow();
    expect(store.getSnapshot().target).toBe("snapmaker");
    const none = createExportSettingsStore(null, timers);
    none.update((s) => ({ ...s, allowMix: false }));
    expect(() => none.flush()).not.toThrow();
    expect(none.getSnapshot().allowMix).toBe(false);
  });

  it("takes over the classic tool's spools once and saves them under its own key", () => {
    const storage = new MemoryStorage();
    storage.data.set(CLASSIC_SLOTS_KEY, JSON.stringify([{ c: "#112233", on: true }]));
    const store = createExportSettingsStore(storage, new FakeTimers());
    expect(store.getSnapshot().spools[0].color).toBe("#112233");
    expect(storage.data.has(EXPORT_SETTINGS_KEY)).toBe(true);
  });
});
