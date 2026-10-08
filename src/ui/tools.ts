import { useEffect } from "react";
import { Brush, Eraser, PaintBucket, Pipette, Wand2 } from "lucide-react";
import { strings } from "@/strings";

export type ToolId = "brush" | "shellFill" | "smartFill" | "eraser" | "eyedropper";

// `key` is the single-letter shortcut; selecting a tool is placeholder-only until phase 2.
export const TOOLS: { id: ToolId; label: string; key: string; Icon: typeof Brush }[] = [
  { id: "brush", label: strings.tools.brush, key: "B", Icon: Brush },
  { id: "shellFill", label: strings.tools.shellFill, key: "F", Icon: PaintBucket },
  { id: "smartFill", label: strings.tools.smartFill, key: "S", Icon: Wand2 },
  { id: "eraser", label: strings.tools.eraser, key: "E", Icon: Eraser },
  { id: "eyedropper", label: strings.tools.eyedropper, key: "I", Icon: Pipette },
];

function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.matches("input, textarea, select");
}

/** Global tool shortcuts (B F S E I). Ignored while typing or with Ctrl/Meta/Alt held. */
export function useToolShortcuts(select: (tool: ToolId) => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
      const key = e.key.toUpperCase();
      const tool = TOOLS.find((t) => t.key === key);
      if (tool) select(tool.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [select]);
}
