import { useCallback, useState } from "react";
import type { Project } from "@/doc/project";
import { isolate, NONE_HIDDEN, toggleHidden, type HiddenObjects } from "./objectVisibility";

/**
 * Which objects the Objects tab has hidden. View state: not undoable and not saved. It belongs
 * to one project; a different project starts with everything shown (the state is keyed by
 * project, so there is no frame in which the old project's choice applies to the new one).
 */
export function useObjectVisibility(project: Project | null) {
  const [state, setState] = useState<{ project: Project | null; hidden: HiddenObjects }>({ project: null, hidden: NONE_HIDDEN });
  const hidden = state.project === project ? state.hidden : NONE_HIDDEN;

  const update = useCallback(
    (change: (hidden: HiddenObjects) => HiddenObjects) =>
      setState((s) => ({ project, hidden: change(s.project === project ? s.hidden : NONE_HIDDEN) })),
    [project],
  );
  const toggle = useCallback((index: number) => update((h) => toggleHidden(h, index)), [update]);
  const solo = useCallback((index: number) => update((h) => isolate(h, index, project?.objects.length ?? 0)), [update, project]);
  const showAll = useCallback(() => update(() => NONE_HIDDEN), [update]);
  return { hidden, toggle, solo, showAll };
}
