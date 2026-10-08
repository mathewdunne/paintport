// Keeping the active color on the same color when the palette is renumbered: a color is
// deleted (its states are merged away and the later ones shift down), or that is undone or
// redone. Pure functions over palettes; the Paint tab's settings hook applies them.
import type { DesignColor } from "@/doc/project";

/** The active state to use after the palette changed from `before` to `after` without edits to the active color itself. */
export function remapActiveState(active: number, before: readonly DesignColor[], after: readonly DesignColor[]): number {
  const last = after.length - 1;
  if (last < 1) return 1; // no colors at all: the settings keep 1, and the UI shows nothing selected
  // Palette entries are immutable values that the document reuses (deleting, undoing and redoing keep
  // the surviving entries as they were), so the same object marks the same color.
  const indexOf = new Map<DesignColor, number>();
  for (let s = 1; s < after.length; s++) indexOf.set(after[s], s);
  const same = indexOf.get(before[active]);
  if (same !== undefined) return same;
  // The active color is gone (deleted), or was changed within the same step: the nearest earlier color that
  // survived, else the nearest later one.
  for (let s = active - 1; s >= 1; s--) {
    const to = indexOf.get(before[s]);
    if (to !== undefined) return to;
  }
  for (let s = active + 1; s < before.length; s++) {
    const to = indexOf.get(before[s]);
    if (to !== undefined) return to;
  }
  return Math.min(Math.max(active, 1), last);
}

/** Keeps the active state inside the palette (e.g. after undoing the addition of the active color). */
export function clampActiveState(active: number, paletteLength: number): number {
  return Math.min(Math.max(active, 1), Math.max(paletteLength - 1, 1));
}

/** Where a state ends up after `deleteColor(deleted, ...)` renumbered the palette (`deleted` itself maps to 0). */
export function stateAfterDelete(state: number, deleted: number): number {
  return state === deleted ? 0 : state > deleted ? state - 1 : state;
}

/**
 * The active state after the user deleted `deleted` by merging it into `mergeInto` (0 = base).
 * If the active color was the deleted one, the surface now shows `mergeInto`, so that becomes
 * active; merging into base leaves the previous color (or the next, for the first) active.
 */
export function activeAfterDelete(active: number, deleted: number, mergeInto: number): number {
  if (active !== deleted) return stateAfterDelete(active, deleted);
  if (mergeInto > 0) return stateAfterDelete(mergeInto, deleted);
  return deleted > 1 ? deleted - 1 : 1;
}
