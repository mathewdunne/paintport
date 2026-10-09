// What the Export tab and the Print view show of the mapping, as plain data. DOM- and React-free.
import { deltaE, normalizeHex, type MixCandidate, type MixSlot } from "@/core";
import {
  activeSpools, blendCandidates, blendKey, fileSpools, mappingWarnings, resolveColor, resolveMapping,
  type MappingPin, type MappingSettings, type MappingWarnings, type ResolvedTarget,
} from "@/doc/mapping";
import type { State } from "@/doc/paintField";
import type { Project } from "@/doc/project";
import { strings } from "@/strings";
import type { ExportSettings } from "@/persist/exportSettings";
import { printerCountOf } from "./spoolOps";

/** Everything the mapping tells about the used design colors. */
export interface MappingModel {
  states: readonly State[];
  resolved: ReadonlyMap<State, ResolvedTarget>;
  warnings: MappingWarnings;
}

export const toMappingSettings = (settings: ExportSettings): MappingSettings => ({
  spools: settings.spools,
  printerCount: printerCountOf(settings),
  allowMix: settings.allowMix,
});

/** Resolves the given used states and checks the result for warnings. */
export function computeMapping(project: Project, settings: ExportSettings, states: readonly State[]): MappingModel {
  const mapping = toMappingSettings(settings);
  const resolved = resolveMapping(project, mapping, states);
  return { states, resolved, warnings: mappingWarnings(project.palette, resolved, mapping, settings.target) };
}

/**
 * The color table of the Print view: for each design state the color it prints as (a spool's
 * color or a blend's predicted color), `undefined` where nothing maps it (the viewer then shows
 * the design color). Indexed by state, as `ModelViewer.setPrintColors` expects.
 */
export function printColorTable(paletteSize: number, resolved: ReadonlyMap<State, ResolvedTarget>): (string | undefined)[] {
  const out: (string | undefined)[] = new Array(paletteSize).fill(undefined);
  for (const [state, target] of resolved) {
    if (state >= 0 && state < paletteSize && target.kind !== "none") out[state] = target.color;
  }
  return out;
}

// --- dropdown rows --------------------------------------------------------------------------

const blendParts = (components: readonly { slot: number; ratio: number }[]): string =>
  components.map((c) => strings.export.blendParts(c.ratio, c.slot)).join(" + ");

/** How a mapping row names its target: a spool or a blend's parts. */
export function targetName(target: ResolvedTarget): string {
  if (target.kind === "spool") return strings.export.spoolName(target.slot);
  if (target.kind === "blend") return blendParts(target.components);
  return strings.export.noSpool;
}

/** Names a pin the same way. */
export const pinName = (pin: MappingPin): string => (pin.kind === "spool" ? strings.export.spoolName(pin.slot) : blendParts(pin.components));

/** The select value of the Auto option. */
export const AUTO_VALUE = "auto";
/**
 * The select value shown while the row has a pin that cannot be honored now (its spool is off, or
 * ColorMix is off): different from `AUTO_VALUE`, so that choosing Auto still fires and clears the pin.
 */
export const DORMANT_VALUE = "auto:dormant";
const spoolValue = (slot: number) => `spool:${slot}`;
const blendValue = (components: readonly { slot: number; ratio: number }[]) => `blend:${blendKey(components)}`;
/** The select value of a pin. */
export const pinValue = (pin: MappingPin): string => (pin.kind === "spool" ? spoolValue(pin.slot) : blendValue(pin.components));

/** One choice in a row's dropdown. */
export interface ChoiceOption {
  value: string;
  /** The pin it sets; null for Auto. */
  pin: MappingPin | null;
  label: string;
  /** Color it would print as and its ΔE to the design color; absent for Auto without a spool. */
  color?: string;
  deltaE?: number;
}

/** One used design color. */
export interface MappingRow {
  state: State;
  designColor: string;
  /** What the color prints as now (pin, imported recipe or Auto). */
  resolved: ResolvedTarget;
  /** What Auto alone would give (ignoring a pin). */
  auto: ResolvedTarget;
  /** The row's pin, honored or not. */
  pinned: MappingPin | undefined;
  /** The pin when it cannot be honored now (the row then shows Auto): its spool is off or above the printer's count, or ColorMix is off. */
  dormant: MappingPin | undefined;
  /** The dropdown value showing now: an honored pin, else Auto (or `DORMANT_VALUE` with a dormant pin). */
  value: string;
}

/** The rows of the used design colors: their current and Auto results. */
export function mappingRows(project: Project, settings: ExportSettings, model: MappingModel): MappingRow[] {
  const mapping = toMappingSettings(settings);
  const active = activeSpools(mapping.spools, mapping.printerCount);
  const fileColors = new Map(fileSpools(project.source).map((s) => [s.slot, s.color]));
  const rows: MappingRow[] = [];
  for (const state of model.states) {
    const entry = project.palette[state];
    const resolved = model.resolved.get(state);
    if (!entry || !resolved) continue;
    const pin = project.mapping.get(state);
    const dormant = pin && resolved.source !== "pin" ? pin : undefined;
    rows.push({
      state,
      designColor: normalizeHex(entry.color),
      resolved,
      auto: resolveColor(entry, undefined, mapping, fileColors, active),
      pinned: pin,
      dormant,
      value: resolved.source === "pin" && pin ? pinValue(pin) : dormant ? DORMANT_VALUE : AUTO_VALUE,
    });
  }
  return rows;
}

const candidateOption = (c: MixCandidate): ChoiceOption => {
  const pin: MappingPin = { kind: "blend", components: c.components.map((x) => ({ slot: x.slot, ratio: x.ratio })) };
  return {
    value: pinValue(pin),
    pin,
    label: blendParts(c.components),
    color: c.predicted,
    deltaE: c.deltaE,
  };
};

/**
 * The choices of a row's dropdown, in order: Auto, each active spool (with the ΔE of this design
 * color to it), then the best blends (when ColorMix is allowed). `blends` is false while the
 * dropdown is closed, because ranking the blends of every row is needed only when one opens.
 * A pinned blend that is not among the top candidates is added so the current choice is listed.
 */
export function rowChoices(row: MappingRow, active: readonly MixSlot[], allowMix: boolean, blends: boolean): { spools: ChoiceOption[]; blends: ChoiceOption[] } {
  const spools = active.map<ChoiceOption>((s) => ({
    value: spoolValue(s.slot),
    pin: { kind: "spool", slot: s.slot },
    label: strings.export.spoolName(s.slot),
    color: s.color,
    deltaE: deltaE(row.designColor, s.color),
  }));
  if (!blends || !allowMix) return { spools, blends: [] };
  const list = blendCandidates(row.designColor, active).map(candidateOption);
  const pinned = row.pinned;
  if (row.resolved.source === "pin" && pinned?.kind === "blend" && row.resolved.kind === "blend" && !list.some((o) => o.value === pinValue(pinned))) {
    list.unshift({ value: pinValue(pinned), pin: pinned, label: targetName(row.resolved), color: row.resolved.color, deltaE: row.resolved.deltaE });
  }
  return { spools, blends: list };
}
