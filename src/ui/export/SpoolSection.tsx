import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  applyFileSpools, applyPreset, defaultSpools, fileSpools, fileSpoolsDiffer, SPOOL_PRESETS, type Spool,
} from "@/doc/mapping";
import type { Project } from "@/doc/project";
import { cn } from "@/lib/utils";
import type { ExportSettings } from "@/persist/exportSettings";
import { strings } from "@/strings";
import { ConfirmDialog } from "../ConfirmDialog";
import { ColorChip } from "../palette/ColorChip";
import { ColorPickerPanel } from "../palette/ColorPickerPanel";
import type { Confirmation } from "../useSession";
import { patchSpool, printerCountOf, swapSpoolSlots } from "./spoolOps";

interface SpoolSectionProps {
  project: Project | null;
  settings: ExportSettings;
  onSettings: (change: (s: ExportSettings) => ExportSettings) => void;
}

/** The printer's spools: on/off, color, order, presets, defaults, and the file's own spools. */
export function SpoolSection({ project, settings, onSettings }: SpoolSectionProps) {
  const count = printerCountOf(settings);
  const spools = settings.spools.filter((s) => s.slot <= count);
  // The note belongs to the target and extruder count it was made for: another one makes it stale.
  const [presetNote, setPresetNote] = useState<{ text: string; target: string; count: number } | null>(null);
  const note = presetNote && presetNote.target === settings.target && presetNote.count === count ? presetNote.text : null;
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const file = project ? fileSpools(project.source) : [];
  const offerFile = file.length > 0 && fileSpoolsDiffer(settings.spools, file, count);

  const change = (next: (s: ExportSettings) => ExportSettings) => {
    setPresetNote(null);
    onSettings(next);
  };
  const move = (slot: number, direction: -1 | 1) => {
    // swapSpoolSlots also re-points the pins that name the two slots. `update` calls this once, right away.
    change((s) => swapSpoolSlots(project, s, slot, slot + direction));
  };

  return (
    <div className="space-y-2">
      <ul className="space-y-1">
        {spools.map((spool) => (
          <SpoolRow
            key={spool.slot}
            spool={spool}
            canUp={spool.slot > 1}
            canDown={spool.slot < count}
            onPatch={(patch) => change((s) => ({ ...s, spools: patchSpool(s.spools, spool.slot, patch) }))}
            onMove={(direction) => move(spool.slot, direction)}
          />
        ))}
      </ul>

      <div className="flex flex-wrap gap-1 pt-1" role="group" aria-label={strings.export.presets}>
        {SPOOL_PRESETS.map((preset) => (
          <Tooltip key={preset.id}>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  onSettings((s) => ({ ...s, spools: applyPreset(s.spools, preset, printerCountOf(s)).spools }));
                  const truncated = preset.colors.length > count;
                  setPresetNote(truncated ? { text: strings.export.presetTruncated(strings.export.presetName(preset.id), preset.colors.length, count), target: settings.target, count } : null);
                }}
              >
                {strings.export.presetName(preset.id)}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{strings.export.presetTip(preset.id, preset.colors.length)}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      {/* Always in the page, so a screen reader hears the text when it appears. */}
      <p role="status" className="text-xs text-muted-foreground empty:sr-only">{note}</p>

      <div className="flex flex-wrap gap-1">
        <Button
          variant="outline"
          size="xs"
          onClick={() =>
            setConfirmation({
              title: strings.export.defaultsTitle,
              description: strings.export.defaultsDescription,
              confirmLabel: strings.export.defaultsConfirm,
              onConfirm: () => {
                setConfirmation(null);
                change((s) => ({ ...s, spools: defaultSpools() }));
              },
            })
          }
        >
          {strings.export.defaults}
        </Button>
        {offerFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="xs" onClick={() => change((s) => ({ ...s, spools: applyFileSpools(s.spools, file, printerCountOf(s)) }))}>
                {strings.export.useFileSpools}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{strings.export.useFileSpoolsTip}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <ConfirmDialog confirmation={confirmation} onCancel={() => setConfirmation(null)} />
    </div>
  );
}

interface SpoolRowProps {
  spool: Spool;
  canUp: boolean;
  canDown: boolean;
  onPatch: (patch: Partial<Pick<Spool, "color" | "on">>) => void;
  onMove: (direction: -1 | 1) => void;
}

function SpoolRow({ spool, canUp, canDown, onPatch, onMove }: SpoolRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <li className="flex items-center gap-2">
      <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{spool.slot}</span>
      <Switch aria-label={strings.export.spoolOn(spool.slot)} checked={spool.on} onCheckedChange={(on) => onPatch({ on })} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${strings.export.spoolColor(spool.slot)}, ${spool.color}`}
            className={cn("cursor-pointer rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/60", !spool.on && "opacity-50")}
          >
            <ColorChip color={spool.color} className="size-6 rounded-md" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="left" align="start" sideOffset={12} className="w-64" aria-label={strings.export.spoolTitle(spool.slot)}>
          <div className="text-sm font-medium">{strings.export.spoolTitle(spool.slot)}</div>
          <ColorPickerPanel initialColor={spool.color} onChange={(color) => onPatch({ color })} onSubmit={() => setOpen(false)} />
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setOpen(false)}>{strings.export.spoolDone}</Button>
          </div>
        </PopoverContent>
      </Popover>
      <span className={cn("min-w-0 flex-1 font-mono text-xs text-muted-foreground", !spool.on && "opacity-50")}>{spool.color}</span>
      <Button variant="ghost" size="icon-xs" aria-label={strings.export.moveUp(spool.slot)} disabled={!canUp} onClick={() => onMove(-1)}>
        <ArrowUp />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label={strings.export.moveDown(spool.slot)} disabled={!canDown} onClick={() => onMove(1)}>
        <ArrowDown />
      </Button>
    </li>
  );
}
