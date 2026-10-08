import { useRef, type ReactNode } from "react";
import { Check } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DesignColor } from "@/doc/project";
import { cn } from "@/lib/utils";
import { strings } from "@/strings";
import { readableOn } from "./hex";
import { swatchKeyHandler } from "./swatchNav";

interface SwatchGridProps {
  palette: readonly DesignColor[];
  active: number;
  onSelect: (state: number) => void;
  /** Context menu actions. The menu acts on the color it was opened on, which is made active first. */
  onEdit: (state: number) => void;
  onDelete: (state: number) => void;
  canDelete: boolean;
  /** Extra cells after the swatches (the "add color" button). */
  children?: ReactNode;
}

/**
 * The design colors as a grid of swatches: one radio group (arrow keys move and select, one tab
 * stop). The active swatch has a thick ring in the foreground color with a gap, plus a check
 * mark in black or white, whichever reads on that color: it shows on white and black colors in
 * both themes and does not depend on hue. Unknown colors carry a small "?" badge.
 */
export function SwatchGrid({ palette, active, onSelect, onEdit, onDelete, canDelete, children }: SwatchGridProps) {
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  // A menu action runs after the menu has closed and returned the focus; opening a popover or dialog earlier would lose the focus again.
  const afterMenu = useRef<(() => void) | null>(null);

  const move = (to: number) => {
    onSelect(to);
    buttons.current.get(to)?.focus();
  };
  return (
    <div className="grid grid-cols-8 gap-1.5 p-1">
      {/* `contents`: the swatches are cells of the grid, but the "add" button after them is not part of the radio group. */}
      <div role="radiogroup" aria-label={strings.palette.list} onKeyDown={swatchKeyHandler(palette.length - 1, move)} className="contents">
      {palette.slice(1).map((c, i) => {
        const state = i + 1;
        const selected = state === active;
        const ink = readableOn(c.color);
        return (
          <ContextMenu key={state}>
            <Tooltip>
              <ContextMenuTrigger asChild>
                <TooltipTrigger asChild>
                  <button
                    ref={(el) => {
                      if (el) buttons.current.set(state, el);
                      else buttons.current.delete(state);
                    }}
                    type="button"
                    role="radio"
                    data-swatch={state}
                    aria-checked={selected}
                    aria-label={strings.palette.swatch(state, c.color, !c.known)}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onSelect(state)}
                    onContextMenu={() => onSelect(state)}
                    className={cn(
                      "relative grid aspect-square w-full cursor-pointer place-items-center rounded-md border border-foreground/25 outline-none transition-shadow",
                      "focus-visible:ring-3 focus-visible:ring-ring/60",
                      selected ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "hover:ring-2 hover:ring-ring/60",
                    )}
                    style={{ backgroundColor: c.color, color: ink }}
                  >
                    {selected ? <Check className="size-4" strokeWidth={3} /> : <span aria-hidden className="text-[10px] leading-none font-medium opacity-70">{state}</span>}
                    {!c.known && (
                      <span
                        aria-hidden
                        className="absolute -top-1 -right-1 grid size-3.5 place-items-center rounded-full border border-foreground/40 bg-background text-[9px] leading-none font-bold text-foreground"
                      >
                        ?
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
              </ContextMenuTrigger>
              <TooltipContent side="bottom" className="flex-col items-start gap-0.5">
                <span>{strings.palette.swatchTip(state, c.color)}</span>
                {!c.known && <span className="max-w-48 opacity-80">{strings.palette.unknownHint}</span>}
              </TooltipContent>
            </Tooltip>
            <ContextMenuContent
              onCloseAutoFocus={(e) => {
                const run = afterMenu.current;
                afterMenu.current = null;
                if (run) {
                  e.preventDefault();
                  run();
                }
              }}
            >
              <ContextMenuItem onSelect={() => { afterMenu.current = () => onEdit(state); }}>{strings.palette.menuEdit}</ContextMenuItem>
              <ContextMenuItem disabled={!canDelete} onSelect={() => { afterMenu.current = () => onDelete(state); }}>
                {strings.palette.menuDelete}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      </div>
      {children}
    </div>
  );
}
