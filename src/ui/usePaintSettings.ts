import { useCallback, useEffect, useState } from "react";
import type { Project } from "@/doc/project";
import { loadPaintPrefs, savePaintPrefs } from "@/persist/paintSettings";
import { stepRadius } from "@/tools/radius";
import { DEFAULT_SMART_ANGLE, DEFAULT_SMART_SCALE } from "@/tools/sensitivity";
import type { PaintSettings } from "@/tools/types";
import { clampActiveState, remapActiveState } from "./activeColor";

/**
 * The tool, active color, brush radius and fill settings the Paint tab edits and the paint tools use.
 * The slider values and the smart fill Advanced section's open state are remembered across page views.
 *
 * The active color is a palette index, and indices move when a color is deleted (or that is undone
 * or redone): the hook follows the document's palette changes so that the active color stays on
 * the same color, and never points outside the palette (e.g. after undoing the addition of the
 * active color). The paint tools receive the same settings, so they follow too.
 */
export function usePaintSettings(project: Project | null) {
  const [initial] = useState(() => loadPaintPrefs());
  const [settings, setSettings] = useState<PaintSettings>({
    tool: "brush",
    activeState: 1,
    radius: initial.radius,
    paintThrough: false,
    smartAngle: initial.smartAngle,
    smartScale: initial.smartScale,
  });
  const [fillAdvancedOpen, setFillAdvancedOpen] = useState(initial.fillAdvancedOpen);
  const patch = useCallback((p: Partial<PaintSettings>) => setSettings((s) => ({ ...s, ...p })), []);
  const step = useCallback((direction: -1 | 1) => setSettings((s) => ({ ...s, radius: stepRadius(s.radius, direction) })), []);
  const resetSmartFill = useCallback(() => setSettings((s) => ({ ...s, smartAngle: DEFAULT_SMART_ANGLE, smartScale: DEFAULT_SMART_SCALE })), []);

  const { radius, smartAngle, smartScale } = settings;
  useEffect(() => {
    savePaintPrefs({ radius, smartAngle, smartScale, fillAdvancedOpen });
  }, [radius, smartAngle, smartScale, fillAdvancedOpen]);

  // A new project starts with its first color selected.
  useEffect(() => {
    setSettings((s) => (s.activeState === 1 ? s : { ...s, activeState: 1 }));
  }, [project]);

  useEffect(() => {
    if (!project) return;
    let previous = project.palette;
    return project.subscribe((e) => {
      if (e.kind !== "palette") return;
      const before = previous;
      const after = project.palette;
      previous = after;
      setSettings((s) => {
        const active = e.renumbered ? remapActiveState(s.activeState, before, after) : clampActiveState(s.activeState, after.length);
        return active === s.activeState ? s : { ...s, activeState: active };
      });
    });
  }, [project]);

  return { settings, patch, step, resetSmartFill, fillAdvancedOpen, setFillAdvancedOpen };
}
