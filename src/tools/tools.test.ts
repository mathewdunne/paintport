import { describe, expect, it } from "vitest";
import { interpolateDabs } from "./dabs";
import { CLICK_MOVE_PX, ClickDetector } from "./gesture";
import { interpretKey, type KeyLike } from "./keys";
import { clampRadius, DEFAULT_RADIUS, formatRadius, MAX_RADIUS, MIN_RADIUS, radiusToSlider, sliderToRadius, stepRadius } from "./radius";

describe("interpolateDabs", () => {
  it("places dabs at the spacing along a straight move and carries the remainder", () => {
    const r = interpolateDabs({ x: 0, y: 0 }, { x: 25, y: 0 }, 10, 0);
    expect(r.points.map((p) => p.x)).toEqual([10, 20]);
    expect(r.carry).toBeCloseTo(5);
  });

  it("keeps the spacing even across calls", () => {
    // The same 100 px drag as one move, or as 7 uneven moves, dabs at the same places.
    const whole = interpolateDabs({ x: 0, y: 0 }, { x: 100, y: 0 }, 8, 0).points.map((p) => p.x);
    const cuts = [0, 3, 14, 15, 40, 41, 77, 100];
    const parts: number[] = [];
    let carry = 0;
    for (let i = 1; i < cuts.length; i++) {
      const r = interpolateDabs({ x: cuts[i - 1], y: 0 }, { x: cuts[i], y: 0 }, 8, carry);
      parts.push(...r.points.map((p) => p.x));
      carry = r.carry;
    }
    expect(parts).toHaveLength(whole.length);
    parts.forEach((x, i) => expect(x).toBeCloseTo(whole[i]));
    for (let i = 1; i < parts.length; i++) expect(parts[i] - parts[i - 1]).toBeCloseTo(8);
  });

  it("works along diagonals and leaves no gaps larger than the spacing", () => {
    const r = interpolateDabs({ x: 10, y: 10 }, { x: 40, y: 50 }, 7, 0);
    let prev = { x: 10, y: 10 };
    for (const p of r.points) {
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeCloseTo(7);
      prev = p;
    }
    expect(Math.hypot(40 - prev.x, 50 - prev.y)).toBeLessThanOrEqual(7);
  });

  it("returns nothing for a stationary pointer or a move shorter than the remaining spacing", () => {
    expect(interpolateDabs({ x: 5, y: 5 }, { x: 5, y: 5 }, 10, 3)).toEqual({ points: [], carry: 3 });
    const r = interpolateDabs({ x: 0, y: 0 }, { x: 2, y: 0 }, 10, 3);
    expect(r.points).toEqual([]);
    expect(r.carry).toBeCloseTo(5);
  });

  it("dabs right away when the spacing shrank below the distance already travelled", () => {
    const r = interpolateDabs({ x: 0, y: 0 }, { x: 4, y: 0 }, 2, 9);
    expect(r.points[0].x).toBeCloseTo(0);
  });

  it("caps the number of dabs for a very long move by widening the spacing", () => {
    const r = interpolateDabs({ x: 0, y: 0 }, { x: 10000, y: 0 }, 1, 0, 50);
    expect(r.points.length).toBeLessThanOrEqual(51);
    expect(r.points.length).toBeGreaterThan(40);
    expect(r.points.at(-1)!.x).toBeGreaterThan(9900);
  });
});

describe("ClickDetector (Alt+click is the eyedropper, Alt+drag orbits)", () => {
  it("is a click when the pointer stays within a few pixels", () => {
    const c = new ClickDetector();
    c.press({ x: 100, y: 100 });
    c.move({ x: 102, y: 101 });
    c.move({ x: 100 + CLICK_MOVE_PX, y: 100 });
    expect(c.release()).toBe(true);
  });

  it("is a drag once the pointer left the threshold, even if it came back", () => {
    const c = new ClickDetector();
    c.press({ x: 100, y: 100 });
    c.move({ x: 100 + CLICK_MOVE_PX + 1, y: 100 });
    c.move({ x: 100, y: 100 });
    expect(c.release()).toBe(false);
  });

  it("is reusable and a release without a press is no click", () => {
    const c = new ClickDetector();
    expect(c.release()).toBe(false);
    c.press({ x: 0, y: 0 });
    expect(c.active).toBe(true);
    c.cancel();
    expect(c.active).toBe(false);
    expect(c.release()).toBe(false);
    c.press({ x: 0, y: 0 });
    expect(c.release()).toBe(true);
    expect(c.active).toBe(false);
  });
});

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("interpretKey", () => {
  it("maps B F S E I to the tools, in either case", () => {
    expect(interpretKey(key("b"), false)).toEqual({ type: "tool", tool: "brush" });
    expect(interpretKey(key("F"), false)).toEqual({ type: "tool", tool: "shellFill" });
    expect(interpretKey(key("s"), false)).toEqual({ type: "tool", tool: "smartFill" });
    expect(interpretKey(key("a"), false)).toEqual({ type: "tool", tool: "aiPaint" });
    expect(interpretKey(key("e"), false)).toEqual({ type: "tool", tool: "eraser" });
    expect(interpretKey(key("I", { shiftKey: true }), false)).toEqual({ type: "tool", tool: "eyedropper" });
    expect(interpretKey(key("x"), false)).toBeNull();
  });

  it("maps [ and ] to the brush radius, also with Shift held and as AltGr", () => {
    expect(interpretKey(key("["), false)).toEqual({ type: "radius", direction: -1 });
    expect(interpretKey(key("]"), false)).toEqual({ type: "radius", direction: 1 });
    expect(interpretKey(key("{", { shiftKey: true }), false)).toEqual({ type: "radius", direction: -1 });
    expect(interpretKey(key("}", { shiftKey: true }), false)).toEqual({ type: "radius", direction: 1 });
    expect(interpretKey(key("[", { ctrlKey: true, altKey: true }), false)).toEqual({ type: "radius", direction: -1 });
    expect(interpretKey(key("]", { altKey: true }), false)).toBeNull();
  });

  it("maps Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y to undo and redo", () => {
    expect(interpretKey(key("z", { ctrlKey: true }), false)).toEqual({ type: "undo" });
    expect(interpretKey(key("z", { metaKey: true }), false)).toEqual({ type: "undo" });
    expect(interpretKey(key("Z", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "redo" });
    expect(interpretKey(key("y", { ctrlKey: true }), false)).toEqual({ type: "redo" });
    expect(interpretKey(key("y", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(interpretKey(key("z"), false)).toBeNull();
  });

  it("does not take tool letters with Ctrl, Cmd or Alt held (copy, select all, ...)", () => {
    for (const k of ["b", "f", "s", "e", "i"]) {
      expect(interpretKey(key(k, { ctrlKey: true }), false)).toBeNull();
      expect(interpretKey(key(k, { metaKey: true }), false)).toBeNull();
      expect(interpretKey(key(k, { altKey: true }), false)).toBeNull();
    }
  });

  it("ignores everything while typing", () => {
    expect(interpretKey(key("b"), true)).toBeNull();
    expect(interpretKey(key("z", { ctrlKey: true }), true)).toBeNull();
    expect(interpretKey(key("["), true)).toBeNull();
  });
});

describe("brush radius", () => {
  it("clamps to the range and falls back for junk", () => {
    expect(clampRadius(0)).toBe(MIN_RADIUS);
    expect(clampRadius(1000)).toBe(MAX_RADIUS);
    expect(clampRadius(NaN)).toBe(DEFAULT_RADIUS);
    expect(DEFAULT_RADIUS).toBeGreaterThanOrEqual(MIN_RADIUS);
    expect(DEFAULT_RADIUS).toBeLessThanOrEqual(MAX_RADIUS);
  });

  it("maps to a logarithmic slider and back", () => {
    expect(radiusToSlider(MIN_RADIUS)).toBeCloseTo(0);
    expect(radiusToSlider(MAX_RADIUS)).toBeCloseTo(1);
    expect(sliderToRadius(0)).toBeCloseTo(MIN_RADIUS);
    expect(sliderToRadius(1)).toBeCloseTo(MAX_RADIUS);
    for (const r of [0.2, 0.5, 1, 3, 10, 30]) expect(sliderToRadius(radiusToSlider(r))).toBeCloseTo(r, 6);
    // log scale: the geometric middle sits at the slider's middle
    expect(sliderToRadius(0.5)).toBeCloseTo(Math.sqrt(MIN_RADIUS * MAX_RADIUS));
  });

  it("steps by a fixed ratio and stops at the ends", () => {
    expect(stepRadius(4, 1)).toBe(5);
    expect(stepRadius(5, -1)).toBe(4);
    expect(stepRadius(MAX_RADIUS, 1)).toBe(MAX_RADIUS);
    expect(stepRadius(MIN_RADIUS, -1)).toBe(MIN_RADIUS);
    let r = MIN_RADIUS;
    for (let i = 0; i < 40; i++) r = stepRadius(r, 1);
    expect(r).toBe(MAX_RADIUS);
  });

  it("formats with sensible precision", () => {
    expect(formatRadius(0.25)).toBe("0.3");
    expect(formatRadius(3)).toBe("3.0");
    expect(formatRadius(12.4)).toBe("12");
  });
});
