import type { Model } from "../core";
import { formatError } from "./errors";
import { singleMeshModel } from "./singleMesh";
import { IntList, VertexWelder } from "./weld";

const HEADER = 80;
const RECORD = 50; // normal (12) + 3 vertices (36) + attribute byte count (2)

function triangleCountField(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(HEADER, true);
}

function startsWithSolid(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  const word = "solid";
  for (let k = 0; k < word.length; k++) if ((bytes[i + k] | 0x20) !== word.charCodeAt(k)) return false;
  return true;
}

/** True if the start of the file has an ASCII-STL keyword (a binary header or body never should). */
function hasAsciiKeyword(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096)).toLowerCase();
  return head.includes("facet") || head.includes("vertex") || head.includes("endsolid");
}

/**
 * Binary or ASCII? Binary files may start with "solid" too (some exporters write it into
 * the 80-byte header), so the size check 84 + 50 * n == length decides first. A
 * solid-prefixed file with padding after the records, or one that is truncated, has no
 * ASCII keywords and is judged by its count field instead.
 */
export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER + 4) return false;
  const n = triangleCountField(bytes);
  if (HEADER + 4 + RECORD * n === bytes.length) return true;
  if (startsWithSolid(bytes) && hasAsciiKeyword(bytes)) return false;
  // Not text and not an exact match: tolerate padding after the last record.
  return n > 0 && HEADER + 4 + RECORD * n <= bytes.length;
}

/** Parses a binary or ASCII STL into a one-object Model. Units are taken as millimetres. */
export function parseStl(bytes: Uint8Array, name = "Model"): Model {
  const welder = new VertexWelder();
  const tris = new IntList();
  if (isBinaryStl(bytes)) readBinary(bytes, welder, tris);
  else if (startsWithSolid(bytes) && hasAsciiKeyword(bytes)) readAscii(bytes, welder, tris);
  else throw formatError("ERR_STL_INVALID");
  return singleMeshModel(name, welder.vertices(), tris.toArray(), () => formatError("ERR_STL_EMPTY"));
}

function readBinary(bytes: Uint8Array, welder: VertexWelder, tris: IntList): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = triangleCountField(bytes);
  const idx = [0, 0, 0];
  for (let t = 0; t < n; t++) {
    let o = HEADER + 4 + t * RECORD + 12; // skip the stored normal
    for (let k = 0; k < 3; k++, o += 12) {
      const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw formatError("ERR_STL_INVALID", `non-finite coordinate in triangle ${t}`);
      }
      idx[k] = welder.add(x, y, z);
    }
    tris.push(idx[0]); tris.push(idx[1]); tris.push(idx[2]);
  }
}

function readAscii(bytes: Uint8Array, welder: VertexWelder, tris: IntList): void {
  const text = new TextDecoder().decode(bytes);
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  let corner = 0;
  const idx = [0, 0, 0];
  while ((m = re.exec(text)) !== null) {
    const x = Number(m[1]), y = Number(m[2]), z = Number(m[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw formatError("ERR_STL_INVALID", `bad vertex "${m[0].slice(0, 60)}"`);
    }
    idx[corner++] = welder.add(x, y, z);
    if (corner === 3) {
      tris.push(idx[0]); tris.push(idx[1]); tris.push(idx[2]);
      corner = 0;
    }
  }
  if (corner !== 0) throw formatError("ERR_STL_INVALID", "vertex count is not a multiple of 3");
}
