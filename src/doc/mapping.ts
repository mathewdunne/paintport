// Mapping design colors to physical spools and ColorMix blends (spec 3.2). DOM-free.
//
// Ported from the classic tool's mapping UI (public/classic/index.html: TARGETS, PRESETS,
// DEFAULT_SLOTS, bestOption, resolveTarget, updateResults, colorModeSuffix, isRelevantFilament)
// with the same decisions: the smaller ΔE wins between the nearest spool and the best blend,
// an exact tie keeps the spool, blends need at least two active spools.
//
// Spools are app settings, not project data; pins live on the Project. This module only
// computes: it reads a project and the current settings and returns plain data.
import {
  bestMix, deltaE, normalizeHex, predictMix, topMixes,
  type BuildTarget, type MixCandidate, type MixComponent, type MixComponentRef, type MixFormat, type MixSlot,
} from "../core";
import type { PaintFieldView, State } from "./paintField";
import { collectLeafStates, INTERNAL_DIALECT } from "./paintTree";
import { blendKey, MAX_SPOOLS, reduceRatios, type MappingPin } from "./pins";
import type { Project, SourceInfo } from "./project";
import type { DesignColor } from "./types";

export { blendKey, MAX_SPOOLS } from "./pins";
export type { BlendRatio, MappingPin } from "./pins";

// --- export targets and spool presets ---------------------------------------------------

export type ExportTargetId = "prusa" | "bambu" | "snapmaker";

export interface ExportTarget {
  id: ExportTargetId;
  /** Output flavor for `build3MF`: Bambu Studio and Snapmaker Orca share "bambu". */
  flavor: BuildTarget;
  /** File name suffix before the color mode suffix. */
  suffix: string;
  /** Extruder count until the user sets one. */
  defaultPrinterCount: number;
  /** Application metadata of the target slicer, pinned to its version (classic: ground truth 07/2026). */
  bbsApp?: string;
  mixFormat?: MixFormat;
}

export const EXPORT_TARGET_IDS: readonly ExportTargetId[] = ["prusa", "bambu", "snapmaker"];

export const EXPORT_TARGETS: Readonly<Record<ExportTargetId, ExportTarget>> = {
  prusa: { id: "prusa", flavor: "prusa", suffix: "_INDX", defaultPrinterCount: 8 },
  bambu: { id: "bambu", flavor: "bambu", suffix: "_bambu", defaultPrinterCount: 16, bbsApp: "BambuStudio-02.07.01.62", mixFormat: "bambu" },
  snapmaker: { id: "snapmaker", flavor: "bambu", suffix: "_snapmaker", defaultPrinterCount: 4, bbsApp: "BambuStudio-2.3.5", mixFormat: "snapmaker" },
};

/** A named set of spool colors for slots 1..n. The UI maps `id` to a label ("PANCHROMA" shows as a brand name). */
export interface SpoolPreset {
  id: string;
  colors: readonly string[];
}

/** CMY first, then K/W/RGB; PANCHROMA is Polymaker Panchroma Translucent CMYK (classic, 08/2026). */
export const SPOOL_PRESETS: readonly SpoolPreset[] = [
  { id: "CMY", colors: ["#00FFFF", "#FF00FF", "#FFFF00"] },
  { id: "CMYW", colors: ["#00FFFF", "#FF00FF", "#FFFF00", "#FFFFFF"] },
  { id: "CMYK", colors: ["#00FFFF", "#FF00FF", "#FFFF00", "#000000"] },
  { id: "CMYKW", colors: ["#00FFFF", "#FF00FF", "#FFFF00", "#000000", "#FFFFFF"] },
  { id: "CMYKWRGB", colors: ["#00FFFF", "#FF00FF", "#FFFF00", "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF"] },
  { id: "PANCHROMA", colors: ["#08ABFB", "#D93B90", "#F9ED3D", "#9199A4"] },
];

/** Colors of the 16 spools until the user changes them (classic DEFAULT_SLOTS). */
export const DEFAULT_SPOOL_COLORS: readonly string[] = [
  "#FFFFFF", "#000000", "#00FFFF", "#FF00FF", "#FFFF00", "#FF0000", "#00FF00", "#0000FF",
  "#FFA500", "#800080", "#808080", "#8B4513", "#F5F5DC", "#40E0D0", "#FFC0CB", "#556B2F",
];

/** Slots 1..5 start enabled (classic). */
const DEFAULT_SPOOLS_ON = 5;

// --- spools -------------------------------------------------------------------------------

/** One physical filament slot of the printer. `slot` is 1-based. */
export interface Spool {
  slot: number;
  color: string;
  on: boolean;
}

/** The 16 spools at their defaults. */
export function defaultSpools(): Spool[] {
  return DEFAULT_SPOOL_COLORS.map((color, i) => ({ slot: i + 1, color, on: i < DEFAULT_SPOOLS_ON }));
}

/** What mapping needs to know besides the project. */
export interface MappingSettings {
  spools: readonly Spool[];
  /** Extruder count of the chosen target: slots above it do not exist. */
  printerCount: number;
  allowMix: boolean;
}

/** The spools that are switched on and within the printer's extruder count, by slot, with normalized colors. */
export function activeSpools(spools: readonly Spool[], printerCount: number): MixSlot[] {
  return spools
    .filter((s) => s.on && s.slot >= 1 && s.slot <= printerCount)
    .map((s) => ({ slot: s.slot, color: normalizeHex(s.color) }))
    .sort((a, b) => a.slot - b.slot);
}

/** `spools` with slots 1..printerCount set from `colors` (slot -> color): those on with that color, the rest off. Slots above printerCount are left alone. */
function withSlotColors(spools: readonly Spool[], colors: ReadonlyMap<number, string>, printerCount: number): Spool[] {
  return spools.map((s) => {
    if (s.slot > printerCount) return { ...s };
    const color = colors.get(s.slot);
    return color === undefined ? { ...s, on: false } : { ...s, on: true, color: normalizeHex(color) };
  });
}

/**
 * Applies a preset to slots 1..printerCount (like the classic preset buttons). Colors beyond
 * the printer's slots are ignored; `truncated` says that happened, so the UI can warn.
 */
export function applyPreset(spools: readonly Spool[], preset: SpoolPreset, printerCount: number): { spools: Spool[]; truncated: boolean } {
  return {
    spools: withSlotColors(spools, new Map(preset.colors.map((c, i) => [i + 1, c])), printerCount),
    truncated: preset.colors.length > printerCount,
  };
}

/**
 * The file's physical extruder colors: filaments that are not ColorMix recipes and whose
 * color the file defines (a fallback gray is not a spool color), by slot.
 */
export function fileSpools(source: Pick<SourceInfo, "filaments">): MixSlot[] {
  return source.filaments
    .filter((f) => !f.mix && f.colorKnown && f.index >= 1 && f.index <= MAX_SPOOLS)
    .map((f) => ({ slot: f.index, color: normalizeHex(f.color) }))
    .sort((a, b) => a.slot - b.slot);
}

/** "Use this file's spools": those slots on with those colors, the other slots up to the printer's count off. */
export function applyFileSpools(spools: readonly Spool[], file: readonly MixSlot[], printerCount: number): Spool[] {
  return withSlotColors(spools, new Map(file.map((f) => [f.slot, f.color])), printerCount);
}

/** True if `applyFileSpools` would change something: the file defines spools and they are not what is set now. */
export function fileSpoolsDiffer(spools: readonly Spool[], file: readonly MixSlot[], printerCount: number): boolean {
  if (file.length === 0) return false;
  const current = new Map(spools.map((s) => [s.slot, s]));
  return applyFileSpools(spools, file, printerCount).some((s) => {
    const old = current.get(s.slot)!;
    return s.on !== old.on || (s.on && normalizeHex(s.color) !== normalizeHex(old.color));
  });
}

/**
 * File name suffix for the color mode: the preset id when the spools are exactly that preset
 * (slots 1..printerCount: the preset's slots on with its colors, everything else off), else
 * `_<n>T` with the number of active spools.
 */
export function colorModeSuffix(spools: readonly Spool[], printerCount: number): string {
  for (const preset of SPOOL_PRESETS) {
    let match = preset.colors.length <= printerCount;
    for (let slot = 1; match && slot <= printerCount; slot++) {
      const spool = spools.find((s) => s.slot === slot);
      const shouldBeOn = slot <= preset.colors.length;
      if (!!spool?.on !== shouldBeOn) match = false;
      else if (shouldBeOn && normalizeHex(spool!.color) !== preset.colors[slot - 1]) match = false;
    }
    if (match) return "_" + preset.id;
  }
  return `_${activeSpools(spools, printerCount).length}T`;
}

// --- resolving ------------------------------------------------------------------------------

export interface SpoolTarget {
  kind: "spool";
  slot: number;
  /** The spool's color. */
  color: string;
  /** ΔE between the design color and the spool. */
  deltaE: number;
}

export interface BlendTarget {
  kind: "blend";
  /** Sorted by slot, with the spools' current colors. */
  components: MixComponent[];
  /** Predicted color of the blend. */
  color: string;
  /** ΔE between the design color and the predicted color. */
  deltaE: number;
}

export type TargetChoice = SpoolTarget | BlendTarget;

/**
 * What a design color becomes at export, and where that came from: Auto (nearest spool or best
 * blend), a pin, or an imported ColorMix recipe hint. `none` means nothing can be chosen (no
 * active spool).
 */
export type ResolvedTarget = (TargetChoice & { source: "auto" | "pin" | "hint" }) | { kind: "none"; source: "auto" };

const spoolTarget = (spool: MixSlot, color: string): SpoolTarget => ({ kind: "spool", slot: spool.slot, color: spool.color, deltaE: deltaE(color, spool.color) });

const blendTarget = (components: MixComponent[], color: string): BlendTarget => {
  const predicted = predictMix(components);
  return { kind: "blend", components, color: predicted, deltaE: deltaE(color, predicted) };
};

/** Same, from a candidate that `topMixes`/`bestMix` computed. */
const candidateTarget = (c: MixCandidate): BlendTarget => ({ kind: "blend", components: c.components, color: c.predicted, deltaE: c.deltaE });

/**
 * Auto: the nearest active spool, or the best blend when its predicted ΔE is smaller (an exact
 * tie keeps the spool, which is the simpler print; a blend needs at least two active spools
 * and `allowMix`). Null without any active spool. Port of the classic `bestOption`.
 */
export function bestOption(color: string, active: readonly MixSlot[], allowMix: boolean): TargetChoice | null {
  let best: { d: number; spool: MixSlot } | null = null;
  for (const spool of active) {
    const d = deltaE(color, spool.color);
    if (!best || d < best.d) best = { d, spool };
  }
  if (!best) return null;
  if (allowMix && active.length >= 2) {
    const mix = bestMix(color, active as MixSlot[]);
    if (mix && mix.deltaE < best.d) return candidateTarget(mix);
  }
  return spoolTarget(best.spool, color);
}

/** The ColorMix candidates for the dropdown: the best `n` blends by ΔE (empty with fewer than two active spools). */
export function blendCandidates(color: string, active: readonly MixSlot[], n = 6): MixCandidate[] {
  return topMixes(color, active as MixSlot[], n);
}

/** A pin's target now, or null if the pin cannot be honored (slot off or out of range, a blend component missing, blends not allowed). */
function resolvePin(pin: MappingPin, color: string, active: readonly MixSlot[], allowMix: boolean): TargetChoice | null {
  if (pin.kind === "spool") {
    const spool = active.find((s) => s.slot === pin.slot);
    return spool ? spoolTarget(spool, color) : null;
  }
  if (!allowMix) return null;
  const components: MixComponent[] = [];
  for (const c of pin.components) {
    const spool = active.find((s) => s.slot === c.slot);
    if (!spool) return null;
    components.push({ slot: c.slot, color: spool.color, ratio: c.ratio });
  }
  return components.length >= 2 ? blendTarget(components, color) : null;
}

/** The file's physical extruder colors by extruder number (normalized), the reference for recipe hints. */
function filePhysicalColors(source: Pick<SourceInfo, "filaments">): Map<number, string> {
  return new Map(fileSpools(source).map((s) => [s.slot, s.color]));
}

/**
 * An imported ColorMix recipe, if the user's spools still reproduce it: every component's
 * extruder is an active spool whose color equals the file's physical color for that extruder.
 * Needs `allowMix` and at least two components with distinct extruders and integer ratios
 * 1..100 (anything else falls back to Auto). Ratios are reduced like a pin's (2:2 is 1:1).
 */
function resolveHint(mix: readonly MixComponentRef[] | undefined, color: string, fileColors: ReadonlyMap<number, string>, active: readonly MixSlot[], allowMix: boolean): BlendTarget | null {
  if (!allowMix || !mix || mix.length < 2) return null;
  const components: MixComponent[] = [];
  for (const m of mix) {
    if (!Number.isInteger(m.ratio) || m.ratio < 1 || m.ratio > 100 || components.some((c) => c.slot === m.extruder)) return null;
    const spool = active.find((s) => s.slot === m.extruder);
    if (!spool || fileColors.get(m.extruder) !== spool.color) return null;
    components.push({ slot: m.extruder, color: spool.color, ratio: m.ratio });
  }
  components.sort((a, b) => a.slot - b.slot);
  const ratios = reduceRatios(components);
  return blendTarget(components.map((c, i) => ({ ...c, ratio: ratios[i] })), color);
}

/**
 * Resolves one design color. Order: a valid pin; else the imported recipe hint; else Auto.
 * A pin that cannot be honored (its spool is off or above the printer's extruder count, a blend
 * component is missing, or ColorMix is off) falls back as if it were not there.
 */
export function resolveColor(
  entry: DesignColor,
  pin: MappingPin | undefined,
  settings: MappingSettings,
  fileColors: ReadonlyMap<number, string>,
  active: readonly MixSlot[] = activeSpools(settings.spools, settings.printerCount),
): ResolvedTarget {
  const color = normalizeHex(entry.color);
  if (pin) {
    const pinned = resolvePin(pin, color, active, settings.allowMix);
    if (pinned) return { ...pinned, source: "pin" };
  }
  const hint = resolveHint(entry.mix, color, fileColors, active, settings.allowMix);
  if (hint) return { ...hint, source: "hint" };
  const auto = bestOption(color, active, settings.allowMix);
  return auto ? { ...auto, source: "auto" } : { kind: "none", source: "auto" };
}

/**
 * Design states that need a mapping, ascending: painted anywhere (including leaves that exist
 * only inside preserved split trees), or the base color of any ModelPart or ParameterModifier
 * (even when painted over completely, since export writes it as the part's extruder). Port of
 * the classic `isRelevantFilament`/`usesPartExtruder`.
 */
export function usedStates(project: Project): State[] {
  const used = new Set<State>();
  for (const s of project.baseColor.values()) if (s > 0) used.add(s);
  project.fields.forEach((field) => {
    const states = field.displayStates();
    let last = 0; // consecutive equal states are common
    for (let t = 0; t < states.length; t++) {
      const s = states[t];
      if (s > 0 && s !== last) { used.add(s); last = s; }
    }
    for (const tree of preservedTrees(field)) collectLeafStates(tree, INTERNAL_DIALECT, used);
  });
  return [...used].sort((a, b) => a - b);
}

/**
 * The preserved sub-triangle paint trees of a field (design states, internal dialect).
 * TODO: read `preserved` through a proper accessor on PaintFieldView once trianglePaintField.ts
 * can be changed; the structural cast keeps this module independent of the concrete field class.
 */
function preservedTrees(field: PaintFieldView): Iterable<string> {
  const preserved = (field as { preserved?: ReadonlyMap<number, string> }).preserved;
  return preserved ? preserved.values() : [];
}

/**
 * The target of each given design state (default: the used ones). The map is in state order.
 * Auto follows color and spool edits, so call it again after any of them.
 */
export function resolveMapping(project: Project, settings: MappingSettings, states: readonly State[] = usedStates(project)): Map<State, ResolvedTarget> {
  const active = activeSpools(settings.spools, settings.printerCount);
  const fileColors = filePhysicalColors(project.source);
  const out = new Map<State, ResolvedTarget>();
  for (const s of states) out.set(s, resolveColor(project.palette[s], project.mapping.get(s), settings, fileColors, active));
  return out;
}

// --- warnings -------------------------------------------------------------------------------

export interface MappingWarnings {
  /** Pairs of design colors that are clearly different (ΔE > 15) but end up nearly the same (ΔE < 10). */
  collisions: [State, State][];
  /** Blends with a poor match (ΔE > 40) while the printer still has free extruder slots: a real spool would beat them. */
  poorBlends: { states: State[]; freeSlots: number } | null;
  /** Bambu's 16-filament cap: highest active slot plus distinct blend recipes would exceed it. */
  bambuLimit: { total: number } | null;
}

/** The warnings of a resolved mapping (port of the checks in the classic `updateResults`). */
export function mappingWarnings(
  palette: readonly DesignColor[],
  resolved: ReadonlyMap<State, ResolvedTarget>,
  settings: MappingSettings,
  target: ExportTargetId,
): MappingWarnings {
  const rows = [...resolved].filter(([, t]) => t.kind !== "none").sort((a, b) => a[0] - b[0]) as [State, TargetChoice][];
  const collisions: [State, State][] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const [sa, ta] = rows[i], [sb, tb] = rows[j];
      if (deltaE(palette[sa].color, palette[sb].color) > 15 && deltaE(ta.color, tb.color) < 10) collisions.push([sa, sb]);
    }
  }
  const active = activeSpools(settings.spools, settings.printerCount);
  const freeSlots = settings.printerCount - active.length;
  const poor = rows.filter(([, t]) => t.kind === "blend" && t.deltaE > 40).map(([s]) => s);
  const recipes = new Set(rows.flatMap(([, t]) => (t.kind === "blend" ? [blendKey(t.components)] : [])));
  const highest = active.length ? Math.max(...active.map((s) => s.slot)) : 0;
  const total = highest + recipes.size;
  const over = EXPORT_TARGETS[target].mixFormat === "bambu" && recipes.size > 0 && total > 16;
  return {
    collisions,
    poorBlends: freeSlots > 0 && poor.length ? { states: poor, freeSlots } : null,
    bambuLimit: over ? { total } : null,
  };
}
