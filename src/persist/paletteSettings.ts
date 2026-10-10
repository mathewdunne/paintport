// The loaded palette print (spec Q13.4): one, kept in localStorage like the export settings.
// Only its dots are stored (a few KB), not the file. Every storage access is guarded; a stored
// palette that fails validation is ignored as a whole.
import { normalizeHex } from "../core";
import { MAX_PALETTE_NAME, type PaletteDot, type PaletteIngredient, type PalettePrint } from "../doc/palettePrint";
import { browserStorage, type KeyValueStorage } from "./exportSettings";

export const PALETTE_KEY = "paintportplus.palette";
const VERSION = 1;
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

/** The stored palette, or null when there is none or it is not valid. */
export function loadPalettePrint(storage: KeyValueStorage | null = browserStorage()): PalettePrint | null {
  if (!storage) return null;
  let o: unknown;
  try {
    const text = storage.getItem(PALETTE_KEY);
    if (text === null) return null;
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRec(o) || o.version !== VERSION || !isName(o.name) || !Array.isArray(o.dots) || o.dots.length < 1 || o.dots.length > MAX_DOTS) return null;
  const dots = o.dots.map(readDot);
  return dots.some((d) => d === null) ? null : { name: o.name, dots: dots as PaletteDot[] };
}

/** Stores the palette (null removes it). Returns false when the browser refused (it then lasts only for this page view). */
export function savePalettePrint(palette: PalettePrint | null, storage: PaletteStorage | null = browserStorage() as PaletteStorage | null): boolean {
  if (!storage) return false;
  try {
    if (palette) storage.setItem(PALETTE_KEY, JSON.stringify({ version: VERSION, name: palette.name, dots: palette.dots }));
    else storage.removeItem(PALETTE_KEY);
    return true;
  } catch {
    return false;
  }
}
