// File import for the app: a 3MF, STL or OBJ becomes a Project, restored from the PaintPort+
// design sidecar when the file carries a valid one (spec 5.4). DOM-free.
import { importFile } from "../formats/import";
import { createProject, type Project, type ProjectOptions } from "./project";
import { isSidecarMember, readSidecar } from "./sidecar";

/** What happened to the design sidecar: used, present but unusable, or not there. */
export type SidecarOutcome = "restored" | "ignored" | "none";

export interface ImportedProject {
  project: Project;
  sidecar: SidecarOutcome;
  /** Why the sidecar was ignored (for the log, not for users). */
  reason?: string;
}

/**
 * Reads the file once (a 3MF is unzipped once, the sidecar is taken from the same archive)
 * and builds the project: from the sidecar when it matches the model, else from the file's
 * own colors exactly as `createProject` does. A sidecar that is damaged or belongs to other
 * geometry is ignored, never an error. The file's name without extension becomes the
 * project's source name unless the sidecar remembers the original one.
 */
export async function importProject(fileName: string, bytes: Uint8Array, options: ProjectOptions = {}): Promise<ImportedProject> {
  const members = new Map<string, Uint8Array>();
  let is3mf = false; // the archive callback only fires for a 3MF
  const model = await importFile(fileName, bytes, (files) => {
    is3mf = true;
    for (const [name, data] of files) if (isSidecarMember(name)) members.set(name, data);
  });
  const name = fileName.replace(/\.[^.]*$/, "");
  const result = readSidecar(members, model, { ...options, name });
  if (result.status === "restored") return { project: result.project, sidecar: "restored" };
  // A 3MF's names are XML attribute text; an STL or OBJ name is the file name, plain text.
  const project = createProject(model, { ...options, name, plainNames: !is3mf });
  return result.status === "ignored" ? { project, sidecar: "ignored", reason: result.reason } : { project, sidecar: "none" };
}
