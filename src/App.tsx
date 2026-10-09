import { useEffect, useMemo, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { strings } from "@/strings";
import { ConfirmDialog } from "@/ui/ConfirmDialog";
import { Header } from "@/ui/Header";
import { printColorTable } from "@/ui/export/mappingView";
import { useExportAction } from "@/ui/export/useExportAction";
import { useExportSettings } from "@/ui/export/useExportSettings";
import { useMapping } from "@/ui/export/useMapping";
import { SidePanel, type PanelTab } from "@/ui/SidePanel";
import type { ToolId } from "@/tools/types";
import { useAiModel } from "@/ui/useAiModel";
import { ToolRail } from "@/ui/ToolRail";
import { useEditorShortcuts } from "@/ui/useEditorShortcuts";
import { useObjectVisibility } from "@/ui/useObjectVisibility";
import { usePaintSettings } from "@/ui/usePaintSettings";
import { useSession } from "@/ui/useSession";
import { useViewMode } from "@/ui/useViewMode";
import { toolsEnabled } from "@/ui/viewMode";
import { Viewport } from "@/ui/Viewport";

export default function App() {
  const session = useSession();
  const { project } = session;
  const { settings, patch, step, resetSmartFill, fillAdvancedOpen, setFillAdvancedOpen } = usePaintSettings(project);
  const visibility = useObjectVisibility(project);
  const { view, setView } = useViewMode(project);
  const toolsOn = toolsEnabled(view);
  const ai = useAiModel(settings.tool === "aiPaint");
  const aiUnavailable = ai.state.kind === "unavailable" ? strings.aiUnavailable[ai.state.reason] : null;
  const chooseTool = (tool: ToolId) => {
    if (tool === "aiPaint" && aiUnavailable) return;
    patch({ tool });
  };
  // A tool that turned out to be unavailable (e.g. no Cache API) gives way to the brush.
  useEffect(() => {
    if (aiUnavailable && settings.tool === "aiPaint") patch({ tool: "brush" });
  }, [aiUnavailable, settings.tool, patch]);
  useEditorShortcuts({ project, onTool: chooseTool, onRadius: step, toolsEnabled: toolsOn });

  const [tab, setTab] = useState<PanelTab>("paint");
  const { settings: exportSettings, update: updateExportSettings } = useExportSettings();
  // The mapping is needed by the Export tab and the Print view only; otherwise nothing is computed.
  const mapping = useMapping(project, exportSettings, tab === "export" || view === "print");
  const printColors = useMemo(
    () => (view === "print" && project && mapping ? printColorTable(project.palette.length, mapping.resolved) : null),
    [view, project, mapping],
  );
  const exporter = useExportAction(project, exportSettings, session.notify);

  const busy = session.restoring ? strings.session.restoring : session.loading ? strings.viewport.loading : null;

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden">
        <Header
          project={project}
          onImportFiles={session.requestImport}
          canImport={!session.restoring}
          canStartNew={session.canStartNew}
          onNew={session.requestNew}
          canEdit={toolsOn}
        />
        <div className="flex min-h-0 flex-1">
          <ToolRail tool={settings.tool} onToolChange={chooseTool} disabled={!toolsOn} unavailable={aiUnavailable ? { aiPaint: aiUnavailable } : undefined} />
          <Viewport
            project={project}
            settings={settings}
            onPickState={(activeState) => patch({ activeState })}
            view={view}
            onViewChange={setView}
            printColors={printColors}
            busy={busy}
            error={session.error}
            hiddenObjects={visibility.hidden}
            notices={session.notices}
            onDismissError={session.dismissError}
            onDismissNotice={session.dismissNotice}
            onImportFiles={session.requestImport}
            segmenter={ai.state.kind === "ready" ? ai.state.segmenter : null}
          />
          <SidePanel
            project={project}
            tab={tab}
            onTab={setTab}
            settings={settings}
            onSettings={patch}
            fillAdvancedOpen={fillAdvancedOpen}
            onFillAdvancedOpen={setFillAdvancedOpen}
            onResetSmartFill={resetSmartFill}
            hiddenObjects={visibility.hidden}
            onToggleObject={visibility.toggle}
            onSoloObject={visibility.solo}
            onShowAllObjects={visibility.showAll}
            exportSettings={exportSettings}
            onExportSettings={updateExportSettings}
            mapping={mapping}
            onExport={() => void exporter.run()}
            exporting={exporter.busy}
            aiModel={ai.state}
            onDownloadAi={ai.download}
          />
        </div>
      </div>
      <ConfirmDialog confirmation={session.confirmation} onCancel={session.cancelConfirmation} />
    </TooltipProvider>
  );
}
