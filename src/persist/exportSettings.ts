// Export settings that outlive a project (spec 3.2): the chosen target, the extruder count per
// target, the 16 spools and "Allow ColorMix". Kept in localStorage, like the classic tool's
// `paintport_slots` / `paintport_printerN`, which seed the first run (same origin, read only).
// Browser-facing but React-free; every storage access is guarded because localStorage can be
// missing, blocked or full (private windows, sandboxed frames).
import { normalizeHex } from "../core";
import {
  defaultSpools, EXPORT_TARGET_IDS, EXPORT_TARGETS, MAX_SPOOLS, type ExportSettings, type ExportTargetId, type Spool,
} from "../doc/mapping";

export type { ExportSettings } from "../doc/mapping";

export const EXPORT_SETTINGS_KEY = "paintportplus.export";
/** Keys of the classic tool (public/classic/index.html): read once to seed a first run, never written. */
export const CLASSIC_SLOTS_KEY = "paintport_slots";
export const CLASSIC_PRINTER_N_KEY = "paintport_printerN";

/** The part of the Storage interface used here; tests pass an in-memory one. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function defaultExportSettings(): ExportSettings {
  return {
    target: "prusa",
    printerCount: { prusa: EXPORT_TARGETS.prusa.defaultPrinterCount, bambu: EXPORT_TARGETS.bambu.defaultPrinterCount, snapmaker: EXPORT_TARGETS.snapmaker.defaultPrinterCount },
    spools: defaultSpools(),
    allowMix: true,
  };
}

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const clampCount = (n: number): number => Math.min(MAX_SPOOLS, Math.max(1, Math.trunc(n)));

function readPrinterCounts(raw: unknown, into: Record<ExportTargetId, number>): void {
  if (!isRec(raw)) return;
  for (const id of EXPORT_TARGET_IDS) {
    const n = raw[id];
    if (typeof n === "number" && Number.isFinite(n)) into[id] = clampCount(n);
  }
}

/** Reads `[{ <colorKey>: string, on: boolean }, ...]` over `spools`: the first 16 entries, field by field; bad entries keep their defaults. */
function readSpools(raw: unknown, colorKey: string, spools: Spool[]): void {
  if (!Array.isArray(raw)) return;
  raw.slice(0, MAX_SPOOLS).forEach((x, i) => {
    if (!isRec(x)) return;
    if (typeof x[colorKey] === "string") spools[i].color = normalizeHex(x[colorKey]);
    if (typeof x.on === "boolean") spools[i].on = x.on;
  });
}

/** The stored string parsed as JSON, or undefined when it is missing or not JSON. */
function parse(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function read(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** localStorage, or null where the browser denies even looking at it. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The saved settings. Anything missing, malformed or out of range falls back to its default
 * on its own (printer counts are clamped to 1..16, colors normalized). When the app has never
 * saved settings, the classic tool's spools and extruder counts are taken over once and saved
 * under the new key, so later changes in either tool stay separate.
 */
export function loadExportSettings(storage: KeyValueStorage | null = browserStorage()): ExportSettings {
  const settings = defaultExportSettings();
  if (!storage) return settings;
  const stored = read(storage, EXPORT_SETTINGS_KEY);
  if (stored !== null) {
    const o = parse(stored);
    if (isRec(o)) {
      if (typeof o.target === "string" && (EXPORT_TARGET_IDS as readonly string[]).includes(o.target)) settings.target = o.target as ExportTargetId;
      readPrinterCounts(o.printerCount, settings.printerCount);
      readSpools(o.spools, "color", settings.spools);
      if (typeof o.allowMix === "boolean") settings.allowMix = o.allowMix;
    }
    return settings;
  }
  const classicSlots = parse(read(storage, CLASSIC_SLOTS_KEY)), classicCounts = parse(read(storage, CLASSIC_PRINTER_N_KEY));
  if (classicSlots === undefined && classicCounts === undefined) return settings;
  readSpools(classicSlots, "c", settings.spools);
  readPrinterCounts(classicCounts, settings.printerCount);
  saveExportSettings(settings, storage);
  return settings;
}

/** Stores the settings. Returns false when the browser refused (the settings then last only for this page view). */
export function saveExportSettings(settings: ExportSettings, storage: KeyValueStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify({
      version: 1,
      target: settings.target,
      printerCount: settings.printerCount,
      spools: settings.spools.slice(0, MAX_SPOOLS).map((s) => ({ color: normalizeHex(s.color), on: s.on })),
      allowMix: settings.allowMix,
    }));
    return true;
  } catch {
    return false;
  }
}
