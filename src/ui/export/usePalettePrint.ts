import { useSyncExternalStore } from "react";
import type { PalettePrint } from "@/doc/palettePrint";
import { loadPalettePrint, savePalettePrint } from "@/persist/paletteSettings";

// One palette for the whole page (spec Q13.4): read from localStorage on first use, saved on
// every change. Module state, so it outlives the Export tab's unmounts.
let current: PalettePrint | null | undefined;
const listeners = new Set<() => void>();

const getSnapshot = (): PalettePrint | null => {
  if (current === undefined) current = loadPalettePrint();
  return current;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Replaces (or with null removes) the palette and saves it; a refused save keeps it for this page view. */
function setPalette(next: PalettePrint | null): void {
  current = next;
  savePalettePrint(next);
  for (const l of [...listeners]) l();
}

/** The loaded palette print and its setter. */
export function usePalettePrint() {
  const palette = useSyncExternalStore(subscribe, getSnapshot);
  return { palette, setPalette };
}
