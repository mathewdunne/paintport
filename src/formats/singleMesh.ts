import type { Filament, Model, ModelObject } from "../core";
import type { FormatError } from "./errors";

/** Neutral light gray for models that carry no color information (STL, OBJ). */
export const IMPORT_DEFAULT_COLOR = "#D9D9D9";

/**
 * Wraps one welded, unpainted mesh in the core's Model shape: one object, one ModelPart,
 * base extruder 1, one default filament. Triangles that collapsed to fewer than three
 * distinct vertices through welding are dropped; `onEmpty` supplies the error when
 * nothing is left.
 */
export function singleMeshModel(name: string, vertices: Float64Array, tris: Int32Array, onEmpty: () => FormatError): Model {
  let kept = tris;
  const total = tris.length / 3;
  let n = 0;
  for (let t = 0; t < total; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    if (n !== t && kept === tris) kept = tris.slice(); // copy on first drop
    kept[n * 3] = a; kept[n * 3 + 1] = b; kept[n * 3 + 2] = c;
    n++;
  }
  if (n === 0) throw onEmpty();
  if (n !== total) kept = kept.slice(0, n * 3);

  const object: ModelObject = {
    name,
    defaultExtruder: 1,
    transform: null,
    printable: true,
    vertices,
    tris: kept,
    paints: new Array<string | null>(n).fill(null),
    parts: [{ firstTri: 0, triCount: n, extruder: 1, type: "ModelPart", name: null }],
    triState: new Int16Array(n),
  };
  const filament: Filament = {
    index: 1,
    color: IMPORT_DEFAULT_COLOR,
    colorKnown: false,
    paintedTris: 0,
    baseTris: n,
    paintedShare: 0,
    baseShare: n,
    isDefaultOf: 1,
  };
  return {
    objects: [object],
    filaments: [filament],
    unpainted: n,
    totalTris: n,
    usedExtruders: [],
    specialVolumes: 0,
    sourceIdentity: null,
    paintDialect: "bbs",
  };
}
