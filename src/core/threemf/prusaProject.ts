// PrusaSlicer project metadata (the classic tool ignored all of it): filament colors from
// Metadata/Slic3r_PE.config, ColorMix virtual extruders from
// Metadata/Prusa_Slicer_full_spectrum.json and per-object / per-volume base extruders from
// Metadata/Slic3r_PE_model.config. DOM-free, never throws: a malformed piece is skipped
// and the rest of the file still loads (like a broken Bambu project_settings.config).
import { normalizeHex } from "../color";
import type { MixComponentRef } from "../types";
import { parseAttrs } from "./xml";

/**
 * Highest extruder id a PrusaSlicer paint string can address (17 + an 8-bit escape field).
 * Every extruder number read from a Prusa file is clamped to this: virtual ids, color lists,
 * object and volume extruders. Larger values are invalid (inherit / 1 / ignored), so a hostile
 * file cannot make the loader allocate millions of filament slots.
 */
const MAX_EXTRUDER_ID = 272;

const HEX_COLOR = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * "#RRGGBB" for a plausible color value, else null. normalizeHex alone would turn garbage
 * into a "known" gray, but here an unreadable value has to count as not set.
 */
function colorOrNull(c: unknown): string | null {
  return typeof c === "string" && HEX_COLOR.test(c.trim()) ? normalizeHex(c) : null;
}

/**
 * Splits the value of a `; key = a;b;c` line of Slic3r_PE.config the way libslic3r writes a
 * string vector: entries are separated by `;`, an entry with spaces, `;` or quotes is
 * double-quoted with backslash escapes, and an empty entry is written as nothing at all
 * (`;;#FF0000`), except a vector whose only entry is empty, which is `""`. An unterminated
 * quote runs to the end of the value (the caller passes one line), never further. At most
 * `limit` entries are returned.
 */
export function splitConfigStrings(value: string, limit = Infinity): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < value.length && out.length < limit; i++) {
    const c = value[i];
    if (quoted) {
      if (c === "\\" && i + 1 < value.length) cur += value[++i];
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ";") { out.push(cur); cur = ""; }
    else cur += c;
  }
  if (out.length < limit) out.push(cur);
  return out.map((s) => s.trim());
}

/** The first MAX_EXTRUDER_ID entries of one `; key = ...` line, or [] when the key is absent. */
function configList(config: string, key: string): string[] {
  const m = new RegExp(`^;[ \\t]*${key}[ \\t]*=(.*)$`, "m").exec(config);
  return m ? splitConfigStrings(m[1], MAX_EXTRUDER_ID) : [];
}

const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_EXTRUDER_ID;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the Prusa filament metadata says about the extruders. */
export interface PrusaFilaments {
  /**
   * Color per extruder, index = id - 1: physical slots first, then the virtual (ColorMix)
   * ids. "" = no color known for that id (a physical slot without any color, or a gap in the
   * virtual ids).
   */
  colors: string[];
  /** ColorMix recipe per virtual id; components reference physical extruders. */
  mix: Map<number, MixComponentRef[]>;
}

/**
 * Filament colors and ColorMix recipes of a PrusaSlicer project, or null when the file has
 * neither.
 *
 * Physical slot colors, per slot, first hit wins:
 *  1. `extruder_colour` of Slic3r_PE.config (what PrusaSlicer shows when it is set),
 *  2. the matching `physical_extruders` entry of the full-spectrum JSON,
 *  3. `filament_colour` of Slic3r_PE.config (PrusaSlicer's own fallback for an empty
 *     extruder_colour; note that its default #FF8000 is a real value, not "unknown").
 * The JSON ranks above filament_colour because PrusaSlicer writes it from the effective
 * colors and, on opening the project, applies it over the printer's extruder_colour. It
 * ranks below extruder_colour because that line is the primary record and always lists
 * every slot; PrusaSlicer-written files agree on both (verified on a real INDX 4T file).
 * The number of physical slots is the longest of those lists.
 *
 * Virtual extruders need to know the physical count (their ids must lie above it), so
 * without any physical information they are ignored.
 */
export function readPrusaFilaments(config: string | null, fullSpectrum: string | null): PrusaFilaments | null {
  const extruderColours = config ? configList(config, "extruder_colour") : [];
  const filamentColours = config ? configList(config, "filament_colour") : [];

  let jsonRoot: Record<string, unknown> | null = null;
  if (fullSpectrum) {
    try {
      const j: unknown = JSON.parse(fullSpectrum);
      if (isRecord(j)) jsonRoot = j;
    } catch (e) { /* broken JSON -> no virtual extruders and no JSON colors */ }
  }

  const jsonPhysical = new Map<number, string>();
  if (jsonRoot && Array.isArray(jsonRoot.physical_extruders)) {
    for (const e of jsonRoot.physical_extruders as unknown[]) {
      if (!isRecord(e) || !isId(e.id)) continue;
      const color = colorOrNull(e.color);
      if (color && !jsonPhysical.has(e.id)) jsonPhysical.set(e.id, color);
    }
  }

  const physicalCount = Math.max(extruderColours.length, filamentColours.length, ...jsonPhysical.keys());
  if (physicalCount === 0) return null;
  const colors: string[] = [];
  for (let i = 0; i < physicalCount; i++) {
    colors.push(colorOrNull(extruderColours[i]) || jsonPhysical.get(i + 1) || colorOrNull(filamentColours[i]) || "");
  }

  const mix = new Map<number, MixComponentRef[]>();
  if (jsonRoot && Array.isArray(jsonRoot.virtual_extruders)) {
    for (const v of jsonRoot.virtual_extruders as unknown[]) {
      if (!isRecord(v) || !isId(v.id) || v.id <= physicalCount || mix.has(v.id)) continue;
      if (v.kind !== undefined && v.kind !== "fullspectrum") continue;
      const color = colorOrNull(v.color);
      if (!color || !Array.isArray(v.components) || !v.components.length) continue;
      const components: MixComponentRef[] = [];
      for (const c of v.components as unknown[]) {
        if (!isRecord(c) || typeof c.extruder !== "number" || !Number.isInteger(c.extruder)
          || c.extruder < 1 || c.extruder > physicalCount
          || typeof c.ratio !== "number" || !Number.isFinite(c.ratio) || c.ratio <= 0) break;
        components.push({ extruder: c.extruder, ratio: c.ratio });
      }
      if (components.length !== v.components.length) continue;
      while (colors.length < v.id) colors.push("");
      colors[v.id - 1] = color;
      mix.set(v.id, components);
    }
  }
  return { colors, mix };
}

/** One `<volume firstid=.. lastid=..>` of Slic3r_PE_model.config. */
export interface PrusaVolumeMeta {
  /** Triangle range of the volume inside the object's single mesh; null when unreadable. */
  firstid: number | null;
  lastid: number | null;
  /** Volume-level extruder; null = inherit the object's (absent, 0 or above MAX_EXTRUDER_ID). */
  extruder: number | null;
  /** The raw volume_type string; the caller validates it. */
  volumeType: string | null;
  name: string | null;
}

/** One `<object id=..>` of Slic3r_PE_model.config. */
export interface PrusaObjectMeta {
  name: string | null;
  /** Object-level extruder (1-based); 1 when absent or above MAX_EXTRUDER_ID. */
  extruder: number;
  volumes: PrusaVolumeMeta[];
}

/**
 * Scans `text` for `<name ...>` elements with indexOf instead of a lazy `[\s\S]*?` regex: a
 * file with many unterminated tags would make that regex quadratic. Yields the attribute
 * text and the body (empty for `<name .../>`). Stops at the first element without a
 * closing tag, so the scan is linear.
 */
function* elements(text: string, name: string): Generator<{ attrs: string; body: string }> {
  const open = "<" + name, close = "</" + name + ">";
  let pos = 0;
  for (;;) {
    const start = text.indexOf(open, pos);
    if (start < 0) return;
    const nameEnd = start + open.length;
    const next = text[nameEnd];
    if (next === undefined || !/[\s>/]/.test(next)) { pos = nameEnd; continue; }
    const gt = text.indexOf(">", nameEnd);
    if (gt < 0) return;
    const attrs = text.slice(nameEnd, gt);
    if (attrs.endsWith("/")) { yield { attrs, body: "" }; pos = gt + 1; continue; }
    const end = text.indexOf(close, gt + 1);
    if (end < 0) return;
    yield { attrs, body: text.slice(gt + 1, end) };
    pos = end + close.length;
  }
}

/** key -> value of the `<metadata type=T key=K value=..>` tags of a block (first one per key). */
function metaValues(block: string, type: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { attrs } of elements(block, "metadata")) {
    const a = parseAttrs(attrs);
    if (a.type === type && a.key !== undefined && a.value !== undefined && !out.has(a.key)) out.set(a.key, a.value);
  }
  return out;
}

/** An extruder number (1..MAX_EXTRUDER_ID) from a metadata value; null for anything else. */
function extruderOrNull(v: string | undefined): number | null {
  const n = parseInt(v ?? "", 10);
  return n >= 1 && n <= MAX_EXTRUDER_ID ? n : null;
}

/**
 * Per-object data of Slic3r_PE_model.config, keyed by the `id` that PrusaSlicer writes equal
 * to the `<object id>` of 3D/3dmodel.model (and the build item's objectid). Metadata of
 * layer ranges (`type="layer_config_range"`) is deliberately not read.
 */
export function parsePrusaModelConfig(config: string): Map<string, PrusaObjectMeta> {
  const objects = new Map<string, PrusaObjectMeta>();
  for (const { attrs, body } of elements(config, "object")) {
    const id = parseAttrs(attrs).id;
    if (id === undefined) continue;
    const volStart = body.indexOf("<volume");
    const head = metaValues(volStart < 0 ? body : body.slice(0, volStart), "object");
    const volumes: PrusaVolumeMeta[] = [];
    for (const v of elements(body, "volume")) {
      const va = parseAttrs(v.attrs);
      const vmeta = metaValues(v.body, "volume");
      const first = parseInt(va.firstid ?? "", 10), last = parseInt(va.lastid ?? "", 10);
      volumes.push({
        firstid: Number.isFinite(first) ? first : null,
        lastid: Number.isFinite(last) ? last : null,
        extruder: extruderOrNull(vmeta.get("extruder")),
        // PrusaSlicer < 2.4 had no volume_type: a modifier was `key="modifier" value="1"`.
        volumeType: vmeta.get("volume_type") ?? (vmeta.get("modifier") === "1" ? "ParameterModifier" : null),
        name: vmeta.get("name") ?? null,
      });
    }
    // Ids are unique in any file a slicer wrote; the first one wins otherwise.
    if (!objects.has(id)) objects.set(id, { name: head.get("name") ?? null, extruder: extruderOrNull(head.get("extruder")) ?? 1, volumes });
  }
  return objects;
}
