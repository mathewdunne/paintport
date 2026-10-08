export type Rgb = [number, number, number];
export type Lab = [number, number, number];

/**
 * Normalizes any color value to "#RRGGBB" (upper case). Unparseable input becomes
 * neutral gray, because file content ends up in style attributes and must never pass
 * through unchecked. 8-digit values (Bambu writes RRGGBBAA) lose their alpha.
 */
export function normalizeHex(c: unknown): string {
  if (!c) return "#808080";
  let h = String(c).trim().replace(/^#/, "");
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  if (!/^[0-9a-fA-F]{1,6}$/.test(h)) return "#808080";
  return "#" + h.toUpperCase().padStart(6, "0").slice(0, 6);
}

export function hexToRgb(hex: string): Rgb {
  const h = normalizeHex(hex).slice(1);
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

export function rgbToHex(rgb: number[]): string {
  return "#" + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function rgbToLab(rgb: number[]): Lab {
  const [r, g, b] = rgb.map(srgbToLinear);
  let X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  X /= 0.95047; Z /= 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 color difference between two hex colors. */
export function deltaE(hexA: string, hexB: string): number {
  const a = rgbToLab(hexToRgb(hexA)), b = rgbToLab(hexToRgb(hexB));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
