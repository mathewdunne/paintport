/**
 * Where the editor's global shortcuts (B F S E I, [ ], Ctrl+Z) must stay out of the way: text
 * fields, and everything inside a popover, menu, dialog, listbox or the color picker, where
 * the same keys mean something else (typing a hex value, typeahead in a menu, arrows on the
 * color area). The Radix popover and dialog content carry role="dialog", menus role="menu".
 * Buttons, tool toggles, tabs and sliders are not listed on purpose: after clicking a tool or
 * dragging the brush size, the shortcuts keep working.
 */
export const SHORTCUT_BLOCKERS = [
  "input",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
  "[role='menubar']",
  "[role='listbox']",
  "[role='combobox']",
  "[data-slot='popover-content']",
  ".react-colorful",
  "[data-no-shortcuts]",
].join(",");

/** Anything with a DOM-like `closest`, so it can be tested without a DOM. */
interface ClosestLike {
  closest(selector: string): unknown;
}

/** True if a key pressed with `target` focused belongs to the widget there and must not trigger a shortcut. */
export function blocksShortcuts(target: unknown): boolean {
  if (typeof target !== "object" || target === null || typeof (target as Partial<ClosestLike>).closest !== "function") return false;
  return (target as ClosestLike).closest(SHORTCUT_BLOCKERS) !== null;
}
