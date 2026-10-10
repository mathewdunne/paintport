import { hexToRgb, linearToSrgb, rgbToHex, rgbToLab, srgbToLinear } from "./color";

/** One input of a blend: a color and its relative share. */
export interface MixInput {
  color: string;
  ratio: number;
}

/** A physical spool slot (1-based) with its color. */
export interface MixSlot {
  slot: number;
  color: string;
}

export interface MixComponent extends MixSlot {
  ratio: number;
}

export interface MixCandidate {
  components: MixComponent[];
  predicted: string;
  deltaE: number;
}

/**
 * Yule-Nielsen approximation (n = 2) of the color of a layer-interleaved blend.
 * Rough preview only - PrusaSlicer's calibrated model (prusa-fdm-mixer, MIT) is more
 * accurate.
 */
export function predictMix(components: MixInput[]): string {
  return mixRoots(components.map((c) => ({ ratio: c.ratio, root: colorRoot(c.color) })));
}

const YN = 2;

/** A color's linear channels to the power 1 / YN, the per-color part of `predictMix`. */
const colorRoot = (hex: string): number[] => hexToRgb(hex).map(srgbToLinear).map((v) => Math.pow(v, 1 / YN));

/** `predictMix` from precomputed `colorRoot`s, with the same arithmetic in the same order. */
function mixRoots(components: readonly { ratio: number; root: readonly number[] }[]): string {
  const total = components.reduce((s, c) => s + c.ratio, 0);
  const mixed = [0, 0, 0];
  for (const c of components) for (let i = 0; i < 3; i++) mixed[i] += (c.ratio / total) * c.root[i];
  return rgbToHex(mixed.map((v) => linearToSrgb(Math.pow(v, YN))));
}

/** Blend ratios to try: for every pair of slots `pairs`, for every triple `triples` (weights in slot order). */
export interface MixRatioSet {
  readonly pairs: readonly (readonly [number, number])[];
  readonly triples: readonly (readonly [number, number, number])[];
}

/** The ratios PrusaSlicer offered when the classic tool was written: 1:1, 1:3, 3:1, 1:1:1. */
export const CLASSIC_MIX_RATIOS: MixRatioSet = {
  pairs: [[1, 1], [1, 3], [3, 1]],
  triples: [[1, 1, 1]],
};

/**
 * The classic ratios plus those of a full-spectrum test palette: 85/15 and 15/85 for two
 * slots; for three, one slot at 50 % and the other two at 15/35, 25/25 or 35/15. New entries
 * come after the classic ones, so a classic candidate keeps winning an exact tie.
 */
export const MIX_RATIOS: MixRatioSet = {
  pairs: [...CLASSIC_MIX_RATIOS.pairs, [17, 3], [3, 17]],
  triples: [
    ...CLASSIC_MIX_RATIOS.triples,
    [10, 3, 7], [2, 1, 1], [10, 7, 3],
    [3, 10, 7], [1, 2, 1], [7, 10, 3],
    [3, 7, 10], [1, 1, 2], [7, 3, 10],
  ],
};

interface MixEntry {
  components: MixComponent[];
  predicted: string;
  lab: number[];
}

/** The last candidate table, for `topMixes` calls with the same slots and ratio set. */
let lastTable: { key: string; ratios: MixRatioSet; entries: MixEntry[] } | null = null;

/**
 * Every blend of `slots` with the given ratios, one per predicted color (the first candidate in
 * generation order keeps a color), with the predicted color's Lab. Independent of any target.
 */
function mixTable(slots: MixSlot[], ratios: MixRatioSet): MixEntry[] {
  const key = JSON.stringify(slots.map((s) => [s.slot, s.color]));
  if (lastTable && lastTable.key === key && lastTable.ratios === ratios) return lastTable.entries;
  const seen = new Map<string, MixEntry>();
  const roots = slots.map((s) => colorRoot(s.color));
  /** `picks` are [slot index, ratio] pairs. */
  const consider = (picks: readonly (readonly [number, number])[]) => {
    const hex = mixRoots(picks.map(([k, ratio]) => ({ ratio, root: roots[k] })));
    if (seen.has(hex)) return;
    const components = picks.map(([k, ratio]) => ({ slot: slots[k].slot, color: slots[k].color, ratio }));
    seen.set(hex, { components, predicted: hex, lab: rgbToLab(hexToRgb(hex)) });
  };
  for (let i = 0; i < slots.length; i++)
    for (let j = i + 1; j < slots.length; j++) {
      for (const [a, b] of ratios.pairs) consider([[i, a], [j, b]]);
      for (let k = j + 1; k < slots.length; k++)
        for (const [a, b, c] of ratios.triples) consider([[i, a], [j, b], [k, c]]);
    }
  const entries = [...seen.values()];
  lastTable = { key, ratios, entries };
  return entries;
}

/**
 * ColorMix candidates for a target color (by default the classic ratios: 1:1, 1:3, 3:1, 1:1:1),
 * sorted by deltaE and de-duplicated by predicted color. Same results as running `predictMix`
 * and `deltaE` on every candidate, but the candidates are built once per slot set (`mixTable`):
 * of several candidates with the same predicted color the first one is kept, whatever the target.
 */
export function topMixes(targetHex: string, slots: MixSlot[], n = 6, ratios: MixRatioSet = CLASSIC_MIX_RATIOS): MixCandidate[] {
  const entries = mixTable(slots, ratios);
  const target = rgbToLab(hexToRgb(targetHex));
  const dist = (e: MixEntry) => Math.hypot(target[0] - e.lab[0], target[1] - e.lab[1], target[2] - e.lab[2]);
  const candidate = (e: MixEntry, d: number): MixCandidate => ({ components: e.components.map((c) => ({ ...c })), predicted: e.predicted, deltaE: d });
  if (n === 1) {
    // bestMix: the first entry with the smallest ΔE, as a stable sort would put it first.
    let best: MixEntry | null = null, bestD = Infinity;
    for (const e of entries) {
      const d = dist(e);
      if (!best || d < bestD) { best = e; bestD = d; }
    }
    return best ? [candidate(best, bestD)] : [];
  }
  return entries.map((e) => ({ e, d: dist(e) })).sort((a, b) => a.d - b.d).slice(0, n).map(({ e, d }) => candidate(e, d));
}

export function bestMix(targetHex: string, slots: MixSlot[], ratios: MixRatioSet = CLASSIC_MIX_RATIOS): MixCandidate | null {
  return topMixes(targetHex, slots, 1, ratios)[0] || null;
}
