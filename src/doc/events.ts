/**
 * What changed in a project, for the viewer and the UI. Emitted after the project is in
 * its new, consistent state; undo and redo emit the same events as the original edit.
 */
export type ProjectEvent =
  /**
   * Stored paint changed on exactly these triangles of object `object`: re-read their
   * display state (`resolveStatesInto`) and recolor them. A triangle that only lost its
   * preserved sub-triangle detail can be in the list without its color changing.
   * `tris` is shared with the undo history: do not modify it.
   */
  | { kind: "paint"; object: number; tris: Uint32Array }
  /**
   * The base color of these parts (indices into `ProjectObject.parts`) of `object`
   * changed: recolor their unpainted triangles (a part's triangles are
   * `firstTri .. firstTri + triCount`).
   */
  | { kind: "base"; object: number; parts: number[] }
  /**
   * Palette colors changed (`project.palette` is a new array). With `renumbered: false`
   * states keep their meaning: rewrite the color table and recolor the triangles that show
   * a state in `changed` (states whose color value differs now, including colors that were
   * added or removed; empty if only a "known" flag changed). With `renumbered: true`
   * states were merged or renumbered (color deleted, or the undo/redo of that):
   * re-resolve every object's display states; `changed` is empty then. No separate paint
   * or base events follow such a change.
   */
  | { kind: "palette"; renumbered: boolean; changed: number[] }
  /**
   * The undo history or the stroke state changed (`canUndo`, `canRedo`, `strokeOpen`):
   * refresh toolbar buttons and schedule an autosave.
   */
  | { kind: "history" };

export type ProjectListener = (event: ProjectEvent) => void;
