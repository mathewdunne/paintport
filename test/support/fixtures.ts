// Tiny in-memory meshes and STL writers for tests (not used by the app).

/** A triangle as 9 numbers: x1 y1 z1 x2 y2 z2 x3 y3 z3. */
export type Tri = number[];

const V = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const F = [
  [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
  [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
];

/** Unit cube: 12 triangles over 8 distinct corners. */
export const CUBE_TRIS: Tri[] = F.map((f) => f.flatMap((i) => V[i]));

export function binaryStl(tris: Tri[], header = "binary stl"): Uint8Array {
  const out = new Uint8Array(84 + 50 * tris.length);
  out.set(new TextEncoder().encode(header).subarray(0, 80));
  const dv = new DataView(out.buffer);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    const o = 84 + i * 50 + 12; // normal left at zero
    t.forEach((v, k) => dv.setFloat32(o + k * 4, v, true));
  });
  return out;
}

export function asciiStl(tris: Tri[], name = "part"): Uint8Array {
  const lines = [`solid ${name}`];
  for (const t of tris) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (let k = 0; k < 3; k++) lines.push(`      vertex ${t[k * 3]} ${t[k * 3 + 1]} ${t[k * 3 + 2]}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${name}`);
  return new TextEncoder().encode(lines.join("\n"));
}

/** UV sphere as binary STL with 2 * segments * (rings - 1) triangles. */
export function sphereStl(rings: number, segments: number, radius = 10): Uint8Array {
  const pt = (r: number, s: number) => {
    if (r === 0) return [0, 0, radius]; // exact poles, so they weld
    if (r === rings) return [0, 0, -radius];
    const phi = (Math.PI * r) / rings, theta = (2 * Math.PI * (s % segments)) / segments;
    return [radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi)];
  };
  const tris: Tri[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = pt(r, s), b = pt(r, s + 1), c = pt(r + 1, s), d = pt(r + 1, s + 1);
      if (r > 0) tris.push([...a, ...c, ...b]);
      if (r < rings - 1) tris.push([...b, ...c, ...d]);
    }
  }
  return binaryStl(tris);
}
