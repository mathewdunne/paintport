// The Export button's action: build the project's export, zip it, hand the file to the browser.
// The three steps are injected so the flow is tested without a DOM, and so the build can be swapped in.
import { zipAll, type ZipEntry } from "@/core";
import { buildExport } from "@/doc/export";
import type { Project } from "@/doc/project";
import type { ExportSettings } from "@/persist/exportSettings";

/** What building an export yields: the files of the 3MF archive and the name to save it under. */
export interface BuiltExport {
  entries: ZipEntry[];
  fileName: string;
}

export interface ExportDeps {
  build(project: Project, settings: ExportSettings): BuiltExport;
  zip(entries: ZipEntry[]): Promise<Uint8Array>;
  save(fileName: string, bytes: Uint8Array): void;
}

/** Starts a browser download of `bytes`. The object URL is released a little later, after the download has begun. */
export function downloadBytes(fileName: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "model/3mf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const defaultExportDeps: ExportDeps = { build: (project, settings) => buildExport(project, settings), zip: zipAll, save: downloadBytes };

/** Exports `project` with `settings` and returns the saved file name. Throws what the build throws (a `DocError` for a refusal such as an unmapped color). */
export async function runExport(project: Project, settings: ExportSettings, deps: ExportDeps = defaultExportDeps): Promise<string> {
  const { entries, fileName } = deps.build(project, settings);
  deps.save(fileName, await deps.zip(entries));
  return fileName;
}
