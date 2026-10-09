import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Project } from "@/doc/project";
import type { ExportSettings } from "@/persist/exportSettings";
import { strings } from "@/strings";
import { formatRadius, radiusToSlider, sliderToRadius } from "@/tools/radius";
import type { PaintSettings } from "@/tools/types";
import { ExportTab } from "./export/ExportTab";
import type { MappingModel } from "./export/mappingView";
import { ObjectsTab } from "./ObjectsTab";
import { PaletteSection } from "./palette/PaletteSection";
import type { HiddenObjects } from "./objectVisibility";

/** Positions on the logarithmic radius slider: about 2.5% per arrow-key step. */
const RADIUS_SLIDER_STEPS = 200;

function Empty({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function SliderRow({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      {children}
    </div>
  );
}

export type PanelTab = "paint" | "objects" | "export";

interface SidePanelProps {
  project: Project | null;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  settings: PaintSettings;
  onSettings: (patch: Partial<PaintSettings>) => void;
  hiddenObjects: HiddenObjects;
  onToggleObject: (index: number) => void;
  onSoloObject: (index: number) => void;
  onShowAllObjects: () => void;
  exportSettings: ExportSettings;
  onExportSettings: (change: (s: ExportSettings) => ExportSettings) => void;
  /** The live mapping; computed while the Export tab or the Print view needs it. */
  mapping: MappingModel | null;
  onExport: () => void;
  exporting: boolean;
}

export function SidePanel({
  project, tab, onTab, settings, onSettings, hiddenObjects, onToggleObject, onSoloObject, onShowAllObjects,
  exportSettings, onExportSettings, mapping, onExport, exporting,
}: SidePanelProps) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l">
      <Tabs value={tab} onValueChange={(v) => onTab(v as PanelTab)} className="min-h-0 flex-1 gap-0">
        <div className="p-3">
          <TabsList className="w-full">
            <TabsTrigger value="paint">{strings.panel.paint}</TabsTrigger>
            <TabsTrigger value="objects">{strings.panel.objects}</TabsTrigger>
            <TabsTrigger value="export">{strings.panel.export}</TabsTrigger>
          </TabsList>
        </div>
        <Separator />
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <TabsContent value="paint" className="space-y-4">
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {strings.panel.palette}
              </h2>
              {project ? (
                <PaletteSection project={project} active={settings.activeState} onActive={(activeState) => onSettings({ activeState })} />
              ) : (
                <Empty>{strings.panel.paletteEmpty}</Empty>
              )}
            </section>
            <Separator />
            <section className="space-y-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{strings.panel.brush}</h2>
              <SliderRow label={strings.panel.brushSize} value={strings.panel.radiusValue(formatRadius(settings.radius))}>
                <Slider
                  aria-label={strings.panel.brushSize}
                  aria-valuetext={strings.panel.radiusValue(formatRadius(settings.radius))}
                  min={0}
                  max={RADIUS_SLIDER_STEPS}
                  step={1}
                  value={[Math.round(radiusToSlider(settings.radius) * RADIUS_SLIDER_STEPS)]}
                  onValueChange={([v]) => onSettings({ radius: sliderToRadius(v / RADIUS_SLIDER_STEPS) })}
                />
              </SliderRow>
              <div className="flex items-start justify-between gap-3">
                <label htmlFor="paint-through" className="space-y-0.5">
                  <span className="block text-xs font-medium">{strings.panel.paintThrough}</span>
                  <span className="block text-xs text-muted-foreground">{strings.panel.paintThroughHint}</span>
                </label>
                <Switch id="paint-through" checked={settings.paintThrough} onCheckedChange={(paintThrough) => onSettings({ paintThrough })} />
              </div>
            </section>
            <Separator />
            <section className="space-y-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{strings.panel.smartFill}</h2>
              <SliderRow label={strings.panel.smartFillAngle} value={strings.panel.angleValue(settings.smartAngle)}>
                <Slider
                  aria-label={strings.panel.smartFillAngle}
                  aria-valuetext={strings.panel.angleValue(settings.smartAngle)}
                  min={0}
                  max={90}
                  step={1}
                  value={[settings.smartAngle]}
                  onValueChange={([v]) => onSettings({ smartAngle: v })}
                />
              </SliderRow>
              <p className="text-xs text-muted-foreground">{strings.panel.smartFillHint}</p>
            </section>
          </TabsContent>
          <TabsContent value="objects">
            {project ? (
              <ObjectsTab project={project} hidden={hiddenObjects} onToggle={onToggleObject} onSolo={onSoloObject} onShowAll={onShowAllObjects} />
            ) : (
              <Empty>{strings.panel.objectsEmpty}</Empty>
            )}
          </TabsContent>
          <TabsContent value="export">
            <ExportTab
              project={project}
              settings={exportSettings}
              onSettings={onExportSettings}
              mapping={mapping}
              onExport={onExport}
              exporting={exporting}
            />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
