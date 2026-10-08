import { useId, useState } from "react";
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, Focus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DesignColor, Project, ProjectObject } from "@/doc/project";
import { hasBaseColor } from "@/doc/types";
import { cn } from "@/lib/utils";
import { strings } from "@/strings";
import { ColorChip } from "./palette/ColorChip";
import { readableOn } from "./palette/hex";
import { swatchKeyHandler } from "./palette/swatchNav";
import { isIsolated, type HiddenObjects } from "./objectVisibility";
import { useProjectBase, useProjectPalette } from "./useProjectState";

interface ObjectsTabProps {
  project: Project;
  hidden: HiddenObjects;
  onToggle: (index: number) => void;
  onSolo: (index: number) => void;
  onShowAll: () => void;
}

/**
 * The objects of the project: show/hide (an eye), solo (show only this one), and base colors.
 * Names come from the file and are rendered as React text only.
 *
 * Parts: an object with several parts that have a base color shows them in an expandable
 * list with a chooser per ModelPart. Parameter modifiers are listed there read-only, with the
 * color they apply: they are not drawn or painted, so changing their color would have no
 * visible effect until export exists, and the list explains why a color can be "base of a modifier".
 * Negative volumes and supports have no color and are left out.
 */
export function ObjectsTab({ project, hidden, onToggle, onSolo, onShowAll }: ObjectsTabProps) {
  const palette = useProjectPalette(project);
  const base = useProjectBase(project);
  const count = project.objects.length;

  return (
    <div className="space-y-2">
      {hidden.size > 0 && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{strings.objects.hiddenCount(hidden.size)}</span>
          <Button variant="ghost" size="xs" onClick={onShowAll}>
            {strings.objects.showAll}
          </Button>
        </div>
      )}
      <ul className="space-y-1.5" aria-label={strings.objects.list}>
        {project.objects.map((o) => (
          <ObjectRow
            key={o.index}
            project={project}
            object={o}
            palette={palette}
            base={base}
            hidden={hidden.has(o.index)}
            solo={isIsolated(hidden, o.index, count)}
            canSolo={count > 1}
            onToggle={() => onToggle(o.index)}
            onSolo={() => onSolo(o.index)}
          />
        ))}
      </ul>
      {count > 1 && <p className="text-xs text-muted-foreground">{strings.objects.visibilityNote}</p>}
    </div>
  );
}

interface ObjectRowProps {
  project: Project;
  object: ProjectObject;
  palette: readonly DesignColor[];
  base: ReadonlyMap<string, number>;
  hidden: boolean;
  solo: boolean;
  canSolo: boolean;
  onToggle: () => void;
  onSolo: () => void;
}

function ObjectRow({ project, object, palette, base, hidden, solo, canSolo, onToggle, onSolo }: ObjectRowProps) {
  const [open, setOpen] = useState(false);
  const name = object.name || strings.panel.unnamedObject;
  const parts = object.parts.map((part, index) => ({ part, index })).filter(({ part }) => hasBaseColor(part.type));
  const modelParts = parts.filter(({ part }) => part.type === "ModelPart");
  const expandable = parts.length > 1;

  // The object-level base color: the common color of its ModelParts, or "mixed".
  const bases = [...new Set(modelParts.map(({ part }) => base.get(part.id) ?? 0))];
  const shown = bases.length === 1 ? bases[0] : null;

  return (
    <li className="rounded-md border">
      <div className="flex items-center gap-0.5 py-1 pr-1.5 pl-0.5">
        {expandable ? (
          <Button variant="ghost" size="icon-xs" aria-expanded={open} aria-label={open ? strings.objects.collapse(name) : strings.objects.expand(name)} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown /> : <ChevronRight />}
          </Button>
        ) : (
          <span aria-hidden className="size-6 shrink-0" />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-pressed={hidden} aria-label={hidden ? strings.objects.show(name) : strings.objects.hide(name)} onClick={onToggle}>
              {hidden ? <EyeOff /> : <Eye />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{hidden ? strings.objects.show(name) : strings.objects.hide(name)}</TooltipContent>
        </Tooltip>
        <div className={cn("min-w-0 flex-1 px-1.5", hidden && "opacity-50")}>
          {/* File content: rendered as React text only. */}
          <div className="truncate text-sm font-medium" title={name}>
            {name}
          </div>
          <div className="text-xs text-muted-foreground">{strings.panel.triangleCount(object.triCount)}</div>
        </div>
        {canSolo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant={solo ? "secondary" : "ghost"} size="icon-sm" aria-pressed={solo} aria-label={solo ? strings.objects.unisolate : strings.objects.isolate(name)} onClick={onSolo}>
                <Focus />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{solo ? strings.objects.unisolate : strings.objects.isolate(name)}</TooltipContent>
          </Tooltip>
        )}
        <BaseColorButton
          label={strings.objects.baseColorOf(name)}
          palette={palette}
          value={shown}
          mixedColors={bases.map((s) => palette[s]?.color).filter((c): c is string => !!c)}
          disabled={modelParts.length === 0}
          onChoose={(state) => project.setObjectBaseColor(object.index, state)}
        />
      </div>
      {expandable && open && (
        <ul className="border-t py-1" aria-label={strings.objects.parts(parts.length)}>
          {parts.map(({ part, index }) => {
            const state = base.get(part.id) ?? 0;
            const partName = part.name || strings.objects.unnamedPart(index + 1);
            return (
              <li key={part.id} className="flex items-center gap-2 py-0.5 pr-1.5 pl-9 text-xs">
                <span className="min-w-0 flex-1 truncate" title={partName}>
                  {partName}
                </span>
                {part.type === "ModelPart" ? (
                  <BaseColorButton
                    label={strings.objects.baseColorOf(partName)}
                    palette={palette}
                    value={state}
                    disabled={false}
                    small
                    onChoose={(s) => project.setBaseColor(object.index, index, s)}
                  />
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="flex items-center gap-1.5 rounded-sm text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/60">
                        {strings.objects.modifier}
                        <ColorChip color={palette[state]?.color ?? "#808080"} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-56">
                      {strings.objects.modifierHint}
                    </TooltipContent>
                  </Tooltip>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

interface BaseColorButtonProps {
  label: string;
  palette: readonly DesignColor[];
  /** The base color's state, or null when the parts differ. */
  value: number | null;
  /** The colors the parts have, when they differ (drawn split). */
  mixedColors?: string[];
  disabled: boolean;
  small?: boolean;
  onChoose: (state: number) => void;
}

/** A swatch button showing a base color; it opens a palette to pick another one. */
function BaseColorButton({ label, palette, value, mixedColors = [], disabled, small, onChoose }: BaseColorButtonProps) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const color = value !== null ? palette[value]?.color : undefined;
  const background =
    color ?? (mixedColors.length >= 2 ? `linear-gradient(135deg, ${mixedColors[0]} 50%, ${mixedColors[1]} 50%)` : "transparent");
  const last = palette.length - 1;
  const buttons = new Map<number, HTMLButtonElement>();

  const choose = (state: number) => {
    onChoose(state);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={`${label}${color ? `: ${color}` : `: ${strings.objects.baseMixed}`}`}
              className={cn(
                "shrink-0 cursor-pointer rounded-md border border-foreground/30 outline-none transition-shadow hover:ring-2 hover:ring-ring/60 focus-visible:ring-3 focus-visible:ring-ring/60 aria-expanded:ring-2 aria-expanded:ring-foreground disabled:cursor-not-allowed disabled:opacity-40",
                small ? "size-5" : "size-7",
              )}
              style={{ background }}
            />
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="bottom" className="max-w-52">
          {color ? strings.objects.baseColor : strings.objects.baseMixedHint}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="left" align="start" sideOffset={8} className="w-64 gap-2 p-3" aria-labelledby={titleId}>
        <div id={titleId} className="text-xs font-medium">{strings.objects.chooseBase}</div>
        <div
          role="radiogroup"
          aria-label={label}
          className="grid grid-cols-8 gap-1.5 p-0.5"
          // Arrows move the focus only: choosing recolors the object, which should be a deliberate click or Enter.
          onKeyDown={swatchKeyHandler(last, (s) => buttons.get(s)?.focus())}
        >
          {palette.slice(1).map((c, i) => {
            const state = i + 1;
            const selected = state === value;
            return (
              <button
                key={state}
                ref={(el) => {
                  if (el) buttons.set(state, el);
                }}
                type="button"
                role="radio"
                data-swatch={state}
                aria-checked={selected}
                aria-label={strings.palette.swatch(state, c.color, !c.known)}
                title={strings.palette.swatchTip(state, c.color)}
                tabIndex={selected || (value === null && state === 1) ? 0 : -1}
                onClick={() => choose(state)}
                className={cn(
                  "grid aspect-square w-full cursor-pointer place-items-center rounded-md border border-foreground/25 outline-none focus-visible:ring-3 focus-visible:ring-ring/60",
                  selected ? "ring-2 ring-foreground ring-offset-2 ring-offset-popover" : "hover:ring-2 hover:ring-ring/60",
                )}
                style={{ backgroundColor: c.color, color: readableOn(c.color) }}
              >
                {selected && <Check className="size-3.5" strokeWidth={3} />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
