import { Box, Brush, Eraser, MousePointerClick, PaintBucket, Pipette, Replace, Sparkles } from "lucide-react";
import { strings } from "@/strings";
import type { ToolId } from "@/tools/types";

export type { ToolId };

// `key` is the single-letter shortcut (see tools/keys.ts, which maps the keys to tools).
// `region` marks smart fill, guided fill and AI Paint: each picks a region its own way, so one
// stands in for another when it fails, and the rail groups them.
export const TOOLS: { id: ToolId; label: string; hint: string; key: string; Icon: typeof Brush; region?: true }[] = [
  { id: "brush", label: strings.tools.brush, hint: strings.tools.hints.brush, key: "B", Icon: Brush },
  { id: "shellFill", label: strings.tools.shellFill, hint: strings.tools.hints.shellFill, key: "F", Icon: Box },
  { id: "smartFill", label: strings.tools.smartFill, hint: strings.tools.hints.smartFill, key: "S", Icon: PaintBucket, region: true },
  { id: "guidedFill", label: strings.tools.guidedFill, hint: strings.tools.hints.guidedFill, key: "G", Icon: MousePointerClick, region: true },
  { id: "aiPaint", label: strings.tools.aiPaint, hint: strings.tools.hints.aiPaint, key: "A", Icon: Sparkles, region: true },
  { id: "eraser", label: strings.tools.eraser, hint: strings.tools.hints.eraser, key: "E", Icon: Eraser },
  { id: "replaceColor", label: strings.tools.replaceColor, hint: strings.tools.hints.replaceColor, key: "R", Icon: Replace },
  { id: "eyedropper", label: strings.tools.eyedropper, hint: strings.tools.hints.eyedropper, key: "I", Icon: Pipette },
];
