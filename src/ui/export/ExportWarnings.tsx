import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { MappingWarnings } from "@/doc/mapping";
import type { Project } from "@/doc/project";
import { strings } from "@/strings";
import { ColorChip } from "../palette/ColorChip";

/** Collision pairs listed before "and N more". */
const MAX_PAIRS = 3;

/** The mapping's warnings as compact alerts: look-alike results, poor blends with free slots, Bambu's 16 cap. */
export function ExportWarnings({ project, warnings }: { project: Project; warnings: MappingWarnings }) {
  const { collisions, poorBlends, bambuLimit } = warnings;
  if (collisions.length === 0 && !poorBlends && !bambuLimit) return null;
  const color = (state: number) => project.palette[state]?.color ?? "#808080";
  return (
    <div className="space-y-1.5">
      {collisions.length > 0 && (
        <Warning>
          <span className="block">{strings.export.warnCollision}</span>
          <ul className="mt-1 space-y-0.5">
            {collisions.slice(0, MAX_PAIRS).map(([a, b]) => (
              <li key={`${a}-${b}`} className="flex items-center gap-1">
                <ColorChip color={color(a)} />
                <ColorChip color={color(b)} />
              </li>
            ))}
          </ul>
          {collisions.length > MAX_PAIRS && <span className="mt-0.5 block">{strings.export.warnCollisionMore(collisions.length - MAX_PAIRS)}</span>}
        </Warning>
      )}
      {poorBlends && <Warning>{strings.export.warnPoorBlends(poorBlends.states.length, poorBlends.freeSlots)}</Warning>}
      {bambuLimit && <Warning>{strings.export.warnBambuLimit(bambuLimit.total)}</Warning>}
    </div>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <Alert className="px-3 py-2 text-xs">
      <TriangleAlert />
      <AlertDescription className="text-xs">{children}</AlertDescription>
    </Alert>
  );
}
