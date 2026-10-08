import { deltaE, hexToRgb, linearToSrgb, rgbToHex, srgbToLinear } from "./color";

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
  const total = components.reduce((s, c) => s + c.ratio, 0);
  const YN = 2;
  const mixed = [0, 0, 0];
  for (const c of components) {
    const lin = hexToRgb(c.color).map(srgbToLinear);
    for (let i = 0; i < 3; i++) mixed[i] += (c.ratio / total) * Math.pow(lin[i], 1 / YN);
  }
  return rgbToHex(mixed.map((v) => linearToSrgb(Math.pow(v, YN))));
}

/**
 * ColorMix candidates for a target color (PrusaSlicer ratios: 1:1, 1:3, 3:1, 1:1:1),
 * sorted by deltaE and de-duplicated by predicted color.
 */
export function topMixes(targetHex: string, slots: MixSlot[], n = 6): MixCandidate[] {
  const seen = new Map<string, MixCandidate>(); // predicted hex -> best candidate with that color
  const consider = (comps: MixComponent[]) => {
    const hex = predictMix(comps);
    const d = deltaE(targetHex, hex);
    const prev = seen.get(hex);
    if (!prev || d < prev.deltaE) seen.set(hex, { components: comps, predicted: hex, deltaE: d });
  };
  for (let i = 0; i < slots.length; i++)
    for (let j = i + 1; j < slots.length; j++) {
      const A = slots[i], B = slots[j];
      consider([{ slot: A.slot, color: A.color, ratio: 1 }, { slot: B.slot, color: B.color, ratio: 1 }]);
      consider([{ slot: A.slot, color: A.color, ratio: 1 }, { slot: B.slot, color: B.color, ratio: 3 }]);
      consider([{ slot: A.slot, color: A.color, ratio: 3 }, { slot: B.slot, color: B.color, ratio: 1 }]);
      for (let k = j + 1; k < slots.length; k++)
        consider([
          { slot: A.slot, color: A.color, ratio: 1 },
          { slot: B.slot, color: B.color, ratio: 1 },
          { slot: slots[k].slot, color: slots[k].color, ratio: 1 },
        ]);
    }
  return [...seen.values()].sort((a, b) => a.deltaE - b.deltaE).slice(0, n);
}

export function bestMix(targetHex: string, slots: MixSlot[]): MixCandidate | null {
  return topMixes(targetHex, slots, 1)[0] || null;
}
