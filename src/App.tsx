import { TooltipProvider } from "@/components/ui/tooltip";
import { Header } from "@/ui/Header";
import { SidePanel } from "@/ui/SidePanel";
import { ToolRail } from "@/ui/ToolRail";
import { useEditorShortcuts } from "@/ui/useEditorShortcuts";
import { useImport } from "@/ui/useImport";
import { usePaintSettings } from "@/ui/usePaintSettings";
import { Viewport } from "@/ui/Viewport";

export default function App() {
  const { project, loading, error, notice, importFiles, dismissError, dismissNotice } = useImport();
  const { settings, patch, step } = usePaintSettings(project);
  useEditorShortcuts({ project, onTool: (tool) => patch({ tool }), onRadius: step });

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden">
        <Header project={project} onImportFiles={importFiles} />
        <div className="flex min-h-0 flex-1">
          <ToolRail tool={settings.tool} onToolChange={(tool) => patch({ tool })} />
          <Viewport
            project={project}
            settings={settings}
            onPickState={(activeState) => patch({ activeState })}
            loading={loading}
            error={error}
            notice={notice}
            onDismissError={dismissError}
            onDismissNotice={dismissNotice}
            onImportFiles={importFiles}
          />
          <SidePanel project={project} settings={settings} onSettings={patch} />
        </div>
      </div>
    </TooltipProvider>
  );
}
