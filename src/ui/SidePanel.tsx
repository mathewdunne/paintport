import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Project } from "@/doc/project";
import { strings } from "@/strings";

function Empty({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function Swatches({ project }: { project: Project }) {
  // Index 0 is the unused "base" slot. Colors are normalized hex values (see createProject).
  return (
    <ul className="flex flex-wrap gap-2">
      {project.palette.slice(1).map((c, i) => (
        <li key={i} className="flex w-9 flex-col items-center gap-0.5" title={`${strings.panel.swatchLabel} ${i + 1}: ${c.color}`}>
          <span className="size-8 rounded-md border" style={{ backgroundColor: c.color }} />
          <span className="sr-only">{`${strings.panel.swatchLabel} ${i + 1}, ${c.color}`}</span>
          <span aria-hidden className="text-[10px] leading-none text-muted-foreground">{i + 1}</span>
        </li>
      ))}
    </ul>
  );
}

function SliderRow({ label, max, value }: { label: string; max: number; value: number }) {
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium">{label}</span>
      <Slider defaultValue={[value]} max={max} disabled aria-label={label} />
    </div>
  );
}

export function SidePanel({ project }: { project: Project | null }) {
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
              {project ? <Swatches project={project} /> : <Empty>{strings.panel.paletteEmpty}</Empty>}
            </section>
            <Separator />
            <SliderRow label={strings.panel.brushSize} max={100} value={30} />
            <SliderRow label={strings.panel.smartFillAngle} max={90} value={30} />
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
