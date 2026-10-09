// The viewport shows the design colors or the colors the print will have (spec Q8.3).
// Print is view-only: the paint tools and their shortcuts are off. DOM- and React-free.
import type { KeyAction } from "@/tools/keys";

export type ViewMode = "design" | "print";

/** Everything that edits the design from the viewport or the keyboard (the paint tools, their keys, undo and redo) works in the Design view only. */
export const toolsEnabled = (view: ViewMode): boolean => view === "design";

/**
 * Whether an editor key applies. Print is view-only, so none does there, undo and redo included.
 * (Edits made by explicit panel actions, such as editing a palette color, stay possible.)
 */
export function keyActionAllowed(_action: KeyAction, toolsOn: boolean): boolean {
  return toolsOn;
}
