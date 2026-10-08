import { describe, expect, it } from "vitest";
import { cubeMesh, leaf, makeModel } from "../../test/support/docFixtures";
import { DocError } from "./errors";
import type { ProjectEvent } from "./events";
import { blendKey, clonePin, dropPinState, pinProblem, restorePinState, samePin, type MappingPin } from "./pins";
import { createProject, type Project } from "./project";
import { fromSnapshot, toGeometrySnapshot, toPaintSnapshot, toSnapshot, type ProjectSnapshot } from "./snapshot";

const spool = (slot: number): MappingPin => ({ kind: "spool", slot });
const blend = (...parts: [number, number][]): MappingPin => ({ kind: "blend", components: parts.map(([slot, ratio]) => ({ slot, ratio })) });

/** Palette: 1 red (base), 2 green, 3 blue, 4 yellow, each painted on one triangle. */
function project(): Project {
  return createProject(makeModel(cubeMesh(), {
    filaments: [{ color: "#FF0000" }, { color: "#00FF00" }, { color: "#0000FF" }, { color: "#FFFF00" }],
    paints: [leaf(2), leaf(3), leaf(4)],
  }), { name: "figure" });
}

const pinned = (p: Project): Record<number, MappingPin> => Object.fromEntries(p.mapping);

function record(p: Project): ProjectEvent[] {
  const events: ProjectEvent[] = [];
  p.subscribe((e) => events.push(e));
  return events;
}
const kinds = (events: ProjectEvent[]) => events.map((e) => e.kind);

describe("pin validation", () => {
  it("accepts spool and blend pins", () => {
    expect(pinProblem(spool(1))).toBeNull();
    expect(pinProblem(spool(16))).toBeNull();
    expect(pinProblem(blend([1, 1], [3, 3]))).toBeNull();
    expect(pinProblem(blend([1, 1], [2, 1], [3, 1]))).toBeNull();
  });

  it("rejects everything else", () => {
    const bad: unknown[] = [
      null, undefined, 3, "spool", [], {}, { kind: "mix" },
      { kind: "spool" }, spool(0), spool(17), spool(1.5), { kind: "spool", slot: "2" },
      { kind: "blend" }, { kind: "blend", components: [] }, blend([1, 1]),
      blend([2, 1], [1, 1]), blend([1, 1], [1, 3]), blend([1, 0], [2, 1]), blend([1, 1.5], [2, 1]), blend([1, 1], [17, 1]), blend([1, 1], [2, 101]),
      { kind: "blend", components: [{ slot: 1, ratio: 1 }, null] }, { kind: "blend", components: "ab" },
    ];
    for (const pin of bad) expect(pinProblem(pin), JSON.stringify(pin)).not.toBeNull();
  });

  it("clones to the pin's own fields and compares by value", () => {
    const original = { kind: "blend", components: [{ slot: 1, ratio: 1 }, { slot: 2, ratio: 3 }], extra: 1 } as MappingPin;
    const copy = clonePin(original);
    expect(copy).toEqual(blend([1, 1], [2, 3]));
    expect(copy).not.toHaveProperty("extra");
    expect(samePin(copy, blend([1, 1], [2, 3]))).toBe(true);
    expect(samePin(copy, blend([1, 1], [2, 1]))).toBe(false);
    expect(samePin(spool(2), spool(2))).toBe(true);
    expect(samePin(spool(2), blend([1, 1], [2, 1]))).toBe(false);
  });
});

describe("blend ratios", () => {
  it("are reduced by their greatest common divisor in keys, clones and comparisons", () => {
    expect(blendKey([{ slot: 1, ratio: 2 }, { slot: 3, ratio: 2 }])).toBe("1:1|3:1");
    expect(blendKey([{ slot: 1, ratio: 2 }, { slot: 3, ratio: 6 }])).toBe("1:1|3:3");
    expect(clonePin(blend([1, 2], [2, 6]))).toEqual(blend([1, 1], [2, 3]));
    expect(clonePin(blend([1, 1], [2, 3]))).toEqual(blend([1, 1], [2, 3]));
    expect(samePin(blend([1, 2], [2, 2]), blend([1, 1], [2, 1]))).toBe(true);
    expect(samePin(blend([1, 1], [2, 3]), blend([1, 1], [2, 1]))).toBe(false);
  });

  it("setPin stores the reduced recipe and sees 2:2 as unchanged after 1:1", () => {
    const p = project();
    p.setPin(2, blend([1, 4], [2, 4]));
    expect(p.mapping.get(2)).toEqual(blend([1, 1], [2, 1]));
    expect(p.setPin(2, blend([1, 3], [2, 3]))).toBe(false);
  });
});

describe("pin renumbering helpers", () => {
  const pins = new Map<number, MappingPin>([[1, spool(1)], [3, spool(3)], [4, spool(4)]]);

  it("dropPinState removes the state's pin and shifts the higher ones down", () => {
    expect([...dropPinState(pins, 3)]).toEqual([[1, spool(1)], [3, spool(4)]]);
    expect([...dropPinState(pins, 2)]).toEqual([[1, spool(1)], [2, spool(3)], [3, spool(4)]]);
  });

  it("returns the same map when nothing moves", () => {
    expect(dropPinState(pins, 5)).toBe(pins);
    expect(restorePinState(pins, 5, undefined)).toBe(pins);
  });

  it("restorePinState inverts it", () => {
    const dropped = dropPinState(pins, 3);
    expect(new Map(restorePinState(dropped, 3, spool(3)))).toEqual(pins);
    expect(new Map(restorePinState(dropPinState(pins, 2), 2, undefined))).toEqual(pins);
  });
});

describe("Project.setPin", () => {
  it("sets, replaces and clears a pin and emits one mapping event each time", () => {
    const p = project();
    const events = record(p);
    expect(p.mapping.size).toBe(0);
    expect(p.setPin(2, spool(3))).toBe(true);
    expect(pinned(p)).toEqual({ 2: spool(3) });
    expect(p.setPin(2, blend([1, 1], [2, 3]))).toBe(true);
    expect(p.setPin(2, null)).toBe(true);
    expect(p.mapping.size).toBe(0);
    expect(events).toEqual([{ kind: "mapping" }, { kind: "mapping" }, { kind: "mapping" }]);
  });

  it("emits nothing when nothing changes", () => {
    const p = project();
    p.setPin(2, blend([1, 1], [2, 3]));
    const events = record(p);
    expect(p.setPin(2, blend([1, 1], [2, 3]))).toBe(false);
    expect(p.setPin(3, null)).toBe(false);
    expect(events).toEqual([]);
  });

  it("validates the state and the pin", () => {
    const p = project();
    for (const state of [0, 5, -1, 1.5]) {
      expect(() => p.setPin(state, spool(1))).toThrowError(expect.objectContaining({ code: "STATE_RANGE" }));
      expect(() => p.setPin(state, null)).toThrow(DocError);
    }
    for (const pin of [spool(0), blend([2, 1], [1, 1]), { kind: "x" } as unknown as MappingPin]) {
      expect(() => p.setPin(2, pin)).toThrowError(expect.objectContaining({ code: "PIN_INVALID" }));
    }
    expect(p.mapping.size).toBe(0);
  });

  it("replaces the map instead of mutating it, and keeps its own copy of the pin", () => {
    const p = project();
    const before = p.mapping;
    const pin = blend([1, 1], [2, 3]) as { kind: "blend"; components: { slot: number; ratio: number }[] };
    p.setPin(2, pin);
    expect(p.mapping).not.toBe(before);
    expect(before.size).toBe(0);
    pin.components[0].slot = 9;
    expect(p.mapping.get(2)).toEqual(blend([1, 1], [2, 3]));
  });

  it("is not an undo step and is not touched by undo and redo of paint", () => {
    const p = project();
    p.paintTriangles(0, [5], 2);
    p.setPin(3, spool(2));
    const events = record(p);
    expect(p.undoCount).toBe(1);
    expect(p.undo()).toBe(true);
    expect(pinned(p)).toEqual({ 3: spool(2) });
    expect(p.canUndo).toBe(false);
    p.redo();
    expect(pinned(p)).toEqual({ 3: spool(2) });
    expect(kinds(events)).not.toContain("mapping");
    p.setPin(3, null);
    expect(p.canUndo).toBe(true); // the paint stroke only
    expect(p.undoCount).toBe(1);
  });

  it("announces a change without a history event", () => {
    const p = project();
    const events = record(p);
    p.setPin(1, spool(1));
    expect(kinds(events)).toEqual(["mapping"]);
  });
});

describe("pins and palette renumbering", () => {
  function pinnedProject(): Project {
    const p = project();
    p.setPin(1, spool(1));
    p.setPin(2, spool(2));
    p.setPin(3, blend([1, 1], [2, 1]));
    p.setPin(4, spool(4));
    return p;
  }

  it("deleting a color drops its pin and moves the higher pins with their states", () => {
    const p = pinnedProject();
    const events = record(p);
    p.deleteColor(2, 1);
    expect(pinned(p)).toEqual({ 1: spool(1), 2: blend([1, 1], [2, 1]), 3: spool(4) });
    expect(kinds(events)).toEqual(["palette", "mapping", "history"]);
    expect(p.palette[2].color).toBe("#0000FF"); // the pin of the blue color followed it
    expect(p.palette[3].color).toBe("#FFFF00");
  });

  it("undo brings the dropped pin back, redo drops it again", () => {
    const p = pinnedProject();
    const start = pinned(p);
    p.deleteColor(2, 1);
    const afterDelete = pinned(p);
    const events = record(p);
    p.undo();
    expect(pinned(p)).toEqual(start);
    p.redo();
    expect(pinned(p)).toEqual(afterDelete);
    expect(kinds(events).filter((k) => k === "mapping")).toHaveLength(2);
  });

  it("pins set after a delete move with their states when the delete is undone", () => {
    const p = pinnedProject();
    p.deleteColor(2, 1); // blue is state 2 and yellow state 3 now
    p.setPin(3, spool(7)); // yellow, previously state 4
    p.setPin(2, null); // blue loses its pin
    p.undo(); // blue is state 3 again, yellow state 4
    expect(pinned(p)).toEqual({ 1: spool(1), 2: spool(2), 4: spool(7) });
    p.redo();
    expect(pinned(p)).toEqual({ 1: spool(1), 3: spool(7) });
  });

  it("merging into base behaves the same, and deleting the last color drops only its pin", () => {
    const p = project();
    p.setPin(3, spool(3));
    p.setPin(4, spool(4));
    p.deleteColor(4, 0);
    expect(pinned(p)).toEqual({ 3: spool(3) });
    p.undo();
    expect(pinned(p)).toEqual({ 3: spool(3), 4: spool(4) });
  });

  it("emits no mapping event when the delete does not involve a pin", () => {
    const p = project();
    p.setPin(1, spool(1));
    const events = record(p);
    p.deleteColor(3, 1); // the only pin is below the deleted state
    p.undo();
    expect(kinds(events)).not.toContain("mapping");
    expect(pinned(p)).toEqual({ 1: spool(1) });
  });

  it("several deletes in one stroke restore all their pins on one undo", () => {
    const p = pinnedProject();
    p.batch(() => {
      p.deleteColor(2, 1);
      p.deleteColor(2, 1); // the former state 3
    });
    expect(pinned(p)).toEqual({ 1: spool(1), 2: spool(4) });
    expect(p.undoCount).toBe(1);
    p.undo();
    expect(pinned(p)).toEqual({ 1: spool(1), 2: spool(2), 3: blend([1, 1], [2, 1]), 4: spool(4) });
    p.redo();
    expect(pinned(p)).toEqual({ 1: spool(1), 2: spool(4) });
  });

  it("a color added and deleted again inside one stroke leaves the pins as they were", () => {
    const p = pinnedProject();
    p.batch(() => {
      const s = p.addColor("#123456");
      p.deleteColor(s, 1);
    });
    const all = { 1: spool(1), 2: spool(2), 3: blend([1, 1], [2, 1]), 4: spool(4) };
    expect(pinned(p)).toEqual(all);
    p.undo();
    expect(pinned(p)).toEqual(all);
    p.redo();
    expect(pinned(p)).toEqual(all);
  });

  it("history limits do not affect the pins", () => {
    const p = pinnedProject();
    p.deleteColor(1, 2);
    p.clearHistory();
    expect(pinned(p)).toEqual({ 1: spool(2), 2: blend([1, 1], [2, 1]), 3: spool(4) });
  });
});

describe("pins and a shrinking palette", () => {
  const allPinsValid = (p: Project) => {
    for (const s of p.mapping.keys()) expect(s).toBeLessThan(p.palette.length);
    expect(() => fromSnapshot(structuredClone(toSnapshot(p)))).not.toThrow(); // what the autosave restores
  };

  it("undo of addColor drops a pin set on the new color, so the snapshot stays valid", () => {
    const p = project();
    const s = p.addColor("#123456");
    p.setPin(s, spool(4));
    const events = record(p);
    p.undo();
    expect(p.palette).toHaveLength(5);
    expect(p.mapping.size).toBe(0);
    expect(kinds(events)).toContain("mapping");
    allPinsValid(p);
    // The next added color does not inherit the stale pin, and neither does the redo of the first one.
    expect(p.addColor("#654321")).toBe(s);
    expect(p.mapping.size).toBe(0);
    p.undo();
    p.redo();
    expect(p.mapping.size).toBe(0);
    allPinsValid(p);
  });

  it("redo of a delete prunes nothing it should keep, and undo/redo keep the pins valid throughout", () => {
    const p = project();
    p.setPin(4, spool(2)); // the last state
    p.deleteColor(2, 1);
    expect(pinned(p)).toEqual({ 3: spool(2) });
    allPinsValid(p);
    p.undo();
    expect(pinned(p)).toEqual({ 4: spool(2) });
    allPinsValid(p);
    p.redo();
    expect(pinned(p)).toEqual({ 3: spool(2) });
    allPinsValid(p);
  });

  it("a pin on the color added by a stroke that is undone does not survive", () => {
    const p = project();
    p.batch(() => {
      const s = p.addColor("#123456");
      p.setPin(s, spool(1));
    });
    p.undo();
    expect(p.mapping.size).toBe(0);
    allPinsValid(p);
  });

  it("the snapshot never writes a pin beyond the palette", () => {
    const p = project();
    const s = p.addColor("#123456");
    p.setPin(s, spool(4));
    expect(toPaintSnapshot(p).mapping).toEqual([[s, spool(4)]]);
  });
});

describe("source name", () => {
  it("is kept from createProject and is optional", () => {
    expect(project().source.name).toBe("figure");
    const p = createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }] }));
    expect(p.source).not.toHaveProperty("name");
    expect(createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }] }), { name: "" }).source).not.toHaveProperty("name");
  });
});

describe("pins in snapshots", () => {
  const clone = (p: Project): ProjectSnapshot => structuredClone(toSnapshot(p));

  it("round-trips pins and the source name", () => {
    const p = project();
    p.setPin(3, blend([1, 1], [2, 3]));
    p.setPin(1, spool(5));
    const snap = clone(p);
    expect(snap.paint.mapping).toEqual([[1, spool(5)], [3, blend([1, 1], [2, 3])]]); // ascending by state
    expect(snap.geometry.source.name).toBe("figure");
    const q = fromSnapshot(structuredClone(snap));
    expect(pinned(q)).toEqual(pinned(p));
    expect(q.source.name).toBe("figure");
    expect(toSnapshot(q)).toEqual(toSnapshot(p));
    q.setPin(1, null); // the restored project owns its map
    expect(pinned(p)).toHaveProperty("1");
  });

  it("writes no mapping field when there are no pins, and the snapshot version is unchanged", () => {
    const paint = toPaintSnapshot(project());
    expect(paint).not.toHaveProperty("mapping");
    expect(paint.version).toBe(1);
    expect(toGeometrySnapshot(project()).version).toBe(1);
  });

  it("restores snapshots written before pins and names existed", () => {
    const snap = clone(project());
    delete (snap.paint as { mapping?: unknown }).mapping;
    delete (snap.geometry.source as { name?: string }).name;
    const q = fromSnapshot(snap);
    expect(q.mapping.size).toBe(0);
    expect(q.source).not.toHaveProperty("name");
    expect(q.palette).toHaveLength(5);
  });

  it("a pin removed after saving is gone after the next save", () => {
    const p = project();
    p.setPin(2, spool(1));
    p.setPin(2, null);
    expect(toPaintSnapshot(p)).not.toHaveProperty("mapping");
  });

  const mutations: [string, (s: ProjectSnapshot) => void][] = [
    ["mapping is not an array", (s) => { (s.paint as { mapping: unknown }).mapping = { 1: spool(1) }; }],
    ["entry is not a pair", (s) => { (s.paint as { mapping: unknown }).mapping = [[1]]; }],
    ["entry is not an array", (s) => { (s.paint as { mapping: unknown }).mapping = [{ state: 1, pin: spool(1) }]; }],
    ["state 0", (s) => { s.paint.mapping = [[0, spool(1)]]; }],
    ["state beyond the palette", (s) => { s.paint.mapping = [[5, spool(1)]]; }],
    ["fractional state", (s) => { (s.paint as { mapping: unknown }).mapping = [[1.5, spool(1)]]; }],
    ["unsorted states", (s) => { s.paint.mapping = [[3, spool(1)], [2, spool(2)]]; }],
    ["duplicate states", (s) => { s.paint.mapping = [[2, spool(1)], [2, spool(2)]]; }],
    ["slot out of range", (s) => { s.paint.mapping = [[2, { kind: "spool", slot: 17 }]]; }],
    ["blend with one component", (s) => { s.paint.mapping = [[2, { kind: "blend", components: [{ slot: 1, ratio: 1 }] }]]; }],
    ["blend not sorted", (s) => { s.paint.mapping = [[2, { kind: "blend", components: [{ slot: 2, ratio: 1 }, { slot: 1, ratio: 1 }] }]]; }],
    ["unknown pin kind", (s) => { (s.paint as { mapping: unknown }).mapping = [[2, { kind: "auto" }]]; }],
    ["pin is null", (s) => { (s.paint as { mapping: unknown }).mapping = [[2, null]]; }],
    ["name is not a string", (s) => { (s.geometry.source as { name: unknown }).name = 5; }],
  ];

  for (const [name, mutate] of mutations) {
    it(`rejects a snapshot whose ${name}`, () => {
      const snap = clone(project());
      mutate(snap);
      expect(() => fromSnapshot(snap)).toThrowError(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
    });
  }
});
