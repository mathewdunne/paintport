import { useId } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EXPORT_TARGET_IDS, MAX_SPOOLS, type ExportTargetId } from "@/doc/mapping";
import type { ExportSettings } from "@/persist/exportSettings";
import { strings } from "@/strings";
import { printerCountOf } from "./spoolOps";

interface TargetSectionProps {
  settings: ExportSettings;
  onSettings: (change: (s: ExportSettings) => ExportSettings) => void;
}

const COUNTS = Array.from({ length: MAX_SPOOLS }, (_, i) => i + 1);

/** The slicer to export for and how many extruders that printer has (remembered per target). */
export function TargetSection({ settings, onSettings }: TargetSectionProps) {
  const targetId = useId();
  const countId = useId();
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <label htmlFor={targetId} className="text-xs font-medium">{strings.export.target}</label>
        <Select value={settings.target} onValueChange={(target) => onSettings((s) => ({ ...s, target: target as ExportTargetId }))}>
          <SelectTrigger id={targetId} size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPORT_TARGET_IDS.map((id) => (
              <SelectItem key={id} value={id} className="text-xs">{strings.export.targets[id]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-16 shrink-0 space-y-1">
        <label htmlFor={countId} className="text-xs font-medium">{strings.export.extruders}</label>
        <Select
          value={String(printerCountOf(settings))}
          onValueChange={(n) => onSettings((s) => ({ ...s, printerCount: { ...s.printerCount, [s.target]: Number(n) } }))}
        >
          <SelectTrigger id={countId} size="sm" className="w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-16">
            {COUNTS.map((n) => (
              <SelectItem key={n} value={String(n)} className="text-xs">{strings.export.extrudersOption(n)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
