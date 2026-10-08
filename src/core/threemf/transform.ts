/** 3MF transform: 12 numbers, row-major 4x3; a point is `[x y z 1] * M`. */
export type Transform = number[];

export function applyTransform(t: Transform | null | undefined, x: number, y: number, z: number): [number, number, number] {
  if (!t) return [x, y, z];
  return [
    x * t[0] + y * t[3] + z * t[6] + t[9],
    x * t[1] + y * t[4] + z * t[7] + t[10],
    x * t[2] + y * t[5] + z * t[8] + t[11],
  ];
}

export function parseTransform(s: string | null | undefined): Transform | null {
  if (!s) return null;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 ? v : null;
}

/** Applies `b` first, then `a` (both 12-value row-major [R | T]). */
export function composeTransform(a: Transform | null, b: Transform | null): Transform | null {
  if (!a) return b;
  if (!b) return a;
  const r = new Array<number>(12);
  for (let col = 0; col < 3; col++) {
    r[0 + col] = b[0] * a[0 + col] + b[1] * a[3 + col] + b[2] * a[6 + col];
    r[3 + col] = b[3] * a[0 + col] + b[4] * a[3 + col] + b[5] * a[6 + col];
    r[6 + col] = b[6] * a[0 + col] + b[7] * a[3 + col] + b[8] * a[6 + col];
    r[9 + col] = b[9] * a[0 + col] + b[10] * a[3 + col] + b[11] * a[6 + col] + a[9 + col];
  }
  return r;
}
