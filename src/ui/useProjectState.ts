import { useCallback, useSyncExternalStore } from "react";
import type { MappingPin } from "@/doc/pins";
import type { DesignColor, PartId, Project } from "@/doc/project";

const noop = () => {};
const emptyPalette: readonly DesignColor[] = [];
const emptyBase: ReadonlyMap<PartId, number> = new Map();
const emptyPins: ReadonlyMap<number, MappingPin> = new Map();

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

/** Base color per part; a new map whenever a base color changes (also when colors are deleted, which moves them). */
export function useProjectBase(project: Project | null): ReadonlyMap<PartId, number> {
  const subscribe = useCallback(
    (onChange: () => void) => (project ? project.subscribe((e) => { if (e.kind === "base" || e.kind === "palette") onChange(); }) : noop),
    [project],
  );
  return useSyncExternalStore(subscribe, () => (project ? project.baseColor : emptyBase));
}

/** The mapping pins; a new map whenever one is set, dropped or moved (also by color deletes and their undo). */
export function useProjectMapping(project: Project | null): ReadonlyMap<number, MappingPin> {
  const subscribe = useCallback(
    (onChange: () => void) => (project ? project.subscribe((e) => { if (e.kind === "mapping") onChange(); }) : noop),
    [project],
  );
  return useSyncExternalStore(subscribe, () => (project ? project.mapping : emptyPins));
}
