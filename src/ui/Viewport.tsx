import { useRef, useState, type DragEvent } from "react";
import { Box, Info, Loader2, TriangleAlert, X } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Project } from "@/doc/project";
import { cn } from "@/lib/utils";
import { strings } from "@/strings";
import type { Segmenter } from "@/sam/types";
import type { PaintSettings } from "@/tools/types";
import { ModelCanvas } from "./ModelCanvas";
import type { HiddenObjects } from "./objectVisibility";
import type { Notice } from "./useNotices";
import { toolsEnabled, type ViewMode } from "./viewMode";
import { SELECTED_TOGGLE } from "./selectedStyle";

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

interface ViewportProps {
  project: Project | null;
  settings: PaintSettings;
  /** The eyedropper picked a design color. */
  onPickState: (state: number) => void;
  /** Design colors or the Print preview. */
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  /** Colors of the Print preview per design state, or null in the Design view. */
  printColors: readonly (string | undefined)[] | null;
  /** What the app is busy with (reading a file, restoring the last session), or null. */
  busy: string | null;
  error: string | null;
  /** Hidden objects (view state). */
  hiddenObjects: HiddenObjects;
  /** Short messages: extra dropped files ignored, session restored, autosave trouble. */
  notices: readonly Notice[];
  onDismissError: () => void;
  onDismissNotice: (id: number) => void;
  onImportFiles: (files: ArrayLike<File>) => void;
  /** AI Paint's model, or null while it isn't loaded. */
  segmenter: Segmenter | null;
}

export function Viewport({ project, settings, onPickState, view, onViewChange, printColors, busy, error, hiddenObjects, notices, onDismissError, onDismissNotice, onImportFiles, segmenter }: ViewportProps) {
  const [dragging, setDragging] = useState(false);
  const [viewerFailed, setViewerFailed] = useState(false);
  const depth = useRef(0); // dragenter/dragleave also fire for children

  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current++;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    if (--depth.current <= 0) {
      depth.current = 0;
      setDragging(false);
    }
  };
  const onDragOver = (e: DragEvent) => {
    if (hasFiles(e)) e.preventDefault(); // allow the drop
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    onImportFiles(e.dataTransfer.files);
  };

  return (
    <main
      className="relative min-w-0 flex-1 overflow-hidden bg-muted/40"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ModelCanvas
        project={project}
        settings={settings}
        hiddenObjects={hiddenObjects}
        onPickState={onPickState}
        toolsEnabled={toolsEnabled(view)}
        printColors={printColors}
        segmenter={segmenter}
        onFailed={() => setViewerFailed(true)}
      />

      {!project && !busy && !viewerFailed && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
          <Box className="size-8 opacity-60" strokeWidth={1.5} />
          <p className="text-sm font-medium">{strings.viewport.emptyTitle}</p>
          <p className="text-xs">{strings.viewport.emptyHint}</p>
        </div>
      )}

      {viewerFailed && (
        <p className="absolute inset-0 flex items-center justify-center bg-muted p-6 text-center text-sm text-muted-foreground">
          {strings.viewport.viewerFailed}
        </p>
      )}

      {/* One stack, so a busy indicator, an import error and the notices (restored session, other tab, autosave trouble) can all be read at once. */}
      <div className="pointer-events-none absolute top-3 left-1/2 flex w-[min(28rem,calc(100%-1.5rem))] -translate-x-1/2 flex-col items-center gap-2 *:pointer-events-auto">
        {busy && (
          <div role="status" className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm shadow-sm">
            <Loader2 className="size-4 animate-spin" />
            {busy}
          </div>
        )}

        {error && (
          <Alert variant="destructive" className="shadow-sm">
            <AlertTitle>{strings.errors.title}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="icon-xs" onClick={onDismissError} aria-label={strings.errors.dismiss}>
                <X />
              </Button>
            </AlertAction>
          </Alert>
        )}

        {notices.map((n) => (
          <Alert key={n.id} className="shadow-sm">
            {n.tone === "warning" ? <TriangleAlert /> : <Info />}
            <AlertDescription>{n.text}</AlertDescription>
            <AlertAction>
              <Button variant="ghost" size="icon-xs" onClick={() => onDismissNotice(n.id)} aria-label={strings.errors.dismiss}>
                <X />
              </Button>
            </AlertAction>
          </Alert>
        ))}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium">
          {strings.viewport.dropHint}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-4 flex flex-col items-center gap-2">
        {/* Always in the page, so a screen reader hears the text when it appears. */}
        <p role="status" className="rounded-md bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm empty:sr-only">
          {view === "print" ? strings.viewport.printNote : null}
        </p>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          // Radix emits "" when the selected item is clicked again; keep the current view.
          onValueChange={(v) => v && project && onViewChange(v as ViewMode)}
          aria-label={strings.viewport.viewMode}
          className="bg-background shadow-sm"
        >
          <ToggleGroupItem value="design" className={`px-3 ${SELECTED_TOGGLE}`}>
            {strings.viewport.design}
          </ToggleGroupItem>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* aria-disabled, not disabled: the button keeps hover and focus, so the tooltip works without a model too. */}
              <ToggleGroupItem
                value="print"
                aria-disabled={!project || undefined}
                className={cn("px-3", SELECTED_TOGGLE, !project && "cursor-not-allowed opacity-50 hover:bg-transparent")}
              >
                {strings.viewport.print}
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="top">{strings.viewport.printHint}</TooltipContent>
          </Tooltip>
        </ToggleGroup>
      </div>
    </main>
  );
}
