import { TooltipProvider } from "@/components/ui/tooltip";
import { strings } from "@/strings";
import { ConfirmDialog } from "@/ui/ConfirmDialog";
import { Header } from "@/ui/Header";
import { SidePanel } from "@/ui/SidePanel";
import { ToolRail } from "@/ui/ToolRail";
import { useEditorShortcuts } from "@/ui/useEditorShortcuts";
import { useObjectVisibility } from "@/ui/useObjectVisibility";
import { usePaintSettings } from "@/ui/usePaintSettings";
import { useSession } from "@/ui/useSession";
import { Viewport } from "@/ui/Viewport";

export default function App() {
  const session = useSession();
  const { project } = session;
  const { settings, patch, step } = usePaintSettings(project);
  const visibility = useObjectVisibility(project);
  useEditorShortcuts({ project, onTool: (tool) => patch({ tool }), onRadius: step });

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
        />
        <div className="flex min-h-0 flex-1">
          <ToolRail tool={settings.tool} onToolChange={(tool) => patch({ tool })} />
          <Viewport
            project={project}
            settings={settings}
            onPickState={(activeState) => patch({ activeState })}
            busy={busy}
            error={session.error}
            hiddenObjects={visibility.hidden}
            notices={session.notices}
            onDismissError={session.dismissError}
            onDismissNotice={session.dismissNotice}
            onImportFiles={session.requestImport}
          />
          <SidePanel
            project={project}
            settings={settings}
            onSettings={patch}
            hiddenObjects={visibility.hidden}
            onToggleObject={visibility.toggle}
            onSoloObject={visibility.solo}
            onShowAllObjects={visibility.showAll}
          />
        </div>
      </div>
      <ConfirmDialog confirmation={session.confirmation} onCancel={session.cancelConfirmation} />
    </TooltipProvider>
  );
}
