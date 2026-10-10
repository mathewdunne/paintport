import { useMemo, useRef, useState, type RefObject } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { MixSlot } from "@/core";
import type { MappingPin, ResolvedTarget } from "@/doc/mapping";
import { dotChoice, dotIsCurrent, pickerStartIndex, type DotChoice, type PaletteDot, type PalettePrint } from "@/doc/palettePrint";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { strings } from "@/strings";
import { ColorChip } from "../palette/ColorChip";
import { pinName } from "./mappingView";

interface PalettePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  palettes: readonly PalettePrint[];
  /** The design color being matched, and what it resolves to now (its dot is ringed). */
  designColor: string;
  resolved: ResolvedTarget;
  active: readonly MixSlot[];
  allowMix: boolean;
  onPick: (pin: MappingPin) => void;
}

interface DotView {
  dot: PaletteDot;
  choice: DotChoice;
  current: boolean;
  label: string;
}

const describe = (choice: DotChoice): string =>
  choice.kind === "pin" ? pinName(choice.pin) : choice.kind === "missing" ? strings.export.dotMissing(choice.colors) : strings.export.dotMixOff;

/** The palette tab used last, for this page view (where the picker opens next, spec Q13.4). */
let lastTab = 0;

/** The palette prints laid out as printed (bed Y up), one tab each; clicking a usable dot pins it (spec Q13.5). */
export function PalettePicker({ open, onOpenChange, palettes, designColor, ...body }: PalettePickerProps) {
  const map = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-4 sm:max-w-xl"
        // Focus the map, not its first dot: a dot must only be picked on purpose (Tab reaches the dots).
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          map.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{strings.export.pickerTitle}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <ColorChip color={designColor} className="size-5 rounded-md" />
            <span>{strings.export.pickerDescription(designColor)}</span>
          </DialogDescription>
        </DialogHeader>
        <PickerBody map={map} palettes={palettes} onClose={() => onOpenChange(false)} {...body} />
      </DialogContent>
    </Dialog>
  );
}

interface PickerBodyProps extends Pick<PalettePickerProps, "palettes" | "resolved" | "active" | "allowMix" | "onPick"> {
  map: RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

/** Mounted on each opening, so it starts on the right tab with no hover left over. */
function PickerBody({ map, palettes, resolved, active, allowMix, onPick, onClose }: PickerBodyProps) {
  const [tab, setTab] = useState(() => pickerStartIndex(palettes, lastTab, active, allowMix, resolved));
  const [hover, setHover] = useState<DotView | null>(null);
  const palette = palettes[Math.min(tab, palettes.length - 1)];

  const { views, box } = useMemo(() => {
    const minX = Math.min(...palette.dots.map((d) => d.x - d.r)), maxX = Math.max(...palette.dots.map((d) => d.x + d.r));
    const minY = Math.min(...palette.dots.map((d) => d.y - d.r)), maxY = Math.max(...palette.dots.map((d) => d.y + d.r));
    // Lower parts first, so a dot standing on the base plate is drawn (and clicked) above it.
    const sorted = palette.dots.map((dot, i) => ({ dot, i })).sort((a, b) => a.dot.top - b.dot.top || a.i - b.i);
    const views = sorted.map(({ dot }): DotView => {
      const choice = dotChoice(dot, active, allowMix);
      const current = dotIsCurrent(choice, resolved);
      const what = describe(choice);
      return { dot, choice, current, label: strings.export.dotLabel(dot.name, current ? `${what} (${strings.export.dotCurrent})` : what) };
    });
    return { views, box: { minX, maxY, w: maxX - minX, h: maxY - minY } };
  }, [palette, active, allowMix, resolved]);

  const place = (d: PaletteDot) => ({
    left: `${((d.x - d.r - box.minX) / box.w) * 100}%`,
    top: `${((box.maxY - d.y - d.r) / box.h) * 100}%`,
    width: `${((2 * d.r) / box.w) * 100}%`,
    height: `${((2 * d.r) / box.h) * 100}%`,
    backgroundColor: d.color,
  });

  return (
    <>
      {palettes.length > 1 && (
        <Tabs value={String(tab)} onValueChange={(v) => { lastTab = Number(v); setTab(lastTab); setHover(null); }}>
          <TabsList className="w-full">
            {palettes.map((p, i) => (
              <TabsTrigger key={i} value={String(i)} className="min-w-0 text-xs" title={p.name}>
                <span className="truncate">{p.name}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      <div
        ref={map}
        tabIndex={-1}
        className="relative mx-auto w-full outline-none"
        style={{ aspectRatio: `${box.w} / ${box.h}`, maxWidth: `calc(60vh * ${box.w / box.h})` }}
      >
        {views.map((v, i) =>
          v.dot.backdrop ? (
            <div key={i} aria-hidden className="absolute rounded-full border border-foreground/20" style={place(v.dot)} />
          ) : (
            <button
              key={i}
              type="button"
              aria-label={v.label}
              aria-disabled={v.choice.kind !== "pin"}
              aria-current={v.current || undefined}
              className={cn(
                "absolute rounded-full border border-foreground/25 outline-none transition-transform",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                v.choice.kind === "pin" ? "cursor-pointer hover:scale-110" : "cursor-not-allowed opacity-25",
                v.current && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
              )}
              style={place(v.dot)}
              onMouseEnter={() => setHover(v)}
              onMouseLeave={() => setHover((h) => (h === v ? null : h))}
              onFocus={() => setHover(v)}
              onBlur={() => setHover((h) => (h === v ? null : h))}
              onClick={() => {
                if (v.choice.kind !== "pin") return;
                onPick(v.choice.pin);
                onClose();
              }}
            />
          ),
        )}
      </div>
      <p className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        {hover && <ColorChip color={hover.dot.color} />}
        <span className="truncate">{hover ? hover.label : strings.export.pickerIdle}</span>
      </p>
    </>
  );
}
