import { useEffect, useState } from "react";
import type { Project } from "@/doc/project";
import { objectSpaceSphere } from "@/doc/transform";

/**
 * The automatic smart fill feature size of the project's largest object, in world millimetres
 * (0 when that mesh is compared edge by edge), for the Advanced section to show. Undefined until
 * computed: it needs the mesh topology, so it is worked out after the panel has rendered, and
 * only while `active`.
 */
export function useAutoFeatureScale(project: Project | null, active: boolean): number | undefined {
  const [result, setResult] = useState<{ project: Project; mm: number } | null>(null);
  useEffect(() => {
    if (!project || !active || result?.project === project) return;
    const timer = window.setTimeout(() => {
      if (project.objects.length === 0) return;
      let largest = 0;
      project.objects.forEach((o, i) => { if (o.triCount > project.objects[largest].triCount) largest = i; });
      const objectPerWorld = objectSpaceSphere(project.objects[largest].transform, [0, 0, 0], 1).radius;
      setResult({ project, mm: project.autoFeatureScale(largest) / objectPerWorld });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [project, active, result]);
  return result?.project === project ? result.mm : undefined;
}
