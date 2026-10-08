// The seam between tools and paint storage (spec 5.2). Tools talk to a PaintField and
// never touch its storage, so finer-grained implementations (per-triangle trees, split
// meshes) can replace the per-triangle one later.

/** Design-palette index; 0 = unpainted (the part's base color). */
export type State = number;

/** Indexed triangle mesh in object space. */
export interface EditableMesh {
  /** x,y,z triples. */
  readonly vertices: Float64Array;
  /** v1,v2,v3 triples indexing `vertices`. */
  readonly tris: Int32Array;
  readonly triCount: number;
}

export interface PaintField {
  /**
   * Geometry the field is defined over. A later implementation may replace this mesh
   * (split triangles), so callers must not cache triangle indices across edits.
   */
  readonly mesh: EditableMesh;

  /** State at a surface point of triangle `tri`. The per-triangle field ignores `bary`. */
  stateAt(tri: number, bary?: [number, number, number]): State;

  /**
   * Per-triangle display state for the viewer (0 = unpainted). May be the field's live
   * storage: callers must treat it as read-only and copy it if they need a snapshot.
   */
  displayStates(): Uint16Array;

  // TODO(phase 2): edit primitives, expressed as regions rather than triangle lists:
  //   paintSphere(center, radius, state, opts): EditRecord;
  //   paintTriangles(tris, state): EditRecord;
  //   remap(map): EditRecord;
  // TODO(phase 3): serialize(dialect): { mesh; paint: (string | null)[] } for export.
}
