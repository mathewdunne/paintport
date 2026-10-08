import type { ModelObject } from "../core";
import type { EditableMesh, PaintField, State } from "./paintField";

/** True if the TriangleSelector string is a split tree rather than a single leaf. */
export function isSplitTree(paint: string): boolean {
  // The string is read right to left, so the last character is the root node. A root
  // with split sides (low 2 bits) other than 0 is a split; a leaf has them at 0.
  const root = parseInt(paint[paint.length - 1], 16);
  return (root & 3) !== 0;
}

/**
 * One state per triangle (spec 5.3). Triangles that carried sub-triangle detail in the
 * source keep their original paint string in `preserved` (as a dominant-state triangle
 * here), so a later export can emit it verbatim.
 */
export class TrianglePaintField implements PaintField {
  readonly mesh: EditableMesh;
  /** Dominant state per triangle. */
  readonly states: Uint16Array;
  /**
   * Original paint string for triangles whose paint was a split tree, else null. Stored
   * as in the file for now; phase 3 rewrites it into design states.
   */
  readonly preserved: (string | null)[];

  /** Shares `vertices` and `tris` with `object` (no copy). */
  constructor(object: ModelObject) {
    const triCount = object.tris.length / 3;
    this.mesh = { vertices: object.vertices, tris: object.tris, triCount };
    this.states = new Uint16Array(triCount);
    this.preserved = new Array<string | null>(triCount).fill(null);
    for (let t = 0; t < triCount; t++) {
      this.states[t] = object.triState[t];
      const paint = object.paints[t];
      if (paint && isSplitTree(paint)) this.preserved[t] = paint;
    }
  }

  stateAt(tri: number): State {
    return this.states[tri];
  }

  /** Returns the live `states` array, not a copy: do not mutate it. */
  displayStates(): Uint16Array {
    return this.states;
  }
}
