import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { strings } from "@/strings";
import { SELECTED_TOGGLE } from "./selectedStyle";
import { TOOLS, type ToolId } from "./tools";

interface ToolRailProps {
  tool: ToolId;
  onToolChange: (t: ToolId) => void;
  /** The tools are off (Print view). The buttons stay focusable so the tooltip can say why. */
  disabled?: boolean;
  /** Tools that can't be used here, with the reason shown in their tooltip (AI Paint without WebGPU). */
  unavailable?: Partial<Record<ToolId, string>>;
}

export function ToolRail({ tool, onToolChange, disabled = false, unavailable }: ToolRailProps) {
  const button = ({ id, label, hint, key, Icon }: (typeof TOOLS)[number]) => {
    const reason = unavailable?.[id];
    const off = disabled || !!reason;
    return (
      <Tooltip key={id}>
        <TooltipTrigger asChild>
          <ToggleGroupItem
            value={id}
            aria-label={label}
            aria-keyshortcuts={off ? undefined : key}
            aria-disabled={off || undefined}
            className={cn(
              "h-auto w-16 flex-col gap-1 px-1 py-1.5 text-[10px] leading-tight font-normal whitespace-normal",
              SELECTED_TOGGLE,
              off && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
          >
            <Icon />
            <span className="text-center">{label}</span>
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-64 flex-col items-start gap-0.5">
          {disabled ? strings.viewport.toolsDisabled : reason ?? (
            <>
              <span className="flex items-center gap-1.5 font-medium">
                {label}
                <kbd data-slot="kbd" className="bg-background/20 px-1 font-sans">{key}</kbd>
              </span>
              <span className="opacity-80">{hint}</span>
            </>
          )}
        </TooltipContent>
      </Tooltip>
    );
  };

  // The region tools are listed next to each other in TOOLS.
  const first = TOOLS.findIndex((t) => t.region), end = first + TOOLS.filter((t) => t.region).length;
  return (
    <div className="flex w-20 shrink-0 flex-col items-center overflow-y-auto border-r py-2">
      <ToggleGroup
        type="single"
        orientation="vertical"
        spacing={1}
        value={tool}
        // Radix emits "" when the active tool is clicked again; keep the current one.
        onValueChange={(v) => v && !disabled && !unavailable?.[v as ToolId] && onToolChange(v as ToolId)}
        aria-label={strings.tools.label}
        className="data-vertical:items-center"
      >
        {TOOLS.slice(0, first).map(button)}
        <div role="group" aria-label={strings.tools.regionGroup} className="my-1 flex flex-col gap-1 rounded-lg border bg-muted/50 p-1">
          <span aria-hidden className="pt-0.5 text-center text-[9px] font-medium tracking-wide text-muted-foreground uppercase">
            {strings.tools.regionGroup}
          </span>
          {TOOLS.slice(first, end).map(button)}
        </div>
        {TOOLS.slice(end).map(button)}
      </ToggleGroup>
    </div>
  );
}
