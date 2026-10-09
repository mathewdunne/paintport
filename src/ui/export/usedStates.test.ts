import { describe, expect, it } from "vitest";
import { cubeMesh, makeModel } from "../../../test/support/docFixtures";
import { createProject, type Project } from "@/doc/project";
import { SETTLE_MS, UsedStatesTracker, type TimerEnv } from "./usedStates";

class FakeTimers implements TimerEnv {
  now = 0;
  private timers = new Map<number, { cb: () => void; at: number }>();
  private next = 1;
  setTimer(cb: () => void, ms: number) { const id = this.next++; this.timers.set(id, { cb, at: this.now + ms }); return id; }
  clearTimer(id: number) { this.timers.delete(id); }
  get pending() { return this.timers.size; }
  advance(ms: number) {
    this.now += ms;
    for (const [id, t] of [...this.timers]) if (t.at <= this.now) { this.timers.delete(id); t.cb(); }
  }
}

/** Palette: 1 red (base), 2 green, 3 blue, nothing painted. */
function project(): Project {
  const p = createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }] }));
  p.addColor("#00FF00");
  p.addColor("#0000FF");
  p.clearHistory();
  return p;
}

function track(p: Project) {
  const timers = new FakeTimers();
  const tracker = new UsedStatesTracker(p, timers);
  let notified = 0;
  const off = tracker.subscribe(() => notified++);
  return { tracker, timers, off, notified: () => notified };
}

describe("UsedStatesTracker", () => {
  it("starts with the base color and the painted states", () => {
    const p = project();
    p.paintTriangles(0, [0], 3);
    expect(new UsedStatesTracker(p, new FakeTimers()).getSnapshot()).toEqual([1, 3]);
  });

  it("does not scan per dab: a burst of paint events is read once, after it settles", () => {
    const p = project();
    const { tracker, timers, notified } = track(p);
    p.beginStroke();
    for (let t = 0; t < 6; t++) {
      p.paintTriangles(0, [t], 2);
      timers.advance(SETTLE_MS / 4); // dabs faster than the settle time
    }
    expect(tracker.getSnapshot()).toEqual([1]); // still the old answer: no scan yet
    expect(notified()).toBe(0);
    expect(timers.pending).toBe(1); // one timer, re-armed by each dab
    timers.advance(SETTLE_MS);
    expect(tracker.getSnapshot()).toEqual([1, 2]);
    expect(notified()).toBe(1);
    p.endStroke();
    expect(notified()).toBe(1); // the stroke end finds nothing new
  });

  it("scans at once when the stroke ends, without waiting for the timer", () => {
    const p = project();
    const { tracker, timers, notified } = track(p);
    p.beginStroke();
    p.paintTriangles(0, [0, 1], 3);
    expect(tracker.getSnapshot()).toEqual([1]);
    p.endStroke();
    expect(tracker.getSnapshot()).toEqual([1, 3]);
    expect(notified()).toBe(1);
    expect(timers.pending).toBe(0);
  });

  it("notices a fill (a single edit outside a stroke) and its undo at once", () => {
    const p = project();
    const { tracker, timers } = track(p);
    p.paintTriangles(0, [0], 2);
    expect(tracker.getSnapshot()).toEqual([1, 2]);
    p.undo();
    expect(tracker.getSnapshot()).toEqual([1]);
    p.redo();
    expect(tracker.getSnapshot()).toEqual([1, 2]);
    expect(timers.pending).toBe(0);
  });

  it("tells nobody when the set of used colors stays the same", () => {
    const p = project();
    const { tracker, timers, notified } = track(p);
    p.paintTriangles(0, [0], 2);
    timers.advance(SETTLE_MS);
    expect(notified()).toBe(1);
    p.paintTriangles(0, [1, 2], 2); // more of a color that is already used
    timers.advance(SETTLE_MS);
    expect(notified()).toBe(1);
    expect(tracker.getSnapshot()).toEqual([1, 2]);
  });

  it("follows base color changes and color deletes at once", () => {
    const p = project();
    const { tracker, notified } = track(p);
    p.setObjectBaseColor(0, 3);
    expect(tracker.getSnapshot()).toEqual([3]);
    expect(notified()).toBe(1);
    p.paintTriangles(0, [0], 2);
    p.deleteColor(2, 3); // merge green into blue; blue moves down to 2
    expect(tracker.getSnapshot()).toEqual([2]);
  });

  it("ignores edits that cannot change which colors are used", () => {
    const p = project();
    const { timers, notified } = track(p);
    p.setColor(2, "#112233");
    p.addColor("#445566");
    p.setPin(1, { kind: "spool", slot: 3 });
    expect(timers.pending).toBe(0);
    expect(notified()).toBe(0);
  });

  it("stops listening with the last subscriber, and catches up with the first new one", () => {
    const p = project();
    const { tracker, timers, off } = track(p);
    p.beginStroke();
    p.paintTriangles(0, [0], 2); // starts the settle timer
    expect(timers.pending).toBe(1);
    off();
    expect(timers.pending).toBe(0);
    p.paintTriangles(0, [1], 3); // nobody listens
    p.endStroke();
    expect(tracker.getSnapshot()).toEqual([1]);
    let notified = 0;
    tracker.subscribe(() => notified++);
    expect(tracker.getSnapshot()).toEqual([1, 2, 3]);
    expect(notified).toBe(1);
  });

  it("does not rescan on subscribe when nothing happened", () => {
    const p = project();
    const tracker = new UsedStatesTracker(p, new FakeTimers());
    const before = tracker.getSnapshot();
    let notified = 0;
    tracker.subscribe(() => notified++);
    expect(tracker.getSnapshot()).toBe(before);
    expect(notified).toBe(0);
  });
});
