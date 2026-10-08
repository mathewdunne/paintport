import { useEffect, useRef } from "react";
import { interpretKey } from "@/tools/keys";
import type { ToolId } from "@/tools/types";
import type { Project } from "@/doc/project";
import { blocksShortcuts } from "./shortcutGuard";

interface ShortcutHandlers {
  project: Project | null;
  onTool: (tool: ToolId) => void;
  onRadius: (direction: -1 | 1) => void;
}

/**
 * Global editor shortcuts: tools (B F S E I), brush radius ([ ]) and undo/redo
 * (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y). Ignored while the focus is in a text field, popover, menu, dialog or
 * the color picker (see shortcutGuard.ts), where those keys belong to the widget.
 */
export function useEditorShortcuts(handlers: ShortcutHandlers) {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const action = interpretKey(e, blocksShortcuts(e.target));
      if (!action) return;
      const { project, onTool, onRadius } = latest.current;
      switch (action.type) {
        case "tool":
          if (!e.repeat) onTool(action.tool);
          break;
        case "radius":
          onRadius(action.direction);
          break;
        case "undo":
          e.preventDefault();
          project?.undo();
          break;
        case "redo":
          e.preventDefault();
          project?.redo();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
