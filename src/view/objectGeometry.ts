import { BufferAttribute, BufferGeometry } from "three";
import { applyTransform, hexToRgb, parseTransform } from "../core";
import type { ViewObject } from "./viewScene";

/** Palette colors as sRGB bytes, 3 per state. Unparseable hex values are neutral gray. */
export function paletteToBytes(palette: readonly string[]): Uint8Array {
  const out = new Uint8Array(palette.length * 3);
  palette.forEach((hex, i) => {
    const [r, g, b] = hexToRgb(hex);
    out[i * 3] = Math.round(r * 255);
    out[i * 3 + 1] = Math.round(g * 255);
    out[i * 3 + 2] = Math.round(b * 255);
  });
  return out;
}

const GRAY = 128;

/**
 * Non-indexed geometry of one object: 3 vertices per drawn triangle ("slot"), flat
 * per-triangle colors. `slotOfTri` maps a document triangle to its slot (-1 = not drawn),
 * so a color update touches only that triangle's 3 vertices.
 *
 * The color attribute holds sRGB bytes (precise for dark colors); the material converts
 * them to linear light in the vertex shader (see material.ts).
 */
export interface ObjectGeometry {
  geometry: BufferGeometry;
  /** The geometry's color attribute data (3 bytes per vertex). */
  colors: Uint8Array;
  slotOfTri: Int32Array;
  slotCount: number;
}

export function buildObjectGeometry(obj: ViewObject, paletteBytes: Uint8Array): ObjectGeometry {
  const { vertices, tris, mask, states } = obj;
  const triCount = tris.length / 3;

  // Build-item transform applied once per vertex, in double precision.
  const t = parseTransform(obj.transform);
  const nv = vertices.length / 3;
  const world = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const [x, y, z] = applyTransform(t, vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]);
    world[i * 3] = x; world[i * 3 + 1] = y; world[i * 3 + 2] = z;
  }

  const slotOfTri = new Int32Array(triCount).fill(-1);
  let slotCount = 0;
  for (let i = 0; i < triCount; i++) if (mask[i]) slotOfTri[i] = slotCount++;

  const position = new Float32Array(slotCount * 9);
  const color = new Uint8Array(slotCount * 9);
  for (let i = 0; i < triCount; i++) {
    const slot = slotOfTri[i];
    if (slot < 0) continue;
    for (let k = 0; k < 3; k++) {
      const v = tris[i * 3 + k] * 3;
      const o = slot * 9 + k * 3;
      position[o] = world[v]; position[o + 1] = world[v + 1]; position[o + 2] = world[v + 2];
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("color", new BufferAttribute(color, 3, true));
  const result: ObjectGeometry = { geometry, colors: color, slotOfTri, slotCount };
  for (let i = 0; i < triCount; i++) if (slotOfTri[i] >= 0) writeTriangleColor(result, i, states[i], paletteBytes);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return result;
}

function writeTriangleColor(g: ObjectGeometry, tri: number, state: number, paletteBytes: Uint8Array): void {
  const slot = g.slotOfTri[tri];
  if (slot < 0) return;
  const color = g.colors;
  const known = state * 3 + 2 < paletteBytes.length;
  const r = known ? paletteBytes[state * 3] : GRAY;
  const gr = known ? paletteBytes[state * 3 + 1] : GRAY;
  const b = known ? paletteBytes[state * 3 + 2] : GRAY;
  for (let k = 0; k < 3; k++) {
    const o = slot * 9 + k * 3;
    color[o] = r; color[o + 1] = gr; color[o + 2] = b;
  }
}

/**
 * Rewrites the colors of the given document triangles from `states` and flags the
 * changed vertex ranges (one per contiguous run of slots) for upload. Ranges accumulate
 * across calls until three.js uploads them on the next render, so several updates
 * between two renders all survive.
 */
export function updateTriangleColors(
  g: ObjectGeometry,
  states: Uint16Array,
  triIndices: ArrayLike<number>,
  paletteBytes: Uint8Array,
): void {
  const slots = new Int32Array(triIndices.length);
  let n = 0;
  for (let i = 0; i < triIndices.length; i++) {
    const tri = triIndices[i];
    const slot = g.slotOfTri[tri];
    if (slot === undefined || slot < 0) continue; // masked or out of range
    writeTriangleColor(g, tri, states[tri], paletteBytes);
    slots[n++] = slot;
  }
  if (n === 0) return;
  const sorted = slots.subarray(0, n).sort();
  const attr = g.geometry.getAttribute("color") as BufferAttribute;
  let runStart = sorted[0], prev = sorted[0];
  for (let i = 1; i <= n; i++) {
    const slot = i < n ? sorted[i] : -1;
    if (slot === prev || slot === prev + 1) { prev = slot; continue; }
    attr.addUpdateRange(runStart * 9, (prev - runStart + 1) * 9);
    runStart = prev = slot;
  }
  attr.needsUpdate = true;
}
