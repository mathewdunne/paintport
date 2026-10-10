// The loaded palette prints (spec Q13.4), kept in localStorage like the export settings. Only
// their dots are stored (a few KB each), not the files. Every storage access is guarded; a
// stored palette that fails validation is dropped as a whole, the others are kept.
import { normalizeHex } from "../core";
import { MAX_PALETTE_NAME, type PaletteDot, type PaletteIngredient, type PalettePrint } from "../doc/palettePrint";
import { browserStorage, type KeyValueStorage } from "./exportSettings";

export const PALETTE_KEY = "paintportplus.palette";
const VERSION = 2;
/** Version 1 held a single palette as the record itself. */
const VERSION_SINGLE = 1;
export const MAX_PALETTES = 20;
const MAX_DOTS = 1000;
const MAX_INGREDIENTS = 16;

/** The Storage calls used here; tests pass an in-memory one. */
export interface PaletteStorage extends KeyValueStorage {
  removeItem(key: string): void;
}

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isName = (x: unknown): x is string => typeof x === "string" && x.length <= MAX_PALETTE_NAME;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isHex = (x: unknown): x is string => typeof x === "string" && normalizeHex(x) === x;

function readIngredient(x: unknown): PaletteIngredient | null {
  if (!isRec(x) || !isHex(x.color) || !Number.isInteger(x.weight)) return null;
  const weight = x.weight as number;
  return weight >= 1 && weight <= 100 ? { color: x.color, weight } : null;
}

function readDot(x: unknown): PaletteDot | null {
  if (!isRec(x) || !isName(x.name) || !isNum(x.x) || !isNum(x.y) || !isNum(x.r) || !isNum(x.top) || !(x.r > 0)) return null;
  if (!isHex(x.color) || typeof x.backdrop !== "boolean" || !Array.isArray(x.ingredients)) return null;
  if (x.ingredients.length < 1 || x.ingredients.length > MAX_INGREDIENTS) return null;
  const ingredients = x.ingredients.map(readIngredient);
  if (ingredients.some((i) => i === null)) return null;
  return { name: x.name, x: x.x, y: x.y, r: x.r, top: x.top, color: x.color, ingredients: ingredients as PaletteIngredient[], backdrop: x.backdrop };
}

function readPalette(x: unknown): PalettePrint | null {
  if (!isRec(x) || !isName(x.name) || !Array.isArray(x.dots) || x.dots.length < 1 || x.dots.length > MAX_DOTS) return null;
  const dots = x.dots.map(readDot);
  return dots.some((d) => d === null) ? null : { name: x.name, dots: dots as PaletteDot[] };
}

/** The stored palettes in the order they were added; empty when there are none. */
export function loadPalettePrints(storage: KeyValueStorage | null = browserStorage()): PalettePrint[] {
  if (!storage) return [];
  let o: unknown;
  try {
    const text = storage.getItem(PALETTE_KEY);
    if (text === null) return [];
    o = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRec(o)) return [];
  if (o.version === VERSION_SINGLE) {
    const single = readPalette(o);
    return single ? [single] : [];
  }
  if (o.version !== VERSION || !Array.isArray(o.palettes)) return [];
  return o.palettes.slice(0, MAX_PALETTES).map(readPalette).filter((p): p is PalettePrint => p !== null);
}

/** Stores the palettes (an empty list removes the key). Returns false when the browser refused (they then last only for this page view). */
export function savePalettePrints(palettes: readonly PalettePrint[], storage: PaletteStorage | null = browserStorage() as PaletteStorage | null): boolean {
  if (!storage) return false;
  try {
    if (palettes.length > 0) storage.setItem(PALETTE_KEY, JSON.stringify({ version: VERSION, palettes: palettes.map((p) => ({ name: p.name, dots: p.dots })) }));
    else storage.removeItem(PALETTE_KEY);
    return true;
  } catch {
    return false;
  }
}
