import { describe, expect, it } from "vitest";
import { isIsolated, isolate, NONE_HIDDEN, toggleHidden } from "./objectVisibility";

describe("object visibility", () => {
  it("toggles one object without touching the others, and never mutates its input", () => {
    const a = toggleHidden(NONE_HIDDEN, 1);
    expect([...a]).toEqual([1]);
    expect([...NONE_HIDDEN]).toEqual([]);
    const b = toggleHidden(a, 3);
    expect([...b].sort()).toEqual([1, 3]);
    expect([...toggleHidden(b, 1)]).toEqual([3]);
    expect([...a]).toEqual([1]);
  });

  it("isolates one object, and a second press shows everything again", () => {
    const once = isolate(NONE_HIDDEN, 2, 4);
    expect([...once].sort()).toEqual([0, 1, 3]);
    expect(isIsolated(once, 2, 4)).toBe(true);
    expect(isIsolated(once, 1, 4)).toBe(false);
    expect([...isolate(once, 2, 4)]).toEqual([]);
  });

  it("moves the solo to another object", () => {
    const once = isolate(NONE_HIDDEN, 0, 3);
    expect([...isolate(once, 2, 3)].sort()).toEqual([0, 1]);
  });

  it("a hidden object is not the solo one, and one object cannot be isolated", () => {
    expect(isIsolated(new Set([0, 1]), 1, 3)).toBe(false);
    expect(isIsolated(NONE_HIDDEN, 0, 1)).toBe(false);
    expect(isIsolated(NONE_HIDDEN, 0, 3)).toBe(false);
  });
});
