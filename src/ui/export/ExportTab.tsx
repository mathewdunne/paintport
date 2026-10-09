import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { activeSpools } from "@/doc/mapping";
import type { Project } from "@/doc/project";
import type { ExportSettings } from "@/persist/exportSettings";
import { strings } from "@/strings";
import { ExportWarnings } from "./ExportWarnings";
import { MappingSection } from "./MappingSection";
import type { MappingModel } from "./mappingView";
import { Section } from "./Section";
import { SpoolSection } from "./SpoolSection";
import { printerCountOf } from "./spoolOps";
import { TargetSection } from "./TargetSection";

interface ExportTabProps {
  project: Project | null;
  settings: ExportSettings;
  onSettings: (change: (s: ExportSettings) => ExportSettings) => void;
  /** The live mapping of the used colors; null without a project. */
  mapping: MappingModel | null;
  onExport: () => void;
  exporting: boolean;
}

/** Target, spools, ColorMix, the color mapping with its warnings, and the Export button, stacked. */
export function ExportTab({ project, settings, onSettings, mapping, onExport, exporting }: ExportTabProps) {
  const hasSpool = activeSpools(settings.spools, printerCountOf(settings)).length > 0;
  const blocked = !project ? strings.export.noProject : !hasSpool ? strings.export.noSpoolOn : null;
  return (
    <div className="space-y-4">
      <TargetSection settings={settings} onSettings={onSettings} />
      <Separator />
      <Section title={strings.export.spools} hint={strings.export.spoolsHint}>
        <SpoolSection project={project} settings={settings} onSettings={onSettings} />
      </Section>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="allow-mix" className="space-y-0.5">
          <span className="block text-xs font-medium">{strings.export.allowMix}</span>
          <span className="block text-xs text-muted-foreground">{strings.export.allowMixHint}</span>
        </label>
        <Switch id="allow-mix" checked={settings.allowMix} onCheckedChange={(allowMix) => onSettings((s) => ({ ...s, allowMix }))} />
      </div>
      <Separator />
      <Section title={strings.export.mapping} hint={strings.export.mappingHint}>
        {project && mapping ? <MappingSection project={project} settings={settings} model={mapping} /> : <p className="text-xs text-muted-foreground">{strings.panel.exportEmpty}</p>}
      </Section>
      {project && mapping && <ExportWarnings project={project} warnings={mapping.warnings} />}
      <div className="space-y-1.5">
        <Button className="w-full" disabled={blocked !== null || exporting} onClick={onExport}>
          {exporting ? strings.export.exporting : strings.export.button}
        </Button>
        {blocked && <p className="text-center text-xs text-muted-foreground">{blocked}</p>}
      </div>
    </div>
  );
}
