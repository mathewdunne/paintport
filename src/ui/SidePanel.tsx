import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AiPaintSection } from "./AiPaintSection";
import type { AiModelState } from "./useAiModel";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Project } from "@/doc/project";
import type { ExportSettings } from "@/persist/exportSettings";
import { strings } from "@/strings";
import { formatRadius, radiusToSlider, sliderToRadius } from "@/tools/radius";
import { angleToSensitivity, MAX_SMART_ANGLE, MAX_SMART_SCALE, sensitivityToAngle, sensitivityToScale } from "@/tools/sensitivity";
import type { PaintSettings } from "@/tools/types";
import { ExportTab } from "./export/ExportTab";
import type { MappingModel } from "./export/mappingView";
import { ObjectsTab } from "./ObjectsTab";
import { PaletteSection } from "./palette/PaletteSection";
import type { HiddenObjects } from "./objectVisibility";
import { useAutoFeatureScale } from "./useAutoFeatureScale";

/** Positions on the logarithmic radius slider: about 2.5% per arrow-key step. */
const RADIUS_SLIDER_STEPS = 200;
/** Positions on the edge sensitivity slider. */
const SENSITIVITY_STEPS = 100;

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
  fillAdvancedOpen: boolean;
  onFillAdvancedOpen: (open: boolean) => void;
  onResetSmartFill: () => void;
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
  /** AI Paint's model state; its section shows while the tool is chosen. */
  aiModel: AiModelState;
  onDownloadAi: () => void;
}

export function SidePanel({
  project, tab, onTab, settings, onSettings, fillAdvancedOpen, onFillAdvancedOpen, onResetSmartFill, hiddenObjects, onToggleObject, onSoloObject, onShowAllObjects,
  exportSettings, onExportSettings, mapping, onExport, exporting, aiModel, onDownloadAi,
}: SidePanelProps) {
  // The automatic feature size is shown only while the Advanced section is open (it needs the mesh topology).
  const meshScale = useAutoFeatureScale(project, tab === "paint" && fillAdvancedOpen);
  const autoScale = meshScale === undefined ? undefined : sensitivityToScale(settings.smartScaleSensitivity ?? 0.5, meshScale);
  const scaleText = settings.smartScale === null ? strings.panel.scaleAuto(autoScale) : strings.panel.scaleValue(settings.smartScale);
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
              <div className="space-y-2">
                <span className="block text-xs font-medium">{strings.panel.edgeSensitivity}</span>
                <Slider
                  aria-label={strings.panel.edgeSensitivity}
                  aria-valuetext={`${strings.panel.angleValue(settings.smartAngle)}, ${strings.panel.smartFillScale}: ${scaleText}`}
                  min={0}
                  max={SENSITIVITY_STEPS}
                  step={1}
                  value={[Math.round(angleToSensitivity(settings.smartAngle) * SENSITIVITY_STEPS)]}
                  onValueChange={([v]) => onSettings({
                    smartAngle: sensitivityToAngle(v / SENSITIVITY_STEPS),
                    smartScale: null,
                    smartScaleSensitivity: v / SENSITIVITY_STEPS,
                  })}
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{strings.panel.sensitivityLoose}</span>
                  <span>{strings.panel.sensitivityStrict}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{strings.panel.edgeSensitivityHint}</p>
              <Collapsible open={fillAdvancedOpen} onOpenChange={onFillAdvancedOpen}>
                <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
                  <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                  {strings.panel.advanced}
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-4 pt-4">
                  <SliderRow label={strings.panel.smartFillAngle} value={strings.panel.angleValue(settings.smartAngle)}>
                    <Slider
                      aria-label={strings.panel.smartFillAngle}
                      aria-valuetext={strings.panel.angleValue(settings.smartAngle)}
                      min={0}
                      max={MAX_SMART_ANGLE}
                      step={1}
                      value={[settings.smartAngle]}
                      onValueChange={([v]) => onSettings({ smartAngle: v })}
                    />
                  </SliderRow>
                  <p className="text-xs text-muted-foreground">{strings.panel.smartFillHint}</p>
                  <SliderRow label={strings.panel.smartFillScale} value={scaleText}>
                    <Slider
                      aria-label={strings.panel.smartFillScale}
                      aria-valuetext={scaleText}
                      min={0}
                      max={MAX_SMART_SCALE}
                      step={0.05}
                      value={[Math.min(MAX_SMART_SCALE, settings.smartScale ?? autoScale ?? 0)]}
                      onValueChange={([v]) => onSettings({ smartScale: v, smartScaleSensitivity: undefined })}
                    />
                  </SliderRow>
                  <p className="text-xs text-muted-foreground">{strings.panel.smartFillScaleHint}</p>
                  <Button variant="outline" size="sm" onClick={onResetSmartFill}>{strings.panel.resetDefaults}</Button>
                </CollapsibleContent>
              </Collapsible>
            </section>
            {settings.tool === "aiPaint" && (
              <>
                <Separator />
                <AiPaintSection state={aiModel} onDownload={onDownloadAi} />
              </>
            )}
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
