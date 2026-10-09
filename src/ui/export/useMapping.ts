import { useMemo, useSyncExternalStore } from "react";
import type { Project } from "@/doc/project";
import type { ExportSettings } from "@/persist/exportSettings";
import { useProjectMapping, useProjectPalette } from "../useProjectState";
import { computeMapping, type MappingModel } from "./mappingView";
import { UsedStatesTracker } from "./usedStates";

const noStates: readonly number[] = [];
const noSubscribe = () => () => {};

/**
 * The live mapping of the project's used design colors to the current spools: what each prints
 * as, and the warnings. Null while `enabled` is false (nothing needs it, so no work is done).
 *
 * Recomputes when the palette, the pins, the spool settings or the set of used colors change.
 * The set of used colors is tracked by `UsedStatesTracker`, which keeps whole-mesh scans off the
 * brush path.
 */
export function useMapping(project: Project | null, settings: ExportSettings, enabled: boolean): MappingModel | null {
  // Not subscribed while unused, so palette edits (a color-picker drag) do not re-render the app for nothing.
  const watched = enabled ? project : null;
  const palette = useProjectPalette(watched);
  const pins = useProjectMapping(watched);
  const tracker = useMemo(() => (project && enabled ? new UsedStatesTracker(project) : null), [project, enabled]);
  const states = useSyncExternalStore(tracker ? tracker.subscribe : noSubscribe, tracker ? tracker.getSnapshot : () => noStates);
  const { spools, printerCount, target, allowMix } = settings;
  return useMemo(
    () => (project && tracker ? computeMapping(project, settings, states) : null),
    // palette and pins are not read here, but project.palette / project.mapping are replaced when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, tracker, states, palette, pins, spools, printerCount, target, allowMix],
  );
}
