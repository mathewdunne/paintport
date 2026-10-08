import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cubeMesh, makeModel } from "../../test/support/docFixtures";
import { createProject, type Project } from "../doc/project";
import { ProjectSaver, restoreProject, toSnapshot, type GeometrySnapshot, type PaintSnapshot, type SnapshotStore } from "../doc/snapshot";
import { Autosaver, AUTOSAVE_DEBOUNCE_MS, flushAutosavers, type AutosaveEnv } from "./autosave";

function memoryStore() {
  const log: string[] = [];
  const store = {
    geometry: null as unknown, paint: null as unknown, log, failPaint: null as Error | null, delayPaint: 0,
    async loadGeometry() { return this.geometry; },
    async loadPaint() { return this.paint; },
    async saveBoth(g: GeometrySnapshot, p: PaintSnapshot) { log.push("both"); this.geometry = g; this.paint = p; },
    async savePaint(p: PaintSnapshot) {
      if (this.delayPaint) await new Promise((r) => setTimeout(r, this.delayPaint));
      if (this.failPaint) throw this.failPaint;
      log.push("paint");
      this.paint = p;
    },
    async clear() { log.push("clear"); this.geometry = null; this.paint = null; },
  };
  return store satisfies SnapshotStore & Record<string, unknown>;
}

const project = (): Project => {
  const p = createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }, { color: "#00FF00" }] }));
  p.addColor("#0000FF");
  return p;
};

/** Timers on vitest's fake clock; the idle callback runs right away on the next tick. */
const env = (): AutosaveEnv => ({
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  idle: (cb) => setTimeout(cb, 0),
  cancelIdle: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS + 50);

describe("Autosaver", () => {
  it("saves a new project once, geometry included, without waiting for an edit", async () => {
    const store = memoryStore();
    const p = project();
    const a = new Autosaver(p, new ProjectSaver(store), { startDirty: true }, env());
    await vi.advanceTimersByTimeAsync(10);
    expect(store.log).toEqual(["both"]);
    a.dispose();
  });

  it("does nothing for a restored project until it is edited, then writes only the paint", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    await settle();
    expect(store.log).toEqual([]);
    p.paintTriangles(0, [1], 2);
    await settle();
    expect(store.log).toEqual(["paint"]);
    a.dispose();
  });

  it("turns a burst of edits into one save after the quiet period", async () => {
    const store = memoryStore();
    const p = project();
    const a = new Autosaver(p, new ProjectSaver(store), {}, env());
    for (let i = 0; i < 20; i++) {
      p.paintTriangles(0, [i % 12], 1 + (i % 2));
      await vi.advanceTimersByTimeAsync(100); // each edit restarts the quiet period
    }
    expect(store.log).toEqual([]);
    await settle();
    expect(store.log).toEqual(["both"]);
    expect(await restoreProject(store).then((r) => r.status === "restored" && toSnapshot(r.project))).toEqual(toSnapshot(p));
    a.dispose();
  });

  it("saves palette, base color and undo/redo changes too", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    const a = new Autosaver(p, saver, {}, env());
    store.log.length = 0;
    p.setColor(1, "#123456");
    await settle();
    p.undo();
    await settle();
    p.redo();
    await settle();
    p.setObjectBaseColor(0, 2);
    await settle();
    expect(store.log).toEqual(["paint", "paint", "paint", "paint"]);
    a.dispose();
  });

  it("saves a mapping pin change although it is not an undo step", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    const a = new Autosaver(p, saver, {}, env());
    store.log.length = 0;
    const steps = p.undoCount;
    p.setPin(1, { kind: "spool", slot: 3 });
    expect(p.undoCount).toBe(steps);
    await settle();
    expect(store.log).toEqual(["paint"]);
    const restored = await restoreProject(store);
    expect(restored.status === "restored" && restored.project.mapping.get(1)).toEqual({ kind: "spool", slot: 3 });
    p.setPin(1, null);
    await settle();
    expect(store.log).toEqual(["paint", "paint"]);
    a.dispose();
  });

  it("never writes while a stroke is open, and saves once it closes", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    p.beginStroke();
    p.setColor(1, "#111111");
    await vi.advanceTimersByTimeAsync(10 * AUTOSAVE_DEBOUNCE_MS); // a picker session held open for a long time
    p.setColor(1, "#222222");
    await vi.advanceTimersByTimeAsync(10 * AUTOSAVE_DEBOUNCE_MS);
    expect(store.log).toEqual([]);
    p.endStroke();
    expect(store.log).toEqual([]); // debounced, not immediate
    await settle();
    expect(store.log).toEqual(["paint"]);
    expect((store.paint as PaintSnapshot).palette[0].color).toBe("#222222");
    a.dispose();
  });

  it("does not save a stroke's edits that ended where they began as a change, but may write once", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    const a = new Autosaver(p, saver, {}, env());
    store.log.length = 0;
    p.batch(() => { p.setColor(1, "#111111"); p.setColor(1, p.palette[1].color); });
    await settle();
    expect(store.log.length).toBeLessThanOrEqual(1);
    a.dispose();
  });

  it("flush writes immediately, but not for a clean project", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    a.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log).toEqual([]); // nothing changed

    p.setColor(1, "#abcdef");
    a.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log).toEqual(["paint"]);
    await settle();
    expect(store.log).toEqual(["paint"]); // the flush cancelled the debounced save

    a.dispose();
  });

  it("flush saves even while a stroke is open (the page may be going away), and the stroke's end saves the rest", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    p.beginStroke();
    p.setColor(1, "#fedcba");
    a.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log).toEqual(["paint"]);
    expect((store.paint as PaintSnapshot).palette[0].color).toBe("#FEDCBA");
    p.setColor(1, "#123456");
    p.endStroke();
    await settle();
    expect(store.log).toEqual(["paint", "paint"]);
    expect((store.paint as PaintSnapshot).palette[0].color).toBe("#123456");
    a.dispose();
  });

  it("a pending debounced save survives a stroke that opens and closes before it fires", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    p.setColor(1, "#111111"); // arms the debounce
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 200);
    p.beginStroke(); // opens just before it fires
    await vi.advanceTimersByTimeAsync(1000); // the timer fires inside the stroke: nothing is written
    expect(store.log).toEqual([]);
    p.endStroke();
    await settle();
    expect(store.log).toEqual(["paint"]);
    expect((store.paint as PaintSnapshot).palette[0].color).toBe("#111111");
    a.dispose();
  });

  it("reports each stored save", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    let saved = 0;
    const a = new Autosaver(p, saver, { startDirty: true, onSaved: () => saved++ }, env());
    await settle();
    p.setColor(1, "#111111");
    await settle();
    expect(saved).toBe(2);
    a.dispose();
  });

  it("flushAutosavers saves every running autosaver and skips disposed ones", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    p.setColor(1, "#111111");
    flushAutosavers();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.log).toEqual(["paint"]);
    a.dispose();
    p.setColor(1, "#222222");
    flushAutosavers();
    await settle();
    expect(store.log).toEqual(["paint"]);
  });

  it("flush queues behind a write that is still running instead of dropping the newer changes", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    store.delayPaint = 500;
    p.setColor(1, "#111111");
    await settle(); // the write starts and takes 500 ms
    p.setColor(1, "#222222");
    a.flush();
    store.delayPaint = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect((store.paint as PaintSnapshot).palette[0].color).toBe("#222222");
    a.dispose();
  });

  it("runs one save at a time and follows up with the edits made during a write", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    store.delayPaint = 3000;
    p.setColor(1, "#111111");
    await settle(); // first write in flight
    p.setColor(1, "#222222");
    p.setColor(1, "#333333");
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.log).toEqual([]); // still writing; nothing else was started
    store.delayPaint = 0;
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.log).toEqual(["paint", "paint"]);
    expect((store.paint as PaintSnapshot).palette[0].color).toBe("#333333");
    expect(a.pending).toBe(false);
    a.dispose();
  });

  it("reports a failed save, keeps the change pending and tries again at the next edit", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const errors: unknown[] = [];
    const a = new Autosaver(p, saver, { onError: (e) => errors.push(e) }, env());
    store.failPaint = new Error("quota");
    p.setColor(1, "#111111");
    await settle();
    expect(errors).toHaveLength(1);
    expect(a.pending).toBe(true);
    await settle(); // no retry loop on its own
    expect(errors).toHaveLength(1);

    store.failPaint = null;
    p.setColor(1, "#222222");
    await settle();
    expect(errors).toHaveLength(1);
    expect(store.log).toEqual(["paint"]);
    expect(a.pending).toBe(false);
    a.dispose();
  });

  it("dispose cancels a pending save and stops listening", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    await saver.save(p);
    store.log.length = 0;
    const a = new Autosaver(p, saver, {}, env());
    p.setColor(1, "#111111");
    a.dispose();
    p.setColor(1, "#222222");
    await settle();
    a.flush();
    await settle();
    expect(store.log).toEqual([]);
  });

  it("a queued save of the old project cannot write after the saver is cleared (New)", async () => {
    const store = memoryStore();
    const saver = new ProjectSaver(store);
    const p = project();
    const a = new Autosaver(p, saver, { startDirty: true }, env());
    a.flush(); // queued behind nothing, but runs on the next microtask
    a.dispose();
    await saver.clear();
    await settle();
    expect(store.geometry).toBeNull();
    expect(store.paint).toBeNull();
  });
});
