import { describe, expect, it } from "vitest";
import { interpretKey } from "@/tools/keys";
import { blocksShortcuts, SHORTCUT_BLOCKERS } from "./shortcutGuard";

/** A stand-in element: `closest` says whether one of the blocker selectors matches it or an ancestor. */
const el = (...ancestorSelectors: string[]) => ({
  closest: (selector: string) => (ancestorSelectors.some((s) => selector.split(",").includes(s)) ? {} : null),
});

describe("shortcut guard", () => {
  it("blocks inside text fields, dialogs, popovers, menus and the color picker", () => {
    for (const s of ["input", "textarea", "[role='dialog']", "[role='alertdialog']", "[role='menu']", "[role='listbox']", "[data-slot='popover-content']", ".react-colorful"]) {
      expect(SHORTCUT_BLOCKERS.split(",")).toContain(s);
      expect(blocksShortcuts(el(s))).toBe(true);
    }
  });

  it("lets buttons, tool toggles, tabs and sliders through, so shortcuts work after clicking them", () => {
    expect(blocksShortcuts(el())).toBe(false);
    for (const s of ["button", "[role='radio']", "[role='tab']", "[role='slider']", "[role='radiogroup']"]) expect(SHORTCUT_BLOCKERS.split(",")).not.toContain(s);
  });

  it("ignores targets that are not elements", () => {
    for (const t of [null, undefined, window_like(), 5, "x", {}]) expect(blocksShortcuts(t)).toBe(false);
  });

  it("is what stops letter keys from switching tools inside a popover", () => {
    const key = { key: "b", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(interpretKey(key, blocksShortcuts(el("[role='dialog']")))).toBeNull();
    expect(interpretKey(key, blocksShortcuts(el()))).toEqual({ type: "tool", tool: "brush" });
    // ... including undo, so Ctrl+Z in the hex field stays the field's own undo.
    expect(interpretKey({ ...key, key: "z", ctrlKey: true }, blocksShortcuts(el("input")))).toBeNull();
  });
});

function window_like() {
  return { addEventListener() {} };
}
