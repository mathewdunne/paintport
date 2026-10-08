import { useCallback, useEffect, useState } from "react";
import type { Project } from "@/doc/project";
import { DEFAULT_RADIUS, stepRadius } from "@/tools/radius";
import type { PaintSettings } from "@/tools/types";

export const DEFAULT_SMART_ANGLE = 30;

/** The tool, active color, brush radius and fill settings the Paint tab edits and the paint tools use. */
export function usePaintSettings(project: Project | null) {
  const [settings, setSettings] = useState<PaintSettings>({
    tool: "brush",
    activeState: 1,
    radius: DEFAULT_RADIUS,
    paintThrough: false,
    smartAngle: DEFAULT_SMART_ANGLE,
  });
  const patch = useCallback((p: Partial<PaintSettings>) => setSettings((s) => ({ ...s, ...p })), []);
  const step = useCallback((direction: -1 | 1) => setSettings((s) => ({ ...s, radius: stepRadius(s.radius, direction) })), []);

  // A new project starts with its first color selected.
  useEffect(() => {
    setSettings((s) => (s.activeState === 1 ? s : { ...s, activeState: 1 }));
  }, [project]);

  return { settings, patch, step };
}
