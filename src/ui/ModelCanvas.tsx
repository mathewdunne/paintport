import { useCallback, useEffect, useRef } from "react";
import type { Project } from "@/doc/project";
import { strings } from "@/strings";
import { PaintController } from "@/tools/PaintController";
import type { PaintSettings } from "@/tools/types";
import { ModelViewer } from "@/view/ModelViewer";
import { projectToScene } from "@/view/projectScene";
import { syncViewerToProject } from "@/view/projectSync";

const isDark = () => document.documentElement.classList.contains("dark");

interface ModelCanvasProps {
  project: Project | null;
  settings: PaintSettings;
  /** The eyedropper picked a design color. */
  onPickState: (state: number) => void;
  /** The viewer could not start, build the model or draw it. */
  onFailed: () => void;
}

/** Mounts the three.js viewer and keeps it in sync with the project and the theme; paint tools act on it. */
export function ModelCanvas({ project, settings, onPickState, onFailed }: ModelCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  const swatch = useRef<HTMLSpanElement>(null);
  const hex = useRef<HTMLSpanElement>(null);
  const viewer = useRef<ModelViewer | null>(null);
  const controller = useRef<PaintController | null>(null);
  const failed = useRef(onFailed);
  failed.current = onFailed;
  const picked = useRef(onPickState);
  picked.current = onPickState;
  const latestSettings = useRef(settings);
  latestSettings.current = settings;

  // The eyedropper's color chip follows the cursor. Updated through the DOM: it moves with
  // every pointer move, and React need not render for that.
  const showSwatch = useCallback((s: { x: number; y: number; color: string } | null) => {
    const el = chip.current, box = host.current;
    if (!el || !box || !swatch.current || !hex.current) return;
    if (!s) {
      el.style.display = "none";
      return;
    }
    const rect = box.getBoundingClientRect();
    swatch.current.style.backgroundColor = s.color;
    hex.current.textContent = s.color;
    el.style.display = "flex";
    el.style.transform = `translate(${Math.round(s.x - rect.left + 16)}px, ${Math.round(s.y - rect.top + 16)}px)`;
  }, []);

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
    const v = viewer.current;
    if (!v) return;
    let scene;
    try {
      scene = project ? projectToScene(project) : null;
      v.setScene(scene);
    } catch {
      failed.current(); // e.g. an allocation failure while preparing the scene
      return;
    }
    if (!project || !scene) return;
    const unsync = syncViewerToProject(project, scene, v);
    const ctl = new PaintController(project, v, { onPickState: (s) => picked.current(s), onSwatch: showSwatch }, latestSettings.current);
    controller.current = ctl;
    return () => {
      ctl.dispose();
      unsync();
      controller.current = null;
      showSwatch(null);
    };
  }, [project, showSwatch]);

  useEffect(() => {
    controller.current?.setSettings(settings);
  }, [settings]);

  return (
    <>
      <div ref={host} role="img" aria-label={strings.viewport.canvasLabel} className="absolute inset-0" />
      <div
        ref={chip}
        aria-hidden
        title={strings.viewport.eyedropperChip}
        style={{ display: "none" }}
        className="pointer-events-none absolute top-0 left-0 z-10 items-center gap-1.5 rounded-md border bg-background/95 px-1.5 py-1 text-xs shadow-sm"
      >
        <span ref={swatch} className="size-4 rounded-sm border" />
        <span ref={hex} className="font-mono tabular-nums" />
      </div>
    </>
  );
}
