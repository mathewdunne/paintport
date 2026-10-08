export interface Point {
  x: number;
  y: number;
}

export interface DabPath {
  /** Where to dab, in order. The segment's start is not included (it was dabbed already). */
  points: Point[];
  /** Distance travelled since the last dab, to pass to the next call. */
  carry: number;
}

/**
 * Spaces brush dabs evenly along a pointer move, so a fast drag leaves a continuous line.
 * Works in screen pixels; the caller sizes `spacing` from the brush radius (about a third
 * of it). `carry` is the distance already travelled since the previous dab, so the spacing
 * stays even across successive calls. At most `maxPoints` dabs are returned: a very long
 * move gets wider spacing instead of a stall.
 */
export function interpolateDabs(from: Point, to: Point, spacing: number, carry: number, maxPoints = 64): DabPath {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(length > 0) || !(spacing > 0)) return { points: [], carry };
  const step = Math.max(spacing, length / maxPoints);
  const points: Point[] = [];
  let at = Math.max(0, step - carry); // distance along the segment to the next dab
  while (at <= length + 1e-9) {
    const t = at / length;
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    at += step;
  }
  // `at - step` is where the last dab sits along the segment (before its start if none was placed).
  return { points, carry: length - (at - step) };
}
