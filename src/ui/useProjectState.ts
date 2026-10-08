import { useCallback, useSyncExternalStore } from "react";
import type { DesignColor, Project } from "@/doc/project";

const noop = () => {};
const emptyPalette: readonly DesignColor[] = [];

/**
 * Undo/redo availability. Subscribes to history events only, so React does not re-render
 * for every brush dab (the project's `version` changes on every edit).
 */
export function useHistoryState(project: Project | null): { canUndo: boolean; canRedo: boolean } {
  const subscribe = useCallback(
    (onChange: () => void) => (project ? project.subscribe((e) => { if (e.kind === "history") onChange(); }) : noop),
    [project],
  );
  const bits = useSyncExternalStore(subscribe, () => (project ? (project.canUndo ? 1 : 0) | (project.canRedo ? 2 : 0) : 0));
  return { canUndo: (bits & 1) !== 0, canRedo: (bits & 2) !== 0 };
}

/** The design palette; a new array whenever a color changes, so it is a stable snapshot between changes. */
export function useProjectPalette(project: Project | null): readonly DesignColor[] {
  const subscribe = useCallback(
    (onChange: () => void) => (project ? project.subscribe((e) => { if (e.kind === "palette") onChange(); }) : noop),
    [project],
  );
  return useSyncExternalStore(subscribe, () => (project ? project.palette : emptyPalette));
}
