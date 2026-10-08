import { useEffect, useRef } from "react";
import type { Project } from "@/doc/project";
import { strings } from "@/strings";
import { ModelViewer } from "@/view/ModelViewer";
import { projectToScene } from "@/view/projectScene";

const isDark = () => document.documentElement.classList.contains("dark");

interface ModelCanvasProps {
  project: Project | null;
  /** The viewer could not start, build the model or draw it. */
  onFailed: () => void;
}

/** Mounts the three.js viewer and keeps it in sync with the project and the theme. */
export function ModelCanvas({ project, onFailed }: ModelCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<ModelViewer | null>(null);
  const failed = useRef(onFailed);
  failed.current = onFailed;

  // Declared before the scene effect: effects run in order, so the viewer exists by then.
  useEffect(() => {
    let created: ModelViewer;
    try {
      created = new ModelViewer(host.current!, () => failed.current());
    } catch {
      failed.current();
      return;
    }
    viewer.current = created;
    created.setDark(isDark());
    const observer = new MutationObserver(() => created.setDark(isDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      created.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    try {
      viewer.current?.setScene(project ? projectToScene(project) : null);
    } catch {
      failed.current(); // e.g. an allocation failure while preparing the scene
    }
  }, [project]);

  return <div ref={host} role="img" aria-label={strings.viewport.canvasLabel} className="absolute inset-0" />;
}
