import { hexToRgb, linearToSrgb, normalizeHex, rgbToHex, rgbToLab, type Lab } from "../core";

const GOLDEN_ANGLE = 137.50776405003785; // degrees
// Lightness / chroma pairs the hue sequence cycles through, so colors with a similar hue
// can still be told apart by lightness.
const LEVELS: readonly [number, number][] = [[62, 58], [76, 42], [48, 56], [84, 30], [38, 44], [68, 70]];
const START_MIN_DELTA_E = 30;
const FAILS_BEFORE_RELAX = 400;

/** CIE L*a*b* (D65, the white point of the core's rgbToLab) to an sRGB hex, pulling chroma into the gamut. */
function lchToHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const finv = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  for (let chroma = C; ; chroma *= 0.92) {
    const fy = (L + 16) / 116, fx = fy + (chroma * Math.cos(h)) / 500, fz = fy - (chroma * Math.sin(h)) / 200;
    const X = 0.95047 * finv(fx), Y = finv(fy), Z = 1.08883 * finv(fz);
    const lin = [
      3.2406 * X - 1.5372 * Y - 0.4986 * Z,
      -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
      0.0557 * X - 0.204 * Y + 1.057 * Z,
    ];
    if (chroma < 1 || lin.every((v) => v >= -0.002 && v <= 1.002)) {
      return rgbToHex(lin.map((v) => linearToSrgb(Math.min(1, Math.max(0, v)))));
    }
  }
}

const labOf = (hex: string): Lab => rgbToLab(hexToRgb(hex));
const dist = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * `count` colors that differ from each other and from every color in `taken` by at least a
 * minimum CIE76 ΔE. Candidates walk the hue circle in golden-angle steps (so any prefix
 * of the sequence is spread evenly) while cycling lightness and chroma; a candidate too
 * close to a color already chosen is rejected. If the palette is crowded the minimum
 * relaxes gradually, but two returned colors are never identical.
 *
 * Deterministic: the result depends only on the arguments.
 */
export function generateDistinctColors(count: number, taken: readonly string[]): string[] {
  const labs = taken.map((h) => labOf(normalizeHex(h)));
  const out: string[] = [];
  let min = START_MIN_DELTA_E, fails = 0;
  for (let i = 0; out.length < count; i++) {
    const [L, C] = LEVELS[i % LEVELS.length];
    const hex = lchToHex(L, C, (i * GOLDEN_ANGLE) % 360);
    const lab = labOf(hex);
    if (labs.every((o) => dist(o, lab) >= Math.max(min, 1))) {
      out.push(hex);
      labs.push(lab);
      fails = 0;
    } else if (++fails >= FAILS_BEFORE_RELAX) {
      min *= 0.85;
      fails = 0;
    }
  }
  return out;
}
