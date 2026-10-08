import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Header } from "@/ui/Header";
import { SidePanel } from "@/ui/SidePanel";
import { ToolRail } from "@/ui/ToolRail";
import { useToolShortcuts, type ToolId } from "@/ui/tools";
import { useImport } from "@/ui/useImport";
import { Viewport } from "@/ui/Viewport";

export default function App() {
  const [tool, setTool] = useState<ToolId>("brush");
  useToolShortcuts(setTool);
  const { project, loading, error, notice, importFiles, dismissError, dismissNotice } = useImport();

  return (
    <TooltipProvider>
      <div className="flex h-dvh w-full flex-col overflow-hidden">
        <Header onImportFiles={importFiles} />
        <div className="flex min-h-0 flex-1">
          <ToolRail tool={tool} onToolChange={setTool} />
          <Viewport
            project={project}
            loading={loading}
            error={error}
            notice={notice}
            onDismissError={dismissError}
            onDismissNotice={dismissNotice}
            onImportFiles={importFiles}
          />
          <SidePanel project={project} />
        </div>
      </div>
    </TooltipProvider>
  );
}
