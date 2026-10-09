// The seam between tools and paint storage (spec 5.2). Tools talk to a PaintField and
// never touch its storage, so finer-grained implementations (per-triangle trees, split
// meshes) can replace the per-triangle one later.
//
// Fields are storage: they know nothing about the palette, the undo history or change
// notifications. UI code edits through `Project` (project.ts), which validates states,
// records undo steps and notifies the viewer. Calling a field's edit methods directly
// bypasses all of that.
import type { PaintDialect } from "../core";

/** Design-palette index; 0 = unpainted (the part's base color). */
export type State = number;

export type Vec3 = readonly [number, number, number];

/** Indexed triangle mesh in object space. */
export interface EditableMesh {
  /** x,y,z triples. */
  readonly vertices: Float64Array;
  /** v1,v2,v3 triples indexing `vertices`. */
  readonly tris: Int32Array;
  readonly triCount: number;
}

export interface BrushOpts {
  /**
   * Triangle ids the brush may hit. The caller (the view, with its BVH) narrows the
   * triangles near the sphere and applies visibility ("paint through" off = only
   * triangles visible from the camera), so the field stays camera-agnostic. The field
   * still tests every candidate exactly, so an over-generous list (all triangles in the
   * sphere's bounding box) is fine and a too-small one just paints less.
   *
   * Omitted: every paintable triangle is tested, O(triangle count). Meant for tests and
   * for callers without a spatial index, not for brushing a large mesh.
   */
  candidates?: ArrayLike<number>;

  /**
   * The candidates already passed an exact sphere test, so paint all of them without
   * testing again. The caller sets this when its own test is the authority on the brush
   * footprint: the view tests in world space, where the brush is a true sphere, while the
   * field's object-space sphere is only an approximation under a non-uniform scale (its
   * radius is the mean scale), which would shrink or grow the footprint against the ring.
   * `center` and `radius` still describe the intent (a sphere), so a finer-grained field
   * can use them. Ignored without `candidates`.
   */
  candidatesExact?: boolean;
}

/**
 * One edit of a field's storage, as returned by the edit methods. Opaque to callers:
 * they hand it back to the same field (`undoEdit`, `redoEdit`, `mergeEdits`,
 * `editedTriangles`) and never look inside, so other fields can store trees or topology
 * snapshots instead of per-triangle diffs.
 */
export interface EditRecord {
  /** Triangles the edit touched; 0 means it changed nothing and need not be recorded. */
  readonly size: number;
  /** Approximate memory the record holds, for the undo history's byte budget. */
  readonly bytes: number;
}

/** What callers outside the document may do with a field: read it. Edits go through `Project`. */
export interface PaintFieldView {
  /**
   * Geometry the field is defined over. A later implementation may replace this mesh
   * (split triangles), so callers must not cache triangle indices across edits.
   */
  readonly mesh: EditableMesh;

  /** State at a surface point of triangle `tri`. The per-triangle field ignores `bary`. */
  stateAt(tri: number, bary?: [number, number, number]): State;

  /**
   * Per-triangle display state for the viewer (0 = unpainted, so the part's base color
   * shows). The field's live storage: treat as read-only and copy it for a snapshot.
   */
  displayStates(): Readonly<Uint16Array>;

  /** True for triangles that can carry paint (ModelPart volumes). Others are never edited. */
  isPaintable(tri: number): boolean;

  /**
   * The paint of every triangle of `mesh` as a TriangleSelector string in design states, for
   * export: `null` for an unpainted triangle, a one-leaf string for whole-triangle paint, and
   * the preserved sub-triangle tree (converted to `dialect`) where the import had one. The
   * strings carry design states as they are, so `dialect` must be able to encode them (the
   * "bbs" dialect is unbounded); `buildExport` serializes in "bbs" and lets `build3MF` remap
   * the states and convert to the target's dialect.
   */
  serialize(dialect: PaintDialect): { mesh: EditableMesh; paint: (string | null)[] };
}

export interface PaintField extends PaintFieldView {
  /**
   * Paints the triangles within `radius` of `center` (object space) with `state`: those
   * whose closest point to the center is at most `radius` away, which includes a triangle
   * larger than the sphere that the sphere merely touches. Only `opts.candidates` are
   * tested, unless `opts.candidatesExact` says they need not be (see BrushOpts). Painting clears a triangle's preserved sub-triangle detail.
   */
  paintSphere(center: Vec3, radius: number, state: State, opts?: BrushOpts): EditRecord;

  /** Paints the given triangles (fills). Non-paintable and unknown triangles are skipped. */
  paintTriangles(tris: ArrayLike<number>, state: State): EditRecord;

  /**
   * Replaces every state s > 0 by `map(s)` (merging colors: several states may map to the
   * same one, and 0 means "unpainted"). Applies to preserved sub-triangle detail too.
   * State 0 is never passed to `map`.
   */
  remap(map: (s: State) => State): EditRecord;

  /**
   * Renames states through a bijection (a palette compaction). `forward[s]` is the new
   * name of state s and `inverse` undoes it; both are indexed by state, 0 maps to 0. Much
   * cheaper to record than `remap` because it stores two small tables, not a per-triangle
   * diff. Throws, without changing anything, if a stored state is outside the tables.
   */
  renumber(forward: Uint16Array, inverse: Uint16Array): EditRecord;

  /**
   * Combines edits made one after another (a brush stroke) into one record that undoes
   * and redoes as a unit: per triangle, the first edit's "before" and the last edit's
   * "after" win. The records must be consecutive edits of this field.
   */
  mergeEdits(edits: readonly EditRecord[]): EditRecord;

  /**
   * Triangles whose stored paint the edit changed (empty for a renumbering). Includes a
   * triangle that only lost its preserved sub-triangle detail. The array belongs to the
   * record: do not modify it.
   */
  editedTriangles(edit: EditRecord): Uint32Array;

  undoEdit(edit: EditRecord): void;
  redoEdit(edit: EditRecord): void;
}
