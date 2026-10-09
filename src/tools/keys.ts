import type { ToolId } from "./types";

export const TOOL_KEYS: Record<string, ToolId> = { B: "brush", F: "shellFill", S: "smartFill", G: "guidedFill", E: "eraser", I: "eyedropper" };

export type KeyAction =
  | { type: "tool"; tool: ToolId }
  | { type: "radius"; direction: -1 | 1 }
  | { type: "undo" }
  | { type: "redo" };

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * What a key press means for the editor, or null. `typing` is true while a text field has
 * the focus: then nothing applies, so typing a hex color never switches tools.
 */
export function interpretKey(e: KeyLike, typing: boolean): KeyAction | null {
  if (typing) return null;
  // Shift turns `[` and `]` into `{` and `}` on some layouts, and Shift is also the erase modifier.
  const key = e.key === "{" ? "[" : e.key === "}" ? "]" : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const command = (e.ctrlKey || e.metaKey) && !e.altKey;
  if (command) {
    if (key === "z") return e.shiftKey ? { type: "redo" } : { type: "undo" };
    if (key === "y" && !e.shiftKey) return { type: "redo" };
    return null;
  }
  // Windows reports AltGr as Ctrl+Alt: that is how `[` and `]` are typed on some layouts.
  const altGr = e.ctrlKey && e.altKey && !e.metaKey;
  if (key === "[" && (altGr || !e.altKey)) return { type: "radius", direction: -1 };
  if (key === "]" && (altGr || !e.altKey)) return { type: "radius", direction: 1 };
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const tool = TOOL_KEYS[key.toUpperCase()];
  return tool ? { type: "tool", tool } : null;
}
