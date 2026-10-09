// Paint tool settings that outlive a page view: the slider values (brush size, smart fill edge
// angle and feature size) and whether the smart fill Advanced section is open. Kept in
// localStorage like the export settings; every access is guarded the same way.
import { clampRadius, DEFAULT_RADIUS } from "../tools/radius";
import { clampSmartAngle, clampSmartScale, DEFAULT_SMART_ANGLE, DEFAULT_SMART_SCALE } from "../tools/sensitivity";
import { browserStorage, type KeyValueStorage } from "./exportSettings";

export const PAINT_SETTINGS_KEY = "paintportplus.paint";

export interface PaintPrefs {
  /** Brush radius, world millimetres. */
  radius: number;
  smartAngle: number;
  /** null = automatic per mesh. */
  smartScale: number | null;
  fillAdvancedOpen: boolean;
}

export function defaultPaintPrefs(): PaintPrefs {
  return { radius: DEFAULT_RADIUS, smartAngle: DEFAULT_SMART_ANGLE, smartScale: DEFAULT_SMART_SCALE, fillAdvancedOpen: false };
}

/** The saved preferences; anything missing or malformed keeps its default on its own, numbers are clamped. */
export function loadPaintPrefs(storage: KeyValueStorage | null = browserStorage()): PaintPrefs {
  const prefs = defaultPaintPrefs();
  let o: unknown;
  try {
    const text = storage?.getItem(PAINT_SETTINGS_KEY);
    o = text ? JSON.parse(text) : undefined;
  } catch {
    return prefs;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return prefs;
  const r = o as Record<string, unknown>;
  if (typeof r.radius === "number") prefs.radius = clampRadius(r.radius);
  if (typeof r.smartAngle === "number") prefs.smartAngle = clampSmartAngle(r.smartAngle);
  if (typeof r.smartScale === "number" || r.smartScale === null) prefs.smartScale = clampSmartScale(r.smartScale);
  if (typeof r.fillAdvancedOpen === "boolean") prefs.fillAdvancedOpen = r.fillAdvancedOpen;
  return prefs;
}

/** Stores the preferences. Returns false when the browser refused. */
export function savePaintPrefs(prefs: PaintPrefs, storage: KeyValueStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(PAINT_SETTINGS_KEY, JSON.stringify({ version: 1, ...prefs }));
    return true;
  } catch {
    return false;
  }
}
