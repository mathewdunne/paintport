/** Brush radius range in world millimetres. */
export const MIN_RADIUS = 0.2;
export const MAX_RADIUS = 30;
/** About right for a figure around 100 mm tall. */
export const DEFAULT_RADIUS = 3;
/** Each `[` or `]` press multiplies or divides the radius by this. */
export const RADIUS_STEP = 1.25;

export const clampRadius = (r: number): number => (Number.isFinite(r) ? Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, r)) : DEFAULT_RADIUS);

/** Position on a logarithmic slider, 0..1. */
export function radiusToSlider(radius: number): number {
  return Math.log(clampRadius(radius) / MIN_RADIUS) / Math.log(MAX_RADIUS / MIN_RADIUS);
}

export function sliderToRadius(position: number): number {
  const p = Math.min(1, Math.max(0, position));
  return clampRadius(MIN_RADIUS * Math.pow(MAX_RADIUS / MIN_RADIUS, p));
}

/** The radius after a `[` (direction -1) or `]` (+1) press, rounded to two significant digits. */
export function stepRadius(radius: number, direction: -1 | 1): number {
  const next = clampRadius(radius * Math.pow(RADIUS_STEP, direction));
  return Number(next.toPrecision(2));
}

/** The number to show next to the radius slider, without the unit. */
export function formatRadius(radius: number): string {
  return radius < 10 ? radius.toFixed(1) : radius.toFixed(0);
}
