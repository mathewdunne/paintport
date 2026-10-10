import { useSyncExternalStore } from "react";
import type { PalettePrint } from "@/doc/palettePrint";
import { loadPalettePrints, savePalettePrints } from "@/persist/paletteSettings";

// The palette prints for the whole page (spec Q13.4): read from localStorage on first use, saved
// on every change. Module state, so it outlives the Export tab's unmounts.
let current: readonly PalettePrint[] | undefined;
const listeners = new Set<() => void>();

const getSnapshot = (): readonly PalettePrint[] => {
  if (current === undefined) current = loadPalettePrints();
  return current;
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Replaces the list and saves it; a refused save keeps it for this page view. */
function setPalettes(next: readonly PalettePrint[]): void {
  current = next;
  savePalettePrints(next);
  for (const l of [...listeners]) l();
}

/** The loaded palette prints, in the order they were added, and their setter. */
export function usePalettePrints() {
  const palettes = useSyncExternalStore(subscribe, getSnapshot);
  return { palettes, setPalettes };
}
