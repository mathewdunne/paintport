// Autosave support (DOM-free): turns a Project into plain, structured-clone-friendly data
// and back. The storage itself (IndexedDB) is the UI's job; it implements SnapshotStore.
// The undo history is not persisted.
//
// A project is saved in two halves so that frequent autosaves stay small: the geometry
// (vertices, triangles, parts: tens of MB, never changes) is written once per project, and
// only the paint half (palette, per-triangle states, preserved trees, base colors) is
// rewritten on each save. Both halves carry the project id and a hash of the geometry, and
// a restore refuses halves that do not belong together.
//
// Optional fields (the paint half's `mapping` pins, the geometry half's `source.name`) were added
// without a version bump: snapshots written before them have no such field and restore as is, and
// a bump would make every existing autosave unreadable ("another version") for no gain.
import type { Filament, PaintDialect, SourceIdentity, VolumeType } from "../core";
import { BASE_SLOT } from "./designImport";
import { DocError } from "./errors";
import { hashGeometry } from "./geometryHash";
import { inspectTree, isSplitTree } from "./paintTree";
import { clonePin, pinProblem, type MappingPin } from "./pins";
import { Project } from "./project";
import type { PaintField, State } from "./paintField";
import { TrianglePaintField } from "./trianglePaintField";
import { hasBaseColor, NO_PART, partId, type DesignColor, type PartId, type ProjectObject, type ProjectPart } from "./types";

export const GEOMETRY_FORMAT = "paintport-plus-geometry";
export const PAINT_FORMAT = "paintport-plus-paint";
/** Bump when the layout below changes; older/newer snapshots are then rejected, not migrated. */
export const SNAPSHOT_VERSION = 1;

export interface GeometryPart {
  firstTri: number;
  triCount: number;
  type: VolumeType;
  name: string | null;
  /** Base extruder of the file (raw file numbering). */
  extruder: number;
}

export interface GeometryObject {
  name: string;
  printable: boolean;
  transform: string | null;
  fileExtruder: number;
  vertices: Float64Array;
  tris: Int32Array;
  parts: GeometryPart[];
}

/** The immutable half: write it once per project. */
export interface GeometrySnapshot {
  format: typeof GEOMETRY_FORMAT;
  version: number;
  projectId: string;
  geometryHash: string;
  objects: GeometryObject[];
  /** What phase 3 export needs from the source file. */
  source: { paintDialect: PaintDialect; sourceIdentity: SourceIdentity | null; filaments: Filament[]; name?: string };
}

export interface PaintObject {
  /** Design state per triangle. */
  states: Uint16Array;
  /** Triangles with preserved sub-triangle detail (ascending) and their trees (design states, "bbs" dialect). */
  preservedTris: Uint32Array;
  preservedTrees: string[];
  /** Base design state per part (>= 1 for ModelParts and ParameterModifiers, 0 for other volumes). */
  partBases: number[];
}

/** The mutable half: rewritten on every autosave. */
export interface PaintSnapshot {
  format: typeof PAINT_FORMAT;
  version: number;
  projectId: string;
  geometryHash: string;
  /** Design colors for states 1..k (state 0, the base slot, is implicit). */
  palette: { color: string; known: boolean; mix?: { extruder: number; ratio: number }[] }[];
  objects: PaintObject[];
  /** Mapping pins as [design state, pin], ascending by state. Absent when there are none (and in older snapshots). */
  mapping?: [State, MappingPin][];
}

export interface ProjectSnapshot {
  geometry: GeometrySnapshot;
  paint: PaintSnapshot;
}

const copyMix = (mix: readonly { extruder: number; ratio: number }[]) => mix.map((m) => ({ extruder: m.extruder, ratio: m.ratio }));

/**
 * The immutable half. The arrays are shared with the project (it never changes them), so
 * this is cheap; the hash is computed once per project.
 */
export function toGeometrySnapshot(project: Project): GeometrySnapshot {
  return {
    format: GEOMETRY_FORMAT,
    version: SNAPSHOT_VERSION,
    projectId: project.id,
    geometryHash: project.geometryHash(),
    objects: project.objects.map((o) => ({
      name: o.name, printable: o.printable, transform: o.transform, fileExtruder: o.fileExtruder,
      vertices: o.mesh.vertices, tris: o.mesh.tris,
      parts: o.parts.map((p) => ({ firstTri: p.firstTri, triCount: p.triCount, type: p.type, name: p.name, extruder: p.extruder })),
    })),
    source: {
      paintDialect: project.source.paintDialect,
      sourceIdentity: project.source.sourceIdentity ? structuredClone(project.source.sourceIdentity) : null,
      filaments: project.source.filaments.map((f) => ({ ...f, ...(f.mix ? { mix: copyMix(f.mix) } : {}) })),
      ...(project.source.name !== undefined ? { name: project.source.name } : {}),
    },
  };
}

/** The mutable half. Everything in it is copied, so it stays valid while editing goes on. Canonical: equal states give equal snapshots. */
export function toPaintSnapshot(project: Project): PaintSnapshot {
  // Pins of states beyond the palette cannot be restored; the project prunes them, this is the safety net.
  const pins = [...project.mapping].filter(([state]) => state >= 1 && state < project.palette.length).sort((a, b) => a[0] - b[0]).map(([state, pin]): [State, MappingPin] => [state, clonePin(pin)]);
  return {
    format: PAINT_FORMAT,
    version: SNAPSHOT_VERSION,
    projectId: project.id,
    geometryHash: project.geometryHash(),
    palette: project.palette.slice(1).map((c) => ({ color: c.color, known: c.known, ...(c.mix ? { mix: copyMix(c.mix) } : {}) })),
    objects: project.objects.map((object, i): PaintObject => {
      const field = project.fields[i];
      if (!(field instanceof TrianglePaintField)) throw new TypeError("Only per-triangle paint fields can be saved");
      const preservedTris = Uint32Array.from(field.preserved.keys()).sort();
      return {
        states: field.states.slice(),
        preservedTris,
        preservedTrees: Array.from(preservedTris, (t) => field.preserved.get(t)!),
        partBases: object.parts.map((p) => project.baseColor.get(p.id) ?? 0),
      };
    }),
    ...(pins.length ? { mapping: pins } : {}),
  };
}

/** Both halves, for callers that do not split their storage (and for tests). */
export function toSnapshot(project: Project): ProjectSnapshot {
  return { geometry: toGeometrySnapshot(project), paint: toPaintSnapshot(project) };
}

// --- validation --------------------------------------------------------------------

const invalid = (what: string) => new DocError("SNAPSHOT_INVALID", `Invalid project snapshot: ${what}`);

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const isCount = (x: unknown): x is number => isInt(x) && x >= 0;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const VOLUME_TYPE_NAMES: readonly string[] = ["ModelPart", "NegativeVolume", "ParameterModifier", "SupportBlocker", "SupportEnforcer"];

/**
 * Throws SNAPSHOT_VERSION for a half written by another version. This is looked at before the
 * format: a newer build may rename the format along with the layout, and its data must read as
 * "another version" (left alone), not as damaged (cleared). A record with a different numeric
 * version, or with the expected format and no readable version, is another version.
 */
function checkVersion(x: unknown, format: string, what: string): void {
  if (isRec(x) && x.version !== SNAPSHOT_VERSION && (x.format === format || typeof x.version === "number")) {
    throw new DocError("SNAPSHOT_VERSION", `${what} version ${String(x.version)}, expected ${SNAPSHOT_VERSION}`);
  }
}

function checkHeader(x: unknown, format: string, what: string): Rec {
  checkVersion(x, format, what);
  if (!isRec(x) || x.format !== format) throw invalid(`${what} is not a ${format} snapshot`);
  if (!isStr(x.projectId) || !isStr(x.geometryHash) || !Array.isArray(x.objects)) throw invalid(`${what} header`);
  return x;
}

function checkMix(mix: unknown, where: string): void {
  if (mix === undefined) return;
  if (!Array.isArray(mix) || !mix.every((m) => isRec(m) && isInt(m.extruder) && isNum(m.ratio))) throw invalid(`${where} mix`);
}

function checkGeometry(raw: unknown): GeometrySnapshot {
  const g = checkHeader(raw, GEOMETRY_FORMAT, "geometry");
  (g.objects as unknown[]).forEach((o, oi) => {
    const where = `object ${oi}`;
    if (!isRec(o) || !isStr(o.name) || typeof o.printable !== "boolean" || !(o.transform === null || isStr(o.transform)) || !isCount(o.fileExtruder)) throw invalid(`${where} fields`);
    if (!(o.vertices instanceof Float64Array) || !(o.tris instanceof Int32Array) || !Array.isArray(o.parts)) throw invalid(`${where} arrays`);
    const triCount = o.tris.length / 3, vertexCount = o.vertices.length / 3;
    if (!Number.isInteger(triCount) || !Number.isInteger(vertexCount)) throw invalid(`${where} sizes`);
    for (let i = 0; i < o.tris.length; i++) if (!(o.tris[i] >= 0 && o.tris[i] < vertexCount)) throw invalid(`${where} triangle index`);
    for (const p of o.parts as unknown[]) {
      if (!isRec(p) || !isCount(p.firstTri) || !isCount(p.triCount) || p.firstTri + p.triCount > triCount) throw invalid(`${where} part range`);
      if (!isStr(p.type) || !VOLUME_TYPE_NAMES.includes(p.type) || !(p.name === null || isStr(p.name)) || !isCount(p.extruder)) throw invalid(`${where} part fields`);
    }
  });
  const s = g.source;
  if (!isRec(s) || (s.paintDialect !== "prusa" && s.paintDialect !== "bbs") || !(s.sourceIdentity === null || isRec(s.sourceIdentity)) || !Array.isArray(s.filaments)) throw invalid("source info");
  if (s.name !== undefined && !isStr(s.name)) throw invalid("source name");
  for (const f of s.filaments as unknown[]) {
    if (!isRec(f) || !isInt(f.index) || !isStr(f.color) || typeof f.colorKnown !== "boolean"
      || !isNum(f.paintedTris) || !isNum(f.baseTris) || !isNum(f.paintedShare) || !isNum(f.baseShare) || !isNum(f.isDefaultOf)) throw invalid("filament");
    checkMix(f.mix, "filament");
  }
  return g as unknown as GeometrySnapshot;
}

/** `paintable` per object, from the parts. */
function paintableOf(o: GeometryObject): Uint8Array {
  const out = new Uint8Array(o.tris.length / 3);
  for (const p of o.parts) if (p.type === "ModelPart") out.fill(1, p.firstTri, p.firstTri + p.triCount);
  return out;
}

function checkPaint(raw: unknown, geometry: GeometrySnapshot, paintable: Uint8Array[]): PaintSnapshot {
  const p = checkHeader(raw, PAINT_FORMAT, "paint");
  if (p.projectId !== geometry.projectId || p.geometryHash !== geometry.geometryHash) throw invalid("paint and geometry belong to different projects");
  if (!Array.isArray(p.palette)) throw invalid("palette");
  for (const c of p.palette as unknown[]) {
    if (!isRec(c) || !isStr(c.color) || !/^#[0-9A-F]{6}$/.test(c.color) || typeof c.known !== "boolean") throw invalid("palette entry");
    checkMix(c.mix, "palette entry");
  }
  const colors = (p.palette as unknown[]).length;
  if (colors >= 0xffff) throw invalid("palette size");
  const objects = p.objects as unknown[];
  if (objects.length !== geometry.objects.length) throw invalid("object count");
  objects.forEach((o, oi) => {
    const where = `object ${oi}`;
    const geo = geometry.objects[oi];
    if (!isRec(o) || !(o.states instanceof Uint16Array) || !(o.preservedTris instanceof Uint32Array) || !Array.isArray(o.preservedTrees) || !Array.isArray(o.partBases)) throw invalid(`${where} fields`);
    const triCount = geo.tris.length / 3;
    const mask = paintable[oi];
    if (o.states.length !== triCount) throw invalid(`${where} state count`);
    for (let t = 0; t < triCount; t++) {
      if (o.states[t] > colors) throw invalid(`${where} state outside the palette`);
      if (o.states[t] !== 0 && mask[t] !== 1) throw invalid(`${where} paint on a triangle that is not print surface`);
    }
    if (o.preservedTris.length !== o.preservedTrees.length) throw invalid(`${where} preserved trees`);
    for (let i = 0; i < o.preservedTris.length; i++) {
      const t = o.preservedTris[i], tree = o.preservedTrees[i];
      if (!(t < triCount) || (i > 0 && t <= o.preservedTris[i - 1]) || mask[t] !== 1 || !isStr(tree) || tree === "" || !isSplitTree(tree)) throw invalid(`${where} preserved tree ${i}`);
      const info = inspectTree(tree); // throws on a malformed tree
      if (info.maxState > colors) throw invalid(`${where} preserved tree uses a state outside the palette`);
      if (info.dominant !== o.states[t]) throw invalid(`${where} preserved tree and state disagree`);
    }
    if (o.partBases.length !== geo.parts.length) throw invalid(`${where} part bases`);
    geo.parts.forEach((part, pi) => {
      const base = (o.partBases as unknown[])[pi];
      if (!isCount(base) || base > colors || hasBaseColor(part.type) !== (base > 0)) throw invalid(`${where} part base color`);
    });
  });
  if (p.mapping !== undefined) {
    if (!Array.isArray(p.mapping)) throw invalid("mapping");
    let previous = 0;
    for (const entry of p.mapping as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) throw invalid("mapping entry");
      const [state, pin] = entry as [unknown, unknown];
      if (!isInt(state) || state <= previous || state > colors) throw invalid("mapping state");
      if (pinProblem(pin) !== null) throw invalid("mapping pin");
      previous = state;
    }
  }
  return p as unknown as PaintSnapshot;
}

/**
 * Rebuilds a project from its two halves, with an empty undo history. Throws `DocError` with
 * code SNAPSHOT_VERSION for another format version, and SNAPSHOT_INVALID for anything else
 * that is not a consistent pair of snapshots (malformed or hostile data, halves of different
 * projects): the caller should then start fresh. Takes ownership of the snapshots' arrays
 * (they become the project's), so do not reuse them afterwards.
 */
export function fromSnapshot(snapshot: unknown): Project {
  try {
    if (!isRec(snapshot)) throw invalid("not a project snapshot");
    // Both versions first, so damage found in one half never hides that the other one is from another version.
    checkVersion(snapshot.geometry, GEOMETRY_FORMAT, "geometry");
    checkVersion(snapshot.paint, PAINT_FORMAT, "paint");
    const geometry = checkGeometry(snapshot.geometry);
    if (hashGeometry(geometry.objects) !== geometry.geometryHash) throw invalid("geometry does not match its hash");
    const masks = geometry.objects.map(paintableOf);
    const paint = checkPaint(snapshot.paint, geometry, masks);

    const palette: DesignColor[] = [BASE_SLOT, ...paint.palette.map((c): DesignColor => ({ color: c.color, known: c.known, ...(c.mix ? { mix: copyMix(c.mix) } : {}) }))];
    const baseColor = new Map<PartId, State>();
    const fields: PaintField[] = [];
    const objects = geometry.objects.map((o, index): ProjectObject => {
      const triCount = o.tris.length / 3;
      const triPart = new Uint32Array(triCount).fill(NO_PART);
      const parts = o.parts.map((p, pi): ProjectPart => {
        triPart.fill(pi, p.firstTri, p.firstTri + p.triCount);
        if (paint.objects[index].partBases[pi] > 0) baseColor.set(partId(index, pi), paint.objects[index].partBases[pi]);
        return { id: partId(index, pi), firstTri: p.firstTri, triCount: p.triCount, type: p.type, name: p.name, extruder: p.extruder };
      });
      const mesh = { vertices: o.vertices, tris: o.tris, triCount };
      const po = paint.objects[index];
      const preserved = new Map<number, string>();
      po.preservedTris.forEach((t, i) => preserved.set(t, po.preservedTrees[i]));
      fields.push(new TrianglePaintField(mesh, masks[index], { states: po.states, preserved }));
      return { index, name: o.name, printable: o.printable, transform: o.transform, fileExtruder: o.fileExtruder, triCount, parts, triPart, paintable: masks[index], mesh };
    });
    const mapping = new Map<State, MappingPin>((paint.mapping ?? []).map(([state, pin]) => [state, clonePin(pin)]));
    return new Project({ palette, objects, fields, baseColor, source: geometry.source, mapping, projectId: geometry.projectId });
  } catch (e) {
    if (e instanceof DocError) throw e;
    throw invalid(e instanceof Error ? e.message : String(e)); // anything unforeseen in hostile data is still just "invalid"
  }
}

// --- storage -----------------------------------------------------------------------

/**
 * Persistent storage for one autosaved project, implemented by the UI (IndexedDB). The two
 * halves are separate records (e.g. two object-store keys) so that saving paint does not
 * rewrite the geometry.
 *
 * Writes must not leave a mix of two projects behind: `saveBoth` replaces both halves in one
 * atomic step, and `savePaint` must refuse (reject) when the stored geometry is not the one
 * the paint belongs to (another tab replaced the project meanwhile).
 */
export interface SnapshotStore {
  /** The stored halves as they were saved, or null when there are none. Not validated. */
  loadGeometry(): Promise<unknown | null>;
  loadPaint(): Promise<unknown | null>;
  /** Replaces both halves atomically: a failure leaves the previous project, never new geometry with old paint. */
  saveBoth(geometry: GeometrySnapshot, paint: PaintSnapshot): Promise<void>;
  /** Replaces the paint half of the stored project. Rejects if the stored geometry belongs to another project. */
  savePaint(snapshot: PaintSnapshot): Promise<void>;
  /** Removes both halves. */
  clear(): Promise<void>;
}

export type RestoreResult =
  | { status: "restored"; project: Project }
  /** Nothing is stored. */
  | { status: "empty" }
  /** Stored data is damaged or inconsistent. It is left in the store (it may be recoverable by hand or by a fixed build); the next save of a new project replaces it. */
  | { status: "invalid"; message: string }
  /** Stored by a different format version (maybe another, newer build of the app). It is left in the store so the UI can decide. */
  | { status: "version"; message: string };

/** Loads and validates the autosaved project. Storage failures are not caught: they reject. */
export async function restoreProject(store: SnapshotStore): Promise<RestoreResult> {
  const [geometry, paint] = await Promise.all([store.loadGeometry(), store.loadPaint()]);
  if ((geometry === null || geometry === undefined) && (paint === null || paint === undefined)) return { status: "empty" };
  try {
    return { status: "restored", project: fromSnapshot({ geometry, paint }) };
  } catch (e) {
    if (!(e instanceof DocError)) throw e;
    if (e.code === "SNAPSHOT_VERSION") return { status: "version", message: e.message };
    return { status: "invalid", message: e.message };
  }
}

/**
 * Saves a project to a store, writing the geometry (together with the paint) only when the
 * stored one is not this project's. Saves are serialized, so overlapping calls cannot interleave their writes
 * (the geometry always lands with or before the paint that refers to it).
 *
 * `reset` and `clear` end the saver's interest in the project it was saving (a new import,
 * "New"): saves still queued, or between their two writes, are dropped, so a stale paint
 * half can never be written after the store was cleared or its geometry replaced.
 */
export class ProjectSaver {
  private storedProject: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** Bumped by `reset`/`clear`: a save that began under an older value stops before its next write. */
  private epoch = 0;

  constructor(private readonly store: SnapshotStore) {}

  /** Tells the saver that the store already holds this project's geometry (after a restore). */
  adopt(project: Project): void {
    this.storedProject = project.id;
  }

  /**
   * Drops the saves still queued (a write already in flight finishes) and forgets what the
   * store holds, so the next `save` writes its geometry again.
   */
  reset(): void {
    this.epoch++;
    this.storedProject = null;
  }

  /** `reset`, then empties the store once every write in flight has finished. */
  clear(): Promise<void> {
    this.reset();
    const result = this.chain.then(() => this.store.clear());
    this.chain = result.catch(() => {});
    return result;
  }

  /** Resolves when the project is stored (also when a `reset` or `clear` made this save moot). */
  save(project: Project): Promise<void> {
    const epoch = this.epoch;
    const run = async () => {
      if (epoch !== this.epoch) return;
      if (this.storedProject !== project.id) {
        this.storedProject = null; // a failed write leaves the store in an unknown state
        // One atomic write: a cut-off or a quota failure cannot leave new geometry next to the old project's paint.
        await this.store.saveBoth(toGeometrySnapshot(project), toPaintSnapshot(project));
        if (epoch === this.epoch) this.storedProject = project.id; // after a reset the store is not this project's to assume
        return;
      }
      await this.store.savePaint(toPaintSnapshot(project));
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }
}
