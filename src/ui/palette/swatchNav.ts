import type { KeyboardEvent } from "react";

/** Marks a swatch button with its palette state; the key handler below reads it from the focused swatch. */
export const SWATCH_SELECTOR = "[role='radio'][data-swatch]";

interface KeyEventLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  target: unknown;
  preventDefault(): void;
}

/**
 * Arrow-key handler for a radio group of palette swatches (states 1..last): Left/Up and
 * Right/Down step from the swatch that has the focus, Home/End jump. Calls `move` with the new
 * state; other keys pass through.
 *
 * Only keys pressed on a swatch count. React events bubble through portals, so the arrows of a
 * context menu opened from a swatch reach this handler too, and must not change the color.
 */
export function swatchKeyHandler(last: number, move: (state: number) => void) {
  return (e: KeyboardEvent | KeyEventLike) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as { closest?: (selector: string) => { getAttribute(name: string): string | null } | null } | null;
    const swatch = typeof target?.closest === "function" ? target.closest(SWATCH_SELECTOR) : null;
    if (!swatch) return;
    const current = Number(swatch.getAttribute("data-swatch"));
    if (!Number.isInteger(current)) return;
    const to = { ArrowRight: current + 1, ArrowDown: current + 1, ArrowLeft: current - 1, ArrowUp: current - 1, Home: 1, End: last }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    if (to >= 1 && to <= last) move(to);
  };
}
