import { describe, expect, it } from "vitest";
import { swatchKeyHandler } from "./swatchNav";

/** A target whose `closest` finds a swatch for the given state, or nothing (a menu item, say). */
const swatch = (state: number) => ({ closest: () => ({ getAttribute: (n: string) => (n === "data-swatch" ? String(state) : null) }) });
const nothing = { closest: () => null };

function press(handler: ReturnType<typeof swatchKeyHandler>, key: string, target: unknown, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) {
  let prevented = false;
  handler({ key, altKey: false, ctrlKey: false, metaKey: false, target, preventDefault: () => { prevented = true; }, ...mods });
  return prevented;
}

describe("swatchKeyHandler", () => {
  it("moves from the focused swatch, not from some stored active one", () => {
    const moves: number[] = [];
    const h = swatchKeyHandler(10, (s) => moves.push(s));
    press(h, "ArrowRight", swatch(4));
    press(h, "ArrowLeft", swatch(4));
    press(h, "ArrowDown", swatch(7));
    press(h, "ArrowUp", swatch(7));
    press(h, "Home", swatch(7));
    press(h, "End", swatch(2));
    expect(moves).toEqual([5, 3, 8, 6, 1, 10]);
  });

  it("stays inside the palette", () => {
    const moves: number[] = [];
    const h = swatchKeyHandler(3, (s) => moves.push(s));
    expect(press(h, "ArrowLeft", swatch(1))).toBe(true); // handled (default prevented) but nowhere to go
    press(h, "ArrowRight", swatch(3));
    expect(moves).toEqual([]);
  });

  it("ignores keys from anywhere but a swatch, such as the portaled context menu", () => {
    const moves: number[] = [];
    const h = swatchKeyHandler(10, (s) => moves.push(s));
    expect(press(h, "ArrowDown", nothing)).toBe(false);
    expect(press(h, "ArrowDown", null)).toBe(false);
    expect(press(h, "ArrowDown", {})).toBe(false);
    expect(moves).toEqual([]);
  });

  it("leaves other keys and modified arrows alone", () => {
    const moves: number[] = [];
    const h = swatchKeyHandler(10, (s) => moves.push(s));
    expect(press(h, "a", swatch(2))).toBe(false);
    expect(press(h, "Enter", swatch(2))).toBe(false);
    expect(press(h, "ArrowRight", swatch(2), { altKey: true })).toBe(false);
    expect(press(h, "ArrowRight", swatch(2), { ctrlKey: true })).toBe(false);
    expect(moves).toEqual([]);
  });
});
