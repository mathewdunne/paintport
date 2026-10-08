import { hexToRgb, srgbToLinear } from "@/core";

/**
 * Reads a hex color typed by the user: "#abc", "abc", "#aabbcc" or "aabbcc", any case, with
 * surrounding spaces. Returns "#RRGGBB", or null if it isn't one (stricter than the core's
 * `normalizeHex`, which pads short values, so a half-typed "ab" must not count).
 */
export function parseHexInput(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return "#" + h.toUpperCase();
}

/**
 * The color to preview while the user is still typing: only a complete six-digit value counts
 * (a shorthand like "1a2" is also the start of a six-digit value and applies on Enter or blur).
 */
export function liveHexInput(text: string): string | null {
  return /^\s*#?[0-9a-f]{6}\s*$/i.test(text) ? parseHexInput(text) : null;
}

/** Black or white, whichever reads better on top of `hex` (for a check mark or a number on a swatch). */
export function readableOn(hex: string): "#000000" | "#FFFFFF" {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // The crossover where black and white have equal contrast is about 0.179.
  return luminance > 0.179 ? "#000000" : "#FFFFFF";
}
