// Hand-built models for the document-layer tests: tiny meshes with exact, known topology.
import { collectStates, emitPaintTree, type Filament, type MixComponentRef, type Model, type PaintDialect, type PaintNode, type PartRange } from "../../src/core";
import { CUBE_TRIS } from "./fixtures";

export interface MeshSpec {
  /** x,y,z triples. */
  vertices: number[];
  /** v1,v2,v3 triples. */
  tris: number[];
}

/** Unit cube with 8 shared corners and 12 triangles. */
export function cubeMesh(offset: [number, number, number] = [0, 0, 0]): MeshSpec {
  const vertices: number[] = [], tris: number[] = [];
  const index = new Map<string, number>();
  for (const t of CUBE_TRIS) {
    for (let k = 0; k < 3; k++) {
      const p = [t[k * 3] + offset[0], t[k * 3 + 1] + offset[1], t[k * 3 + 2] + offset[2]];
      const key = p.join(",");
      let i = index.get(key);
      if (i === undefined) { i = vertices.length / 3; index.set(key, i); vertices.push(...p); }
      tris.push(i);
    }
  }
  return { vertices, tris };
}

/** Concatenates meshes into one with disjoint vertices. */
export function joinMeshes(...meshes: MeshSpec[]): MeshSpec {
  const vertices: number[] = [], tris: number[] = [];
  for (const m of meshes) {
    const base = vertices.length / 3;
    vertices.push(...m.vertices);
    tris.push(...m.tris.map((i) => i + base));
  }
  return { vertices, tris };
}

/**
 * A strip of unit quads along x, extruded `width` along y, bent in the xz plane. Quad i
 * (triangles 2i and 2i+1) turns by `turnsDeg[i - 1]` relative to quad i - 1, so the
 * dihedral angle at the joint between quads i - 1 and i is exactly that turn.
 */
export function stripMesh(turnsDeg: number[], width = 1): MeshSpec {
  const vertices: number[] = [], tris: number[] = [];
  let x = 0, z = 0, heading = 0;
  const point = () => vertices.push(x, 0, z, x, width, z);
  point();
  for (let q = 0; q <= turnsDeg.length; q++) {
    if (q > 0) heading += (turnsDeg[q - 1] * Math.PI) / 180;
    x += Math.cos(heading);
    z += Math.sin(heading);
    point();
    const a0 = 2 * q, a1 = 2 * q + 1, b0 = 2 * q + 2, b1 = 2 * q + 3;
    tris.push(a0, b0, a1, a1, b0, b1);
  }
  return { vertices, tris };
}

export const leaf = (state: number, dialect: PaintDialect = "bbs") => emitPaintTree({ state }, dialect);
export const tree = (node: PaintNode, dialect: PaintDialect = "bbs") => emitPaintTree(node, dialect);
/** A split into two children (a triangle cut in half). */
export const split2 = (a: number, b: number): PaintNode => ({ splitSides: 1, special: 0, children: [{ state: a }, { state: b }] });
/** A split into three children. */
export const split3 = (a: number, b: number, c: number): PaintNode => ({ splitSides: 2, special: 0, children: [{ state: a }, { state: b }, { state: c }] });

export interface ModelSpec {
  /** Paint string per triangle (null/"" = unpainted), in `dialect`. */
  paints?: (string | null)[];
  parts?: PartRange[];
  /** Colors of file filaments 1..n; `null` = the file does not define that slot. */
  filaments?: ({ color: string; mix?: MixComponentRef[] } | null)[];
  dialect?: PaintDialect;
  defaultExtruder?: number;
}

/** A core Model as `load3MF` would produce it for the given mesh, paint and parts. */
export function makeModel(mesh: MeshSpec, spec: ModelSpec = {}): Model {
  const triCount = mesh.tris.length / 3;
  const dialect = spec.dialect ?? "bbs";
  const paints = Array.from({ length: triCount }, (_, i) => spec.paints?.[i] || null);
  const parts = spec.parts ?? [{ firstTri: 0, triCount, extruder: 1, type: "ModelPart", name: null }];
  const triState = new Int16Array(triCount);
  paints.forEach((p, t) => {
    if (!p) return;
    const counts = new Map<number, number>();
    collectStates(p, counts, dialect);
    let dom = 0, best = 0;
    for (const [s, c] of counts) if (c > best || (c === best && s > dom)) { best = c; dom = s; }
    triState[t] = dom;
  });
  const filaments = (spec.filaments ?? []).map((f, i): Filament => ({
    index: i + 1,
    color: f ? f.color : "#26A69A", // the core's fallback color for undefined slots
    colorKnown: !!f,
    paintedTris: 0, baseTris: 0, paintedShare: 0, baseShare: 0, isDefaultOf: 0,
    ...(f?.mix ? { mix: f.mix } : {}),
  }));
  return {
    objects: [{
      name: "Obj", defaultExtruder: spec.defaultExtruder ?? 1, transform: null, printable: true,
      vertices: Float64Array.from(mesh.vertices), tris: Int32Array.from(mesh.tris), paints, parts, triState,
    }],
    filaments, unpainted: 0, totalTris: triCount, usedExtruders: [], specialVolumes: 0,
    sourceIdentity: null, paintDialect: dialect,
  };
}

/** A model with several objects; `filaments` (the file's colors) is shared by all of them. */
export function makeMultiModel(objects: { mesh: MeshSpec; spec?: ModelSpec }[], filaments: ModelSpec["filaments"] = []): Model {
  const models = objects.map((o) => makeModel(o.mesh, { ...o.spec, filaments }));
  const [first, ...rest] = models;
  first.objects.push(...rest.flatMap((m) => m.objects));
  first.objects.forEach((o, i) => { o.name = `Obj${i}`; });
  first.totalTris = models.reduce((n, m) => n + m.totalTris, 0);
  return first;
}

/** Merges vertices with identical coordinates (what the importers do), so touching meshes share edges. */
export function weldMesh(mesh: MeshSpec): MeshSpec {
  const vertices: number[] = [];
  const index = new Map<string, number>();
  const remap: number[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    const key = mesh.vertices.slice(i, i + 3).join(",");
    let j = index.get(key);
    if (j === undefined) { j = vertices.length / 3; index.set(key, j); vertices.push(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]); }
    remap.push(j);
  }
  return { vertices, tris: mesh.tris.map((i) => remap[i]) };
}
