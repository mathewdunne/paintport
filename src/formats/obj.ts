import type { Model } from "../core";
import { formatError } from "./errors";
import { singleMeshModel } from "./singleMesh";
import { IntList, VertexWelder } from "./weld";

const isWs = (c: number) => c === 0x20 || c === 0x09;

/**
 * Parses a Wavefront OBJ into a one-object Model. Only `v` and `f` lines count; texture
 * coordinates, normals, materials, groups and object names are ignored. Faces use
 * 1-based or negative (relative) indices in any of the v, v/vt, v//vn, v/vt/vn forms and
 * polygons are fan-triangulated. Positions are welded, so vertices that differ only in
 * their vt/vn become one. Units are taken as millimetres.
 */
export function parseObj(bytes: Uint8Array, name = "Model"): Model {
  let text = new TextDecoder().decode(bytes);
  if (text.includes("\\")) text = text.replace(/\\\r?\n/g, " "); // line continuations

  // OBJ vertex number -> welded vertex index, filled on first use so unused vertices
  // never reach the model.
  let px = new Float64Array(3 * 1024);
  let weldedOf = new Int32Array(1024).fill(-1);
  let nv = 0;
  const welder = new VertexWelder();
  const tris = new IntList();
  const face: number[] = [];

  let lineNo = 0;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    lineNo++;
    let s = start;
    while (s < end && isWs(text.charCodeAt(s))) s++;
    const c0 = text.charCodeAt(s);
    const c1 = text.charCodeAt(s + 1);
    if (c0 === 0x76 /* v */ && isWs(c1)) {
      const p = text.slice(s + 2, end).trim().split(/\s+/);
      const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
      if (p.length < 3 || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw formatError("ERR_OBJ_INVALID", `bad vertex on line ${lineNo}`);
      }
      if (nv * 3 + 3 > px.length) {
        const grown = new Float64Array(px.length * 2);
        grown.set(px);
        px = grown;
        const g = new Int32Array(weldedOf.length * 2).fill(-1);
        g.set(weldedOf);
        weldedOf = g;
      }
      px[nv * 3] = x; px[nv * 3 + 1] = y; px[nv * 3 + 2] = z;
      nv++;
    } else if (c0 === 0x66 /* f */ && isWs(c1)) {
      const p = text.slice(s + 2, end).trim().split(/\s+/);
      if (p.length < 3) throw formatError("ERR_OBJ_INVALID", `face with fewer than 3 vertices on line ${lineNo}`);
      face.length = 0;
      for (const token of p) {
        const slash = token.indexOf("/");
        const ref = Number(slash < 0 ? token : token.slice(0, slash));
        if (!Number.isInteger(ref) || ref === 0) throw formatError("ERR_OBJ_INVALID", `bad vertex index on line ${lineNo}`);
        const v = ref > 0 ? ref - 1 : nv + ref; // negative indices count back from the last vertex
        if (v < 0 || v >= nv) throw formatError("ERR_OBJ_INVALID", `vertex index out of range on line ${lineNo}`);
        let w = weldedOf[v];
        if (w < 0) w = weldedOf[v] = welder.add(px[v * 3], px[v * 3 + 1], px[v * 3 + 2]);
        face.push(w);
      }
      for (let i = 1; i + 1 < face.length; i++) {
        tris.push(face[0]); tris.push(face[i]); tris.push(face[i + 1]);
      }
    }
    start = end + 1;
  }
  return singleMeshModel(name, welder.vertices(), tris.toArray(), () => formatError("ERR_OBJ_EMPTY"));
}
