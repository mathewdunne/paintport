import { useRef, type ChangeEvent } from "react";
import { ExternalLink, FilePlus, Redo2, Undo2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Project } from "@/doc/project";
import { strings } from "@/strings";
import { ThemeToggle } from "./ThemeToggle";
import { useHistoryState } from "./useProjectState";

interface HeaderProps {
  project: Project | null;
  onImportFiles: (files: ArrayLike<File>) => void;
  /** False while the last session is being restored. */
  canImport: boolean;
  /** "New" needs something to discard: a project, or a saved session of a newer version. */
  canStartNew: boolean;
  onNew: () => void;
}

export function Header({ project, onImportFiles, canImport, canStartNew, onNew }: HeaderProps) {
  const input = useRef<HTMLInputElement>(null);
  const { canUndo, canRedo } = useHistoryState(project);

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ""; // so picking the same file again still fires a change
    onImportFiles(files);
  };

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
      <span className="text-sm font-semibold tracking-tight">{strings.appName}</span>
      <div className="flex items-center gap-2">
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={!canUndo} onClick={() => project?.undo()} aria-label={strings.header.undo}>
                <Undo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{strings.header.undoHint}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" disabled={!canRedo} onClick={() => project?.redo()} aria-label={strings.header.redo}>
                <Redo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{strings.header.redoHint}</TooltipContent>
          </Tooltip>
        </div>
        <input ref={input} type="file" accept=".3mf,.stl,.obj" className="hidden" onChange={onChange} />
        <Button variant="outline" size="sm" title={strings.header.newProjectHint} disabled={!canStartNew} onClick={onNew}>
          <FilePlus />
          {strings.header.newProject}
        </Button>
        <Button size="sm" title={strings.header.importHint} disabled={!canImport} onClick={() => input.current?.click()}>
          <Upload />
          {strings.header.import}
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="sm" asChild>
          <a href="./classic/" title={strings.header.classicHint}>
            {strings.header.classic}
            <ExternalLink />
          </a>
        </Button>
      </div>
    </header>
  );
}
