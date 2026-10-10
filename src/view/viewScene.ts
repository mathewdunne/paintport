// What the viewer needs to know about a document. Plain arrays only, so the view stays
// independent of the document classes.
export interface ViewObject {
  /** x,y,z triples in object space. */
  vertices: Float64Array;
  /** v1,v2,v3 triples indexing `vertices`. */
  tris: Int32Array;
  /** Build-item transform attribute (12 numbers), applied when the geometry is built. */
  transform: string | null;
  /**
   * Resolved design state per triangle (index into `palette`). Owned by the caller, who
   * changes entries and then calls `ModelViewer.updateTriangleStates`.
   */
  states: Uint16Array;
  /** 1 = draw this triangle, 0 = skip it (negative volumes, modifiers, ...). */
  mask: Uint8Array;
  /**
   * Sub-triangle trees by triangle (design states, the document's internal dialect), drawn piece
   * by piece; `states` then holds the part's base, the color of unpainted pieces. Read live: the
   * caller changes entries and then calls `ModelViewer.updateTriangleStates`. Absent = none.
   */
  trees?: ReadonlyMap<number, string>;
}

export interface ViewScene {
  objects: ViewObject[];
  /** "#RRGGBB" per state, index 0 unused. */
  palette: string[];
}
