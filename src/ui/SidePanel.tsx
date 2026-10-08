import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DesignColor, Project } from "@/doc/project";
import { strings } from "@/strings";
import { formatRadius, radiusToSlider, sliderToRadius } from "@/tools/radius";
import type { PaintSettings } from "@/tools/types";
import { useProjectPalette } from "./useProjectState";

/** Positions on the logarithmic radius slider: about 2.5% per arrow-key step. */
const RADIUS_SLIDER_STEPS = 200;

function Empty({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Swatches({ palette, active, onSelect }: { palette: readonly DesignColor[]; active: number; onSelect: (state: number) => void }) {
  // Index 0 is the unused "base" slot. Colors are normalized hex values (see createProject).
  return (
    <ul className="flex flex-wrap gap-2">
      {palette.slice(1).map((c, i) => {
        const state = i + 1;
        const selected = state === active;
        const label = `${strings.panel.swatchLabel} ${state}, ${c.color}`;
        return (
          <li key={state}>
            <button
              type="button"
              aria-pressed={selected}
              aria-label={label}
              title={label}
              onClick={() => onSelect(state)}
              className="group flex w-9 cursor-pointer flex-col items-center gap-0.5 rounded-md outline-none"
            >
              <span
                className={`size-8 rounded-md border transition-shadow group-focus-visible:ring-3 group-focus-visible:ring-ring/50 ${
                  selected ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : "group-hover:ring-2 group-hover:ring-ring/60"
                }`}
                style={{ backgroundColor: c.color }}
              />
              <span aria-hidden className={`text-[10px] leading-none ${selected ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                {state}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
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

interface SidePanelProps {
  project: Project | null;
  settings: PaintSettings;
  onSettings: (patch: Partial<PaintSettings>) => void;
}

export function SidePanel({ project, settings, onSettings }: SidePanelProps) {
  const palette = useProjectPalette(project);
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l">
      <Tabs defaultValue="paint" className="min-h-0 flex-1 gap-0">
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
                <Swatches palette={palette} active={settings.activeState} onSelect={(activeState) => onSettings({ activeState })} />
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
              <ul className="space-y-1">
                {project.objects.map((o) => (
                  <li key={o.index} className="flex items-baseline justify-between gap-3 rounded-md border px-2.5 py-1.5 text-sm">
                    {/* File content: rendered as React text only. */}
                    <span className="min-w-0 truncate font-medium">{o.name || strings.panel.unnamedObject}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {strings.panel.triangleCount(o.triCount)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{strings.panel.objectsEmpty}</Empty>
            )}
          </TabsContent>
          <TabsContent value="export">
            <Empty>{strings.panel.exportEmpty}</Empty>
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
