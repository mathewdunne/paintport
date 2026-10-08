import { Brush, Eraser, PaintBucket, Pipette, Wand2 } from "lucide-react";
import { strings } from "@/strings";
import type { ToolId } from "@/tools/types";

export type { ToolId };

// `key` is the single-letter shortcut (see tools/keys.ts, which maps the keys to tools).
export const TOOLS: { id: ToolId; label: string; key: string; Icon: typeof Brush }[] = [
  { id: "brush", label: strings.tools.brush, key: "B", Icon: Brush },
  { id: "shellFill", label: strings.tools.shellFill, key: "F", Icon: PaintBucket },
  { id: "smartFill", label: strings.tools.smartFill, key: "S", Icon: Wand2 },
  { id: "eraser", label: strings.tools.eraser, key: "E", Icon: Eraser },
  { id: "eyedropper", label: strings.tools.eyedropper, key: "I", Icon: Pipette },
];
