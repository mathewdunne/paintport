// The design sidecar (spec 5.4): the design data of a project, written into every export next
// to the slicer files, which ignore it. Re-importing the export restores design colors, base
// colors, pins and sub-triangle detail exactly; without the sidecar (or when it does not match
// the file) the import falls back to the spool colors in the file. DOM-free.
//
// Members of the 3MF archive:
//
//   Metadata/PaintPortPlus.json            the document described by `SidecarDoc` below
//   Metadata/PaintPortPlus/object_<n>.bin  the design paint of object n (0-based, the project's
//                                          object index), little-endian:
//
//     offset  size        field
//     0       4           magic "PPDP"
//     4       2           layout version (1)
//     6       2           reserved, 0
//     8       4           triangle count n
//     12      4           preserved count m
//     16      2 * n       design state of each triangle (u16, 0 = unpainted)
//     ...     m entries   preserved sub-triangle trees, ascending by triangle:
//                           u32 triangle, u32 length L, L ASCII hex digits (the tree, design
//                           states, "bbs" dialect, upper case)
//
// A triangle's state is the dominant state of its tree when it has one, exactly as in the
// document. The JSON holds everything that is not per triangle.
//
// Reading is strict and never throws: anything that does not add up (sizes, ranges, states
// outside the palette, malformed trees, parts that do not tile the triangles or disagree with
// the volume types the file imports as, a geometry hash that differs) makes the whole sidecar
// "ignored" and the caller imports the file as if it had no sidecar. The assembled data goes
// through `fromSnapshot`, which applies the same validation as a restored autosave.
import { PAINTPORT_VERSION, type Filament, type Model, type VolumeType, type ZipEntry } from "../core";
import { DocError } from "./errors";
import { hashGeometry, hashPositions, newProjectId } from "./geometryHash";
import { clonePin, type MappingPin } from "./pins";
import type { Project, ProjectOptions } from "./project";
import {
  fromSnapshot, GEOMETRY_FORMAT, PAINT_FORMAT, SNAPSHOT_VERSION,
  type GeometryObject, type GeometryPart, type GeometrySnapshot, type PaintObject, type PaintSnapshot,
} from "./snapshot";
import { TrianglePaintField } from "./trianglePaintField";
import { unescapeXml } from "./xmlText";

export const SIDECAR_FORMAT = "paintport-plus-design";
/** Bump when the JSON or the .bin layout changes; other versions are ignored, not migrated. */
export const SIDECAR_VERSION = 1;
export const SIDECAR_JSON = "Metadata/PaintPortPlus.json";
const BIN_PREFIX = "Metadata/PaintPortPlus/";
export const sidecarPaintName = (objectIndex: number): string => `${BIN_PREFIX}object_${objectIndex}.bin`;
/** True for the archive members the sidecar uses (a caller keeps just these from a big archive). */
export const isSidecarMember = (name: string): boolean => name === SIDECAR_JSON || name.startsWith(BIN_PREFIX);

// Caps against hostile files. The .bin size is bounded by the triangle count of the file it
// belongs to, so only the JSON and the single trees need a limit of their own.
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TREE_CHARS = 1 << 16;
/** More filaments than any slicer id can address (PrusaSlicer's 272): a hostile sidecar, not a real file. */
const MAX_FILAMENTS = 272;
const MAGIC = [0x50, 0x50, 0x44, 0x50]; // "PPDP"
const BIN_VERSION = 1;
const BIN_HEADER = 16;

/** Volume type names in the order of their per-triangle codes below. */
const VOLUME_TYPES: readonly VolumeType[] = ["ModelPart", "NegativeVolume", "ParameterModifier", "SupportBlocker", "SupportEnforcer"];

interface SidecarPart {
  firstTri: number;
  triCount: number;
  type: VolumeType;
  name: string | null;
  /** Base design state, 0 for volumes without a base color. */
  base: number;
}

interface SidecarDoc {
  format: typeof SIDECAR_FORMAT;
  version: number;
  /** PaintPort version that wrote the file. */
  app: string;
  /** Base name of the project's source file; it names the next export. */
  name?: string;
  /**
   * The filaments of the file the project was first imported from. The palette's `mix` hints
   * refer to that file's physical extruders, so they must keep matching against its colors
   * (and "Use this file's spools" offers its spools), not those of this export.
   */
  filaments: Filament[];
  /** Design colors for states 1..k. */
  palette: { color: string; known: boolean; mix?: { extruder: number; ratio: number }[] }[];
  /** Mapping pins as [design state, pin], ascending by state. */
  pins?: [number, MappingPin][];
  objects: { triCount: number; hash: string; parts: SidecarPart[] }[];
}

// --- writing -------------------------------------------------------------------------

const positionHashes = new WeakMap<object, string>(); // the geometry never changes, so neither does its hash

function positionHashOf(mesh: { vertices: Float64Array; tris: Int32Array }): string {
  let h = positionHashes.get(mesh);
  if (h === undefined) positionHashes.set(mesh, (h = hashPositions(mesh)));
  return h;
}

const copyFilament = (f: Filament): Filament => ({
  index: f.index, color: f.color, colorKnown: f.colorKnown,
  paintedTris: f.paintedTris, baseTris: f.baseTris, paintedShare: f.paintedShare, baseShare: f.baseShare, isDefaultOf: f.isDefaultOf,
  ...(f.mix ? { mix: f.mix.map((m) => ({ extruder: m.extruder, ratio: m.ratio })) } : {}),
});

function writePaintBin(field: TrianglePaintField): Uint8Array {
  const { states, preserved } = field;
  const te = new TextEncoder();
  const tris = Uint32Array.from(preserved.keys()).sort();
  const trees = Array.from(tris, (t) => te.encode(preserved.get(t)!));
  let size = BIN_HEADER + 2 * states.length;
  for (const tree of trees) size += 8 + tree.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  dv.setUint16(4, BIN_VERSION, true);
  dv.setUint32(8, states.length, true);
  dv.setUint32(12, tris.length, true);
  for (let t = 0; t < states.length; t++) dv.setUint16(BIN_HEADER + 2 * t, states[t], true);
  let at = BIN_HEADER + 2 * states.length;
  tris.forEach((t, i) => {
    dv.setUint32(at, t, true);
    dv.setUint32(at + 4, trees[i].length, true);
    out.set(trees[i], at + 8);
    at += 8 + trees[i].length;
  });
  return out;
}

/** The sidecar members for a project: the JSON first, then one .bin per object. */
export function buildSidecar(project: Project): ZipEntry[] {
  const doc: SidecarDoc = {
    format: SIDECAR_FORMAT,
    version: SIDECAR_VERSION,
    app: PAINTPORT_VERSION,
    ...(project.source.name ? { name: project.source.name } : {}),
    filaments: project.source.filaments.map(copyFilament),
    palette: project.palette.slice(1).map((c) => ({
      color: c.color, known: c.known, ...(c.mix ? { mix: c.mix.map((m) => ({ extruder: m.extruder, ratio: m.ratio })) } : {}),
    })),
    ...(project.mapping.size ? { pins: [...project.mapping].sort((a, b) => a[0] - b[0]).map(([state, pin]): [number, MappingPin] => [state, clonePin(pin)]) } : {}),
    objects: project.objects.map((o) => ({
      triCount: o.triCount,
      hash: positionHashOf(o.mesh),
      // `export.ts` leaves out parts without triangles too, so the parts tile what the file has.
      // Parts that have a base color always have an entry; the 0 is for the volumes that have none.
      parts: o.parts.filter((p) => p.triCount > 0).map((p) => ({
        firstTri: p.firstTri, triCount: p.triCount, type: p.type, name: p.name, base: project.baseColor.get(p.id) ?? 0,
      })),
    })),
  };
  const entries: ZipEntry[] = [{ name: SIDECAR_JSON, data: new TextEncoder().encode(JSON.stringify(doc)) }];
  project.fields.forEach((field, i) => {
    if (!(field instanceof TrianglePaintField)) throw new TypeError("Only per-triangle paint fields can be exported");
    entries.push({ name: sidecarPaintName(i), data: writePaintBin(field) });
  });
  return entries;
}

// --- reading -------------------------------------------------------------------------

export type SidecarResult =
  /** The archive has no sidecar. */
  | { status: "none" }
  /** There is one, but it is damaged or does not belong to this file; `reason` is for logs. */
  | { status: "ignored"; reason: string }
  | { status: "restored"; project: Project };

export interface SidecarReadOptions extends ProjectOptions {
  /** Name of the imported file without extension; used when the sidecar has no source name. */
  name?: string;
}

const bad = (what: string): DocError => new DocError("SNAPSHOT_INVALID", `Design sidecar: ${what}`);

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;

interface ReadPaint {
  states: Uint16Array;
  preservedTris: Uint32Array;
  preservedTrees: string[];
}

/** Decodes and bounds-checks one object's .bin; `triCount` is the imported file's count. */
function readPaintBin(bytes: Uint8Array | undefined, triCount: number, where: string): ReadPaint {
  if (!bytes) throw bad(`${where} paint is missing`);
  if (bytes.length < BIN_HEADER || MAGIC.some((b, i) => bytes[i] !== b)) throw bad(`${where} paint header`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(4, true) !== BIN_VERSION || dv.getUint16(6, true) !== 0) throw bad(`${where} paint version`);
  if (dv.getUint32(8, true) !== triCount) throw bad(`${where} paint triangle count`);
  const count = dv.getUint32(12, true);
  let at = BIN_HEADER + 2 * triCount;
  if (count > triCount || at > bytes.length) throw bad(`${where} paint size`);
  const states = new Uint16Array(triCount);
  for (let t = 0; t < triCount; t++) states[t] = dv.getUint16(BIN_HEADER + 2 * t, true);
  const preservedTris = new Uint32Array(count), preservedTrees: string[] = [];
  const td = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (at + 8 > bytes.length) throw bad(`${where} preserved tree ${i} is cut off`);
    const tri = dv.getUint32(at, true), length = dv.getUint32(at + 4, true);
    if (tri >= triCount || (i > 0 && tri <= preservedTris[i - 1])) throw bad(`${where} preserved tree ${i} triangle`);
    if (length < 1 || length > MAX_TREE_CHARS || at + 8 + length > bytes.length) throw bad(`${where} preserved tree ${i} length`);
    const tree = td.decode(bytes.subarray(at + 8, at + 8 + length));
    if (!/^[0-9A-F]+$/.test(tree)) throw bad(`${where} preserved tree ${i} characters`); // the tree's syntax is checked by fromSnapshot
    preservedTris[i] = tri;
    preservedTrees.push(tree);
    at += 8 + length;
  }
  if (at !== bytes.length) throw bad(`${where} paint has trailing bytes`);
  return { states, preservedTris, preservedTrees };
}

/**
 * Checks the sidecar's parts against the imported object: they must tile its triangles in
 * order, every triangle must have the volume type the file imports it as, and each part gets
 * the file extruder of the imported part it starts in. Returns the parts and their bases.
 */
function readParts(raw: unknown, source: Model["objects"][number], where: string): { parts: GeometryPart[]; bases: number[] } {
  const triCount = source.tris.length / 3;
  if (!Array.isArray(raw)) throw bad(`${where} parts`);
  const owner = new Int32Array(triCount); // imported part index + 1 per triangle, 0 = outside every imported part
  source.parts.forEach((p, k) => owner.fill(k + 1, p.firstTri, p.firstTri + p.triCount));
  const importedCode = source.parts.map((p) => VOLUME_TYPES.indexOf(p.type));
  const parts: GeometryPart[] = [], bases: number[] = [];
  let cursor = 0;
  for (const p of raw as unknown[]) {
    if (!isRec(p) || !isCount(p.firstTri) || !isCount(p.triCount) || p.firstTri !== cursor || p.triCount < 1 || cursor + p.triCount > triCount) throw bad(`${where} parts do not tile the triangles`);
    const code = typeof p.type === "string" ? VOLUME_TYPES.indexOf(p.type as VolumeType) : -1;
    if (code < 0 || !(p.name === null || typeof p.name === "string") || !isCount(p.base)) throw bad(`${where} part fields`);
    for (let t = cursor; t < cursor + p.triCount; t++) if (owner[t] === 0 || importedCode[owner[t] - 1] !== code) throw bad(`${where} part type differs from the file`);
    parts.push({ firstTri: cursor, triCount: p.triCount, type: VOLUME_TYPES[code], name: p.name, extruder: source.parts[owner[cursor] - 1].extruder });
    bases.push(p.base);
    cursor += p.triCount;
  }
  if (cursor !== triCount) throw bad(`${where} parts do not tile the triangles`);
  return { parts, bases };
}

function restore(files: ReadonlyMap<string, Uint8Array>, jsonBytes: Uint8Array, model: Model, options: SidecarReadOptions): Project {
  if (jsonBytes.length > MAX_JSON_BYTES) throw bad("the document is too large");
  const doc: unknown = JSON.parse(new TextDecoder().decode(jsonBytes));
  if (!isRec(doc) || doc.format !== SIDECAR_FORMAT) throw bad("not a PaintPort+ design document");
  if (doc.version !== SIDECAR_VERSION) throw bad(`version ${String(doc.version)}, expected ${SIDECAR_VERSION}`);
  if (!Array.isArray(doc.palette) || !Array.isArray(doc.filaments) || !Array.isArray(doc.objects) || !(doc.name === undefined || typeof doc.name === "string")) throw bad("document fields");
  if (doc.filaments.length > MAX_FILAMENTS) throw bad("filaments");
  const docObjects: unknown[] = doc.objects;
  if (docObjects.length !== model.objects.length) throw bad("object count differs from the file");

  const geoObjects: GeometryObject[] = [], paintObjects: PaintObject[] = [];
  model.objects.forEach((source, i) => {
    const where = `object ${i}`;
    const d: unknown = docObjects[i];
    const triCount = source.tris.length / 3;
    if (!isRec(d) || d.triCount !== triCount || typeof d.hash !== "string") throw bad(`${where} fields`);
    const { parts, bases } = readParts(d.parts, source, where);
    const paint = readPaintBin(files.get(sidecarPaintName(i)), triCount, where);
    if (d.hash !== hashPositions(source)) throw bad(`${where} geometry differs from the file`); // last: the only expensive check
    geoObjects.push({ name: unescapeXml(source.name), printable: source.printable, transform: source.transform, fileExtruder: source.defaultExtruder, vertices: source.vertices, tris: source.tris, parts });
    paintObjects.push({ ...paint, partBases: bases });
  });

  const name = typeof doc.name === "string" && doc.name ? doc.name : options.name;
  const projectId = newProjectId();
  const geometryHash = hashGeometry(geoObjects);
  const geometry: GeometrySnapshot = {
    format: GEOMETRY_FORMAT, version: SNAPSHOT_VERSION, projectId, geometryHash, objects: geoObjects,
    // The original file's filaments (validated by fromSnapshot); only their known fields are kept.
    source: { paintDialect: model.paintDialect, sourceIdentity: model.sourceIdentity, filaments: (doc.filaments as unknown[]).map(pickFilament) as Filament[], ...(name ? { name } : {}) },
  };
  const paint: PaintSnapshot = {
    format: PAINT_FORMAT, version: SNAPSHOT_VERSION, projectId, geometryHash,
    palette: doc.palette as PaintSnapshot["palette"], // validated entry by entry by fromSnapshot
    objects: paintObjects,
    ...(doc.pins !== undefined ? { mapping: doc.pins as PaintSnapshot["mapping"] } : {}),
  };
  const { name: _name, ...projectOptions } = options;
  return fromSnapshot({ geometry, paint }, projectOptions);
}

/** Copies the known fields of a filament read from JSON; anything that is not a filament passes on to be rejected by the validation. */
const pickFilament = (f: unknown): unknown =>
  !isRec(f) ? f : {
    index: f.index, color: f.color, colorKnown: f.colorKnown,
    paintedTris: f.paintedTris, baseTris: f.baseTris, paintedShare: f.paintedShare, baseShare: f.baseShare, isDefaultOf: f.isDefaultOf,
    ...(f.mix !== undefined ? { mix: f.mix } : {}),
  };

/**
 * Restores the project from the sidecar in `files` (the archive members the import took from
 * the file, see `isSidecarMember`) for the model that the same file imported as. Never throws:
 * `none` without a sidecar, `ignored` (with a reason for the log) when it is damaged or does not
 * match the model, else the restored project. The model's arrays become the project's on
 * success and are untouched otherwise, so the caller can still build the project from the model.
 */
export function readSidecar(files: ReadonlyMap<string, Uint8Array>, model: Model, options: SidecarReadOptions = {}): SidecarResult {
  const jsonBytes = files.get(SIDECAR_JSON);
  if (!jsonBytes) return { status: "none" };
  try {
    return { status: "restored", project: restore(files, jsonBytes, model, options) };
  } catch (e) {
    return { status: "ignored", reason: e instanceof Error ? e.message : String(e) };
  }
}
