import { useCallback, useState } from "react";
import type { Project } from "@/doc/project";
import type { ExportSettings } from "@/persist/exportSettings";
import { strings } from "@/strings";
import { errorMessage } from "../errorMessage";
import { nextPaint } from "../nextPaint";
import type { Notify } from "../useNotices";
import { runExport } from "./runExport";

const EXPORTED_NOTICE_MS = 8000;

/** Runs the export and reports the file name, or why it failed, as a notice over the viewport. */
export function useExportAction(project: Project | null, settings: ExportSettings, notify: Notify) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async () => {
    if (!project || busy) return;
    setBusy(true);
    try {
      await nextPaint(); // the build is synchronous: let the busy state show first
      const fileName = await runExport(project, settings);
      notify("export", strings.export.exported(fileName), { autoDismissMs: EXPORTED_NOTICE_MS });
    } catch (error) {
      console.error("Export failed", error);
      notify("export", errorMessage(error, strings.export.failed), { tone: "warning" });
    } finally {
      setBusy(false);
    }
  }, [project, settings, busy, notify]);
  return { run, busy };
}
