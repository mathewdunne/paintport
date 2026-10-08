// Seeded PRNG for reproducible randomized tests. A failing run is replayed with the same
// PARITY_SEED; every parity failure message prints the seed.

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [lo, hi] (inclusive). */
  int(lo: number, hi: number): number;
  bool(p?: number): boolean;
  pick<T>(arr: readonly T[]): T;
  /** Random bytes; `compressible` repeats a short pattern so deflate actually shrinks it. */
  bytes(n: number, compressible?: boolean): Uint8Array;
  shuffle<T>(arr: T[]): T[];
}

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Independent stream per (seed, label), so adding a test does not shift other tests' data. */
export function makeRng(seed: number, label: string): Rng {
  const f = mulberry32((seed ^ hashString(label)) >>> 0);
  const rng: Rng = {
    next: f,
    int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)),
    bool: (p = 0.5) => f() < p,
    pick: (arr) => arr[Math.floor(f() * arr.length)],
    bytes(n, compressible = false) {
      const out = new Uint8Array(n);
      if (compressible) {
        const pat = Array.from({ length: rng.int(1, 8) }, () => rng.int(0, 255));
        for (let i = 0; i < n; i++) out[i] = pat[i % pat.length];
      } else {
        for (let i = 0; i < n; i++) out[i] = Math.floor(f() * 256);
      }
      return out;
    },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(f() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
  return rng;
}

function envNumber(name: string, fallback: number, ok: (n: number) => boolean, rule: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name}="${raw}" is invalid: it must be ${rule}`);
  return n;
}

export const PARITY_SEED = envNumber("PARITY_SEED", 20260101, () => true, "a finite number");
/** Multiplies the number of random cases (e.g. PARITY_SCALE=5). */
export const PARITY_SCALE = envNumber("PARITY_SCALE", 1, (n) => n > 0, "a finite number greater than 0");
