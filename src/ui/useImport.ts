import { useCallback, useEffect, useRef, useState } from "react";
import { createProject, type Project } from "@/doc/project";
import { importFile } from "@/formats/import";
import { strings } from "@/strings";
import { errorMessage } from "./errorMessage";
import type { Notify } from "./useNotices";

/** Resolves after the browser has had a chance to paint (so a spinner shows before heavy work). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100); // rAF does not fire in background tabs
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); resolve(); }, 0));
  });
}

/**
 * Holds the open Project and loads files into it. A newer import supersedes an older one
 * still in flight. `adopt` and `clear` set the project from elsewhere (a restored session,
 * "New") and cancel imports in flight.
 */
export function useImport(notify: Notify, dismissNotice: (key: string) => void) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  /** Imports the first file; with several, says that only one is imported at a time. */
  const importFiles = useCallback(async (files: ArrayLike<File>) => {
    const file = files[0];
    if (!file) return;
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    dismissNotice("import");
    if (files.length > 1) notify("import", strings.viewport.oneFileOnly);
    try {
      await nextPaint();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const next = createProject(await importFile(file.name, bytes));
      if (id === latest.current) setProject(next);
    } catch (e) {
      if (id === latest.current) setError(errorMessage(e));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [notify, dismissNotice]);

  /** Makes `next` the open project (null: none). */
  const adopt = useCallback((next: Project | null) => {
    latest.current++;
    setLoading(false);
    setError(null);
    setProject(next);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  // A file dropped outside the viewport must not make the browser navigate to it.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  return { project, loading, error, importFiles, adopt, dismissError };
}
