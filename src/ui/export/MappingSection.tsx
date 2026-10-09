import { useMemo, useState } from "react";
import { Pin } from "lucide-react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { MixSlot } from "@/core";
import { activeSpools, type MappingPin, type ResolvedTarget } from "@/doc/mapping";
import type { Project } from "@/doc/project";
import type { ExportSettings } from "@/persist/exportSettings";
import { strings } from "@/strings";
import { ColorChip } from "../palette/ColorChip";
import {
  AUTO_VALUE, mappingRows, pinName, rowChoices, targetName, toMappingSettings,
  type ChoiceOption, type MappingModel, type MappingRow,
} from "./mappingView";

interface MappingSectionProps {
  project: Project;
  settings: ExportSettings;
  model: MappingModel;
}

/** One compact row per used design color: its swatch, a dropdown for the target, and the color it prints as. */
export function MappingSection({ project, settings, model }: MappingSectionProps) {
  const rows = useMemo(
    () => mappingRows(project, settings, model),
    // project.palette and project.mapping are replaced on change, and `model` is recomputed then.
    [project, settings, model],
  );
  const active = useMemo(() => activeSpools(settings.spools, toMappingSettings(settings).printerCount), [settings]);
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{strings.export.mappingEmpty}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <MappingRowView
          key={row.state}
          row={row}
          active={active}
          allowMix={settings.allowMix}
          onChoose={(pin) => project.setPin(row.state, pin)}
        />
      ))}
    </ul>
  );
}

interface MappingRowViewProps {
  row: MappingRow;
  active: readonly MixSlot[];
  allowMix: boolean;
  /** A pin, or null for Auto. */
  onChoose: (pin: MappingPin | null) => void;
}

function MappingRowView({ row, active, allowMix, onChoose }: MappingRowViewProps) {
  const [open, setOpen] = useState(false);
  // Ranking the blends costs a little per row, so only the open dropdown does it.
  const choices = useMemo(() => rowChoices(row, active, allowMix, open), [row, active, allowMix, open]);
  const all = useMemo(() => new Map([...choices.spools, ...choices.blends].map((o) => [o.value, o])), [choices]);

  const { resolved } = row;
  const result = resolved.kind === "none" ? null : resolved;
  return (
    <li className="flex items-center gap-2" aria-label={strings.export.mappingRow(row.state, row.designColor)}>
      <ColorChip color={row.designColor} className="size-5 rounded-md" />
      <Select
        value={row.value}
        open={open}
        onOpenChange={setOpen}
        onValueChange={(value) => {
          if (value === AUTO_VALUE) onChoose(null);
          else {
            const option = all.get(value);
            if (option?.pin) onChoose(option.pin);
          }
        }}
      >
        <SelectTrigger size="sm" className="min-w-0 flex-1 px-2 text-xs" aria-label={strings.export.mappingSelect(row.state)} title={triggerText(row)}>
          <SelectValue>
            <TriggerLabel row={row} />
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="min-w-60">
          <SelectItem value={AUTO_VALUE} className="text-xs">
            <AutoOption auto={row.auto} />
          </SelectItem>
          {choices.spools.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{strings.export.groupSpools}</SelectLabel>
                {choices.spools.map((o) => <OptionItem key={o.value} option={o} />)}
              </SelectGroup>
            </>
          )}
          {choices.blends.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{strings.export.groupBlends}</SelectLabel>
                {choices.blends.map((o) => <OptionItem key={o.value} option={o} />)}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
      {result ? (
        <span
          className="flex w-[4.25rem] shrink-0 items-center gap-1.5"
          title={strings.export.resultOf(result.color, strings.export.deltaE(result.deltaE))}
        >
          <ColorChip color={result.color} className="size-5 rounded-md" />
          <span className="text-[11px] tabular-nums text-muted-foreground">{result.deltaE.toFixed(1)}</span>
        </span>
      ) : (
        <span className="w-[4.25rem] shrink-0" />
      )}
    </li>
  );
}

/** The text of the closed dropdown: the pin, the imported recipe, or Auto and what it picks (and a pin that is on hold). */
function triggerText({ resolved, pinned, dormant }: MappingRow): string {
  const name = targetName(resolved);
  if (resolved.source === "pin" && pinned) return name;
  const auto = resolved.source === "hint" ? strings.export.fromFile(name) : strings.export.autoIs(name);
  return dormant ? `${auto} · ${strings.export.dormantPin(pinName(dormant))}` : auto;
}

/** What the closed dropdown says; a pin, honored or not, carries the pin icon. */
function TriggerLabel({ row }: { row: MappingRow }) {
  return (
    <>
      {row.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label={strings.export.pinned} />}
      <span className="truncate">{triggerText(row)}</span>
    </>
  );
}

function AutoOption({ auto }: { auto: ResolvedTarget }) {
  return (
    <>
      {auto.kind !== "none" && <ColorChip color={auto.color} />}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span>{strings.export.auto}</span>
        <span className="truncate text-muted-foreground">{targetName(auto)}</span>
      </span>
      {auto.kind !== "none" && <Delta value={auto.deltaE} />}
    </>
  );
}

function OptionItem({ option }: { option: ChoiceOption }) {
  return (
    <SelectItem value={option.value} className="text-xs">
      {option.color && <ColorChip color={option.color} />}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.deltaE !== undefined && <Delta value={option.deltaE} />}
    </SelectItem>
  );
}

function Delta({ value }: { value: number }) {
  return <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{strings.export.deltaE(value)}</span>;
}
