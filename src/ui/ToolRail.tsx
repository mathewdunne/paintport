import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { strings } from "@/strings";
import { TOOLS, type ToolId } from "./tools";

export function ToolRail({ tool, onToolChange }: { tool: ToolId; onToolChange: (t: ToolId) => void }) {
  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r py-2">
      <ToggleGroup
        type="single"
        orientation="vertical"
        spacing={1}
        value={tool}
        // Radix emits "" when the active tool is clicked again; keep the current one.
        onValueChange={(v) => v && onToolChange(v as ToolId)}
        aria-label={strings.tools.label}
      >
        {TOOLS.map(({ id, label, key, Icon }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <ToggleGroupItem value={id} aria-label={label} aria-keyshortcuts={key} className="size-9">
                <Icon />
              </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent side="right">
              {label} ({key})
            </TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
    </div>
  );
}
