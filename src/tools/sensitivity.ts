// Smart fill settings. The panel shows one "edge sensitivity" slider; under Advanced it shows
// the edge angle it sets and the feature size (automatic per mesh, adjusted at the extremes).

/** Default edge angle: fills a pupil cleanly on a 0.08 mm sculpt (spec Q9.2). */
export const DEFAULT_SMART_ANGLE = 20;
/** Feature size: null = automatic per mesh (`autoFeatureScale`), 0 = off, otherwise world millimetres. */
export const DEFAULT_SMART_SCALE: number | null = null;
export const MAX_SMART_ANGLE = 90;
export const MAX_SMART_SCALE = 1;

// The sensitivity slider runs from LOOSE_ANGLE (0) through the default (the middle) to STRICT_ANGLE (1),
// linear on each half, so the useful low angles get the finer half of the slider.
const LOOSE_ANGLE = 60;
const STRICT_ANGLE = 5;
const SCALE_EXTREME = 0.25;

const clampSensitivity = (position: number): number =>
  Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0.5));

/** The edge angle for a sensitivity position 0..1 (higher = stops at fainter grooves), to 0.1 degree. */
export function sensitivityToAngle(position: number): number {
  const p = clampSensitivity(position);
  const angle = p <= 0.5
    ? LOOSE_ANGLE + (DEFAULT_SMART_ANGLE - LOOSE_ANGLE) * (p / 0.5)
    : DEFAULT_SMART_ANGLE + (STRICT_ANGLE - DEFAULT_SMART_ANGLE) * ((p - 0.5) / 0.5);
  return Math.round(angle * 10) / 10;
}

/**
 * Feature size in world millimetres: keep the mesh's automatic size in the middle half,
 * blend up to at least 1 mm at Bigger regions, and down to edge-by-edge at Finer details.
 * Resolve per mesh so moving the slider never freezes one object's automatic size for all others.
 */
export function sensitivityToScale(position: number, autoScale: number): number {
  const p = clampSensitivity(position);
  if (p < SCALE_EXTREME) {
    return autoScale + (Math.max(MAX_SMART_SCALE, autoScale) - autoScale) * (1 - p / SCALE_EXTREME);
  }
  if (p > 1 - SCALE_EXTREME) return autoScale * ((1 - p) / SCALE_EXTREME);
  return autoScale;
}

/** The sensitivity position 0..1 for an edge angle; angles outside the slider's range sit at its ends. */
export function angleToSensitivity(angle: number): number {
  const a = Math.min(LOOSE_ANGLE, Math.max(STRICT_ANGLE, Number.isFinite(angle) ? angle : DEFAULT_SMART_ANGLE));
  return a >= DEFAULT_SMART_ANGLE
    ? (0.5 * (LOOSE_ANGLE - a)) / (LOOSE_ANGLE - DEFAULT_SMART_ANGLE)
    : 0.5 + (0.5 * (DEFAULT_SMART_ANGLE - a)) / (DEFAULT_SMART_ANGLE - STRICT_ANGLE);
}

export const clampSmartAngle = (angle: number): number =>
  Number.isFinite(angle) ? Math.min(MAX_SMART_ANGLE, Math.max(0, angle)) : DEFAULT_SMART_ANGLE;

/** A manual feature size clamped to the slider, or null (automatic) for anything that is not a number. */
export const clampSmartScale = (scale: number | null): number | null =>
  typeof scale === "number" && Number.isFinite(scale) ? Math.min(MAX_SMART_SCALE, Math.max(0, scale)) : null;
