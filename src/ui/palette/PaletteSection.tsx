import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CircleQuestionMark, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Project } from "@/doc/project";
import { cn } from "@/lib/utils";
import { strings } from "@/strings";
import { activeAfterDelete } from "../activeColor";
import { useProjectPalette } from "../useProjectState";
import { ColorChip } from "./ColorChip";
import { ColorEditSession } from "./colorSession";
import { ColorPickerPanel } from "./ColorPickerPanel";
import { DeleteColorDialog } from "./DeleteColorDialog";
import { SwatchGrid } from "./SwatchGrid";

/** Marks the buttons that open the editing popover: a press on them must not end the session first (their own click does). */
const EDIT_TRIGGER_ATTR = "data-color-edit-trigger";

interface PaletteSectionProps {
  project: Project;
  active: number;
  onActive: (state: number) => void;
}

/**
 * The design palette on the Paint tab: swatches, an add button, and for the active color its
 * name and hex with Edit and Delete. Editing opens a popover picker whose whole session is one
 * undo step (see ColorEditSession); deleting asks where the surface should go.
 */
export function PaletteSection({ project, active, onActive }: PaletteSectionProps) {
  const palette = useProjectPalette(project);
  const color = palette[active];
  const canDelete = palette.length > 2; // the last color cannot be deleted

  const session = useMemo(() => new ColorEditSession(project), [project]);
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("#FFFFFF");
  const [deleting, setDeleting] = useState<number | null>(null);
  const hexInput = useRef<HTMLInputElement>(null);
  const addTitleId = useId();
  const editTitleId = useId();

  const openEditor = useCallback(
    (state: number) => {
      setAdding(false);
      onActive(state);
      session.begin(state);
      setEditing(state);
    },
    [session, onActive],
  );
  const closeEditor = useCallback(() => {
    session.end();
    setEditing(null);
  }, [session]);

  // The session must always close: Escape and outside clicks (Radix calls onOpenChange), unmount, and a new project.
  useEffect(() => () => session.end(), [session]);
  useEffect(() => {
    setEditing(null);
    setAdding(false);
    setDeleting(null);
  }, [project]);

  // A press on the 3D view starts a brush stroke in its own capture handler, which is later than this one.
  // The picker's step has to be closed before that stroke can begin, or both would share one undo step.
  useEffect(() => {
    if (editing === null) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest(`[data-slot='popover-content'], [${EDIT_TRIGGER_ATTR}]`)) return;
      closeEditor();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [editing, closeEditor]);

  const confirmAdd = () => {
    onActive(project.addColor(draft));
    setAdding(false);
  };

  const confirmDelete = (state: number, mergeInto: number) => {
    try {
      project.deleteColor(state, mergeInto);
      onActive(activeAfterDelete(active, state, mergeInto));
    } catch (e) {
      console.error("Could not delete the color", e);
    }
    setDeleting(null);
  };

  return (
    <div className="space-y-3">
      <SwatchGrid
        palette={palette}
        active={active}
        onSelect={onActive}
        onEdit={openEditor}
        onDelete={setDeleting}
        canDelete={canDelete}
      >
        <Popover
          open={adding}
          onOpenChange={(open) => {
            if (open) {
              closeEditor();
              setDraft(project.suggestColor());
            }
            setAdding(open);
          }}
        >
          <Tooltip>
            <PopoverTrigger asChild>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={strings.palette.add}
                  className="grid aspect-square w-full cursor-pointer place-items-center rounded-md border border-dashed border-foreground/40 text-muted-foreground outline-none transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/60 aria-expanded:border-foreground aria-expanded:text-foreground"
                >
                  <Plus className="size-4" />
                </button>
              </TooltipTrigger>
            </PopoverTrigger>
            <TooltipContent side="bottom">{strings.palette.add}</TooltipContent>
          </Tooltip>
          <PopoverContent side="left" align="start" sideOffset={12} className="w-64" aria-labelledby={addTitleId} onOpenAutoFocus={(e) => { e.preventDefault(); hexInput.current?.select(); hexInput.current?.focus(); }}>
            <div id={addTitleId} className="text-sm font-medium">{strings.palette.addTitle}</div>
            <ColorPickerPanel initialColor={draft} onChange={setDraft} onSubmit={confirmAdd} hexRef={hexInput} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setAdding(false)}>
                {strings.palette.cancel}
              </Button>
              <Button size="sm" onClick={confirmAdd}>
                {strings.palette.addConfirm}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </SwatchGrid>

      {color && (
        <Popover
          open={editing !== null}
          onOpenChange={(open) => {
            if (open) openEditor(active);
            else closeEditor();
          }}
        >
          <PopoverAnchor asChild>
            <div className="flex items-center gap-2 rounded-md border px-2 py-1.5" aria-label={strings.palette.active} role="group">
              <ColorChip color={color.color} className="size-7 rounded-md" />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {strings.palette.colorName(active)}
                  {!color.known && <UnknownBadge />}
                </div>
                <div className="font-mono text-xs text-muted-foreground">{color.color}</div>
              </div>
              <Tooltip>
                <PopoverTrigger asChild>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={strings.palette.edit} {...{ [EDIT_TRIGGER_ATTR]: "" }}>
                      <Pencil />
                    </Button>
                  </TooltipTrigger>
                </PopoverTrigger>
                <TooltipContent side="bottom">{strings.palette.edit}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* aria-disabled instead of disabled so the reason can still be read by hover and focus. */}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={strings.palette.delete}
                    aria-disabled={!canDelete}
                    className={cn(!canDelete && "cursor-not-allowed opacity-50 hover:bg-transparent")}
                    onClick={() => canDelete && setDeleting(active)}
                  >
                    <Trash2 />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{canDelete ? strings.palette.delete : strings.palette.deleteLast}</TooltipContent>
              </Tooltip>
            </div>
          </PopoverAnchor>
          <PopoverContent side="left" align="start" sideOffset={12} className="w-64" aria-labelledby={editTitleId} onOpenAutoFocus={(e) => { e.preventDefault(); hexInput.current?.select(); hexInput.current?.focus(); }}>
            <div id={editTitleId} className="text-sm font-medium">{strings.palette.editTitle(editing ?? active)}</div>
            {/* Remounted per color so the picker starts from that color. */}
            {editing !== null && palette[editing] && (
              <ColorPickerPanel key={editing} initialColor={palette[editing].color} onChange={(hex) => session.set(hex)} onSubmit={closeEditor} hexRef={hexInput} />
            )}
            <p className="text-xs text-muted-foreground">{strings.palette.editHint}</p>
            <div className="flex justify-end">
              <Button size="sm" onClick={closeEditor}>
                {strings.palette.done}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}

      <DeleteColorDialog project={project} state={deleting} onCancel={() => setDeleting(null)} onDelete={confirmDelete} />
    </div>
  );
}

/** "Unknown color" marker with its explanation, focusable so the tooltip also works from the keyboard. */
function UnknownBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${strings.palette.unknown}. ${strings.palette.unknownHint}`}
          className="inline-flex items-center gap-1 rounded-full border border-foreground/30 px-1.5 py-0.5 text-[10px] leading-none font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          <CircleQuestionMark className="size-3" />
          {strings.palette.unknown}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-56">
        {strings.palette.unknownHint}
      </TooltipContent>
    </Tooltip>
  );
}
