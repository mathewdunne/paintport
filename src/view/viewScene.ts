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
   * changes entries and then calls `ModelViewer.updateTriangleColors`.
   */
  states: Uint16Array;
  /** 1 = draw this triangle, 0 = skip it (negative volumes, modifiers, ...). */
  mask: Uint8Array;
}

export interface ViewScene {
  objects: ViewObject[];
  /** "#RRGGBB" per state, index 0 unused. */
  palette: string[];
}
