import { useCallback, useEffect, useRef, useState } from "react";
import { createProject, type Project } from "@/doc/project";
import { importFile } from "@/formats/import";
import { strings } from "@/strings";
import { errorMessage } from "./errorMessage";

/** Resolves after the browser has had a chance to paint (so a spinner shows before heavy work). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100); // rAF does not fire in background tabs
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); resolve(); }, 0));
  });
}

/** Loads files into a Project. A newer import supersedes an older one still in flight. */
export function useImport() {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);

  /** Imports the first file; with several, says that only one is imported at a time. */
  const importFiles = useCallback(async (files: ArrayLike<File>) => {
    const file = files[0];
    if (!file) return;
    const id = ++latest.current;
    setLoading(true);
    setError(null);
    setNotice(files.length > 1 ? strings.viewport.oneFileOnly : null);
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
  }, []);

  const dismissError = useCallback(() => setError(null), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

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

  return { project, loading, error, notice, importFiles, dismissError, dismissNotice };
}
