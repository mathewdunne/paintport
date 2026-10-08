import { BufferAttribute, BufferGeometry } from "three";
import { applyTransform, parseTransform } from "../core";
import type { ViewObject } from "./viewScene";

/**
 * Non-indexed geometry of one object: 3 vertices per drawn triangle ("slot"), flat
 * per-triangle design states. `slotOfTri` maps a document triangle to its slot (-1 = not
 * drawn), so a state update touches only that triangle's 3 vertices.
 *
 * The `state` attribute holds the triangle's resolved design state (Uint16, equal on its 3
 * vertices); the material looks the color up in the color table (see colorTable.ts and
 * material.ts), so recoloring a state never touches the geometry.
 */
export interface ObjectGeometry {
  geometry: BufferGeometry;
  /** The geometry's state attribute data (1 Uint16 per vertex). */
  vertexStates: Uint16Array;
  /** The geometry's highlight attribute data (1 byte per vertex, 255 = highlighted). */
  highlight: Uint8Array;
  slotOfTri: Int32Array;
  slotCount: number;
}

export function buildObjectGeometry(obj: ViewObject): ObjectGeometry {
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
  const vertexStates = new Uint16Array(slotCount * 3);
  geometry.setAttribute("state", new BufferAttribute(vertexStates, 1)); // read as a float in the shader
  const highlight = new Uint8Array(slotCount * 3);
  geometry.setAttribute("highlight", new BufferAttribute(highlight, 1, true));
  const result: ObjectGeometry = { geometry, vertexStates, highlight, slotOfTri, slotCount };
  for (let i = 0; i < triCount; i++) if (slotOfTri[i] >= 0) writeTriangleState(result, i, states[i]);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return result;
}

function writeTriangleState(g: ObjectGeometry, tri: number, state: number): void {
  const slot = g.slotOfTri[tri];
  if (slot < 0) return;
  g.vertexStates[slot * 3] = state; g.vertexStates[slot * 3 + 1] = state; g.vertexStates[slot * 3 + 2] = state;
}

/** Above this many triangles and share of the drawn ones, sorting for partial uploads is not worth it: upload everything. */
const WHOLE_UPLOAD_MIN = 4096;
const WHOLE_UPLOAD_SHARE = 0.25;

/**
 * Flags the vertex ranges of the given slots (`valuesPerSlot` vertex values each) for
 * upload, one range per contiguous run of slots. Ranges accumulate across calls until
 * three.js uploads them on the next render.
 */
function flagSlotRanges(g: ObjectGeometry, attr: BufferAttribute, slots: Int32Array, n: number, valuesPerSlot: number): void {
  if (n === 0) return;
  if (n > WHOLE_UPLOAD_MIN && n > g.slotCount * WHOLE_UPLOAD_SHARE) {
    attr.clearUpdateRanges(); // the whole attribute is uploaded, which covers any pending partial ranges
    attr.addUpdateRange(0, g.slotCount * valuesPerSlot);
    attr.needsUpdate = true;
    return;
  }
  const sorted = slots.subarray(0, n).sort();
  let runStart = sorted[0], prev = sorted[0];
  for (let i = 1; i <= n; i++) {
    const slot = i < n ? sorted[i] : -1;
    if (slot === prev || slot === prev + 1) { prev = slot; continue; }
    attr.addUpdateRange(runStart * valuesPerSlot, (prev - runStart + 1) * valuesPerSlot);
    runStart = prev = slot;
  }
  attr.needsUpdate = true;
}

/**
 * Rewrites the states of the given document triangles from `states` and flags the
 * changed vertex ranges (one per contiguous run of slots) for upload. Ranges accumulate
 * across calls until three.js uploads them on the next render, so several updates
 * between two renders all survive.
 */
export function updateTriangleStates(g: ObjectGeometry, states: Uint16Array, triIndices: ArrayLike<number>): void {
  const slots = new Int32Array(triIndices.length);
  let n = 0;
  for (let i = 0; i < triIndices.length; i++) {
    const tri = triIndices[i];
    const slot = g.slotOfTri[tri];
    if (slot === undefined || slot < 0) continue; // masked or out of range
    writeTriangleState(g, tri, states[tri]);
    slots[n++] = slot;
  }
  flagSlotRanges(g, g.geometry.getAttribute("state") as BufferAttribute, slots, n, 3);
}

/** Marks the given document triangles as highlighted (or not) for the region preview. */
export function setTriangleHighlight(g: ObjectGeometry, triIndices: ArrayLike<number>, on: boolean): void {
  const slots = new Int32Array(triIndices.length);
  const value = on ? 255 : 0;
  let n = 0;
  for (let i = 0; i < triIndices.length; i++) {
    const slot = g.slotOfTri[triIndices[i]];
    if (slot === undefined || slot < 0) continue;
    g.highlight[slot * 3] = value; g.highlight[slot * 3 + 1] = value; g.highlight[slot * 3 + 2] = value;
    slots[n++] = slot;
  }
  flagSlotRanges(g, g.geometry.getAttribute("highlight") as BufferAttribute, slots, n, 3);
}

/** True if the document triangle is currently highlighted. */
export function isTriangleHighlighted(g: ObjectGeometry, tri: number): boolean {
  const slot = g.slotOfTri[tri];
  return slot !== undefined && slot >= 0 && g.highlight[slot * 3] !== 0;
}

/** Rewrites every drawn triangle's state from `states` (after states were merged or renumbered). */
export function rebuildStates(g: ObjectGeometry, states: Uint16Array): void {
  for (let tri = 0; tri < g.slotOfTri.length; tri++) if (g.slotOfTri[tri] >= 0) writeTriangleState(g, tri, states[tri]);
  const attr = g.geometry.getAttribute("state") as BufferAttribute;
  attr.clearUpdateRanges(); // the whole attribute is uploaded, which covers any pending partial ranges
  attr.addUpdateRange(0, g.slotCount * 3);
  attr.needsUpdate = true;
}
