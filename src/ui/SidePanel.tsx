import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { strings } from "@/strings";

function Empty({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function SliderRow({ label, max, value }: { label: string; max: number; value: number }) {
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium">{label}</span>
      <Slider defaultValue={[value]} max={max} disabled aria-label={label} />
    </div>
  );
}

export function SidePanel() {
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
              <Empty>{strings.panel.paletteEmpty}</Empty>
            </section>
            <Separator />
            <SliderRow label={strings.panel.brushSize} max={100} value={30} />
            <SliderRow label={strings.panel.smartFillAngle} max={90} value={30} />
          </TabsContent>
          <TabsContent value="objects">
            <Empty>{strings.panel.objectsEmpty}</Empty>
          </TabsContent>
          <TabsContent value="export">
            <Empty>{strings.panel.exportEmpty}</Empty>
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
