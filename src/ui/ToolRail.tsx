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
}

export function ToolRail({ tool, onToolChange, disabled = false }: ToolRailProps) {
  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r py-2">
      <ToggleGroup
        type="single"
        orientation="vertical"
        spacing={1}
        value={tool}
        // Radix emits "" when the active tool is clicked again; keep the current one.
        onValueChange={(v) => v && !disabled && onToolChange(v as ToolId)}
        aria-label={strings.tools.label}
      >
        {TOOLS.map(({ id, label, key, Icon }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <ToggleGroupItem
                value={id}
                aria-label={label}
                aria-keyshortcuts={disabled ? undefined : key}
                aria-disabled={disabled || undefined}
                className={cn("size-9", SELECTED_TOGGLE, disabled && "cursor-not-allowed opacity-40 hover:bg-transparent")}
              >
                <Icon />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-48">
              {disabled ? strings.viewport.toolsDisabled : `${label} (${key})`}
            </TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </div>
  );
}
