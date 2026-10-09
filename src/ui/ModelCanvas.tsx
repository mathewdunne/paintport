import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Project } from "@/doc/project";
import { strings } from "@/strings";
import { PaintController, type GuidedState } from "@/tools/PaintController";
import type { PaintSettings } from "@/tools/types";
import { ModelViewer } from "@/view/ModelViewer";
import { projectToScene } from "@/view/projectScene";
import { syncViewerToProject } from "@/view/projectSync";
import type { HiddenObjects } from "./objectVisibility";

const isDark = () => document.documentElement.classList.contains("dark");

interface ModelCanvasProps {
  project: Project | null;
  settings: PaintSettings;
  /** Objects not to draw, pick or paint (view state). */
  hiddenObjects: HiddenObjects;
  /** The eyedropper picked a design color. */
  onPickState: (state: number) => void;
  /** False in the Print view (view-only): the paint tools do nothing and the left button orbits. */
  toolsEnabled: boolean;
  /** Colors of the Print view per design state (undefined: show the design color), or null for the Design view. */
  printColors: readonly (string | undefined)[] | null;
  /** The viewer could not start, build the model or draw it. */
  onFailed: () => void;
}

/** Mounts the three.js viewer and keeps it in sync with the project and the theme; paint tools act on it. */
export function ModelCanvas({ project, settings, hiddenObjects, onPickState, toolsEnabled, printColors, onFailed }: ModelCanvasProps) {
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
  const latestToolsEnabled = useRef(toolsEnabled);
  latestToolsEnabled.current = toolsEnabled;
  const [guided, setGuided] = useState<GuidedState | null>(null);

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
    const ctl = new PaintController(project, v, { onPickState: (s) => picked.current(s), onSwatch: showSwatch, onGuided: setGuided }, latestSettings.current);
    ctl.setEnabled(latestToolsEnabled.current);
    controller.current = ctl;
    return () => {
      ctl.dispose();
      unsync();
      controller.current = null;
      showSwatch(null);
      setGuided(null);
    };
  }, [project, showSwatch]);

  useEffect(() => {
    controller.current?.setSettings(settings);
  }, [settings]);

  // Print view: the tools are off and the left button orbits like the right one.
  useEffect(() => {
    controller.current?.setEnabled(toolsEnabled);
    viewer.current?.setLeftDragOrbits(!toolsEnabled);
  }, [toolsEnabled]);

  // The color table of the Print view. The viewer keeps it across scenes, so a new project (which starts in Design) resets it here too.
  useEffect(() => {
    viewer.current?.setPrintColors(project ? printColors : null);
  }, [project, printColors]);

  // After the scene effect: a new scene starts with everything visible, so the hidden set is applied again.
  useEffect(() => {
    const v = viewer.current;
    if (!v || !project) return;
    project.objects.forEach((_, i) => v.setObjectVisible(i, !hiddenObjects.has(i)));
  }, [project, hiddenObjects]);

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
      {project && toolsEnabled && settings.tool === "guidedFill" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-16 flex justify-center px-3">
          <div role="status" className="pointer-events-auto flex flex-col items-center gap-1 rounded-lg border bg-background/95 px-3 py-2 text-xs shadow-sm">
            {guided ? (
              <>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums">{strings.viewport.guidedRegion(guided.tris, guided.inside, guided.outside)}</span>
                  <Button size="xs" onClick={() => controller.current?.commitGuided()} disabled={guided.tris === 0}>
                    {strings.viewport.guidedPaint}
                    <kbd className="font-sans opacity-70">{strings.viewport.guidedPaintKey}</kbd>
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => controller.current?.clearGuided()}>
                    {strings.viewport.guidedClear}
                    <kbd className="font-sans opacity-70">{strings.viewport.guidedClearKey}</kbd>
                  </Button>
                </div>
                <span className="text-muted-foreground">{strings.viewport.guidedKeys}</span>
              </>
            ) : (
              <span className="text-muted-foreground">{strings.viewport.guidedStart}</span>
            )}
          </div>
        </div>
      )}
    </>
  );
}
