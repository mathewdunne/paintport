// Fingerprint of a project's immutable geometry. The autosave stores geometry and paint
// separately; both carry this hash so a restore can tell that they belong together.

export interface HashableObject {
  vertices: Float64Array;
  tris: Int32Array;
  parts: readonly { firstTri: number; triCount: number; type: string }[];
}

function words(a: Float64Array | Int32Array): Uint32Array {
  return a.byteOffset % 4 === 0
    ? new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4)
    : new Uint32Array(a.slice().buffer);
}

/** 64-bit non-cryptographic hash (two FNV-style streams) of the geometry, as 16 hex digits. */
export function hashGeometry(objects: readonly HashableObject[]): string {
  let h1 = 0x811c9dc5, h2 = 0x9747b28c;
  const mix = (x: number): void => {
    h1 = Math.imul(h1 ^ x, 0x01000193);
    h2 = Math.imul(h2 ^ ((x + 0x9e3779b9) | 0), 0x85ebca6b);
    h2 ^= h2 >>> 15;
  };
  mix(objects.length);
  for (const o of objects) {
    mix(o.vertices.length);
    mix(o.tris.length);
    for (const w of words(o.vertices)) mix(w);
    for (const w of words(o.tris)) mix(w);
    mix(o.parts.length);
    for (const p of o.parts) {
      mix(p.firstTri);
      mix(p.triCount);
      for (let i = 0; i < p.type.length; i++) mix(p.type.charCodeAt(i));
    }
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** A fresh random project id. */
export function newProjectId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0")).join("");
}
