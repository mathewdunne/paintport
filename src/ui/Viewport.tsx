import { Box } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { strings } from "@/strings";

export function Viewport() {
  return (
    <main className="relative min-w-0 flex-1 overflow-hidden bg-muted/40">
      {/* The three.js canvas mounts here later. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <Box className="size-8 opacity-60" strokeWidth={1.5} />
        <p className="text-sm font-medium">{strings.viewport.emptyTitle}</p>
        <p className="text-xs">{strings.viewport.emptyHint}</p>
      </div>
      {/* Placeholder: Design/Print switching is wired up in phase 3. */}
      <div className="absolute inset-x-0 bottom-4 flex justify-center">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          defaultValue="design"
          aria-label={strings.viewport.viewMode}
          className="bg-background shadow-sm"
        >
          <ToggleGroupItem value="design" className="px-3">
            {strings.viewport.design}
          </ToggleGroupItem>
          <ToggleGroupItem value="print" className="px-3">
            {strings.viewport.print}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </main>
  );
}
