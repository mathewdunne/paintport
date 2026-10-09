import { useCallback, useState } from "react";
import type { Project } from "@/doc/project";
import type { ViewMode } from "./viewMode";

/** Design or Print. A different project starts in Design again (the choice belongs to the project it was made in). */
export function useViewMode(project: Project | null): { view: ViewMode; setView: (view: ViewMode) => void } {
  const [choice, setChoice] = useState<{ project: Project | null; view: ViewMode }>({ project, view: "design" });
  const setView = useCallback((view: ViewMode) => setChoice({ project, view }), [project]);
  return { view: choice.project === project ? choice.view : "design", setView };
}
