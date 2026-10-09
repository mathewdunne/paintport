import { describe, expect, it } from "vitest";
import { cubeMesh, makeModel } from "../../../test/support/docFixtures";
import { unzipAll, zipAll } from "@/core";
import { createProject } from "@/doc/project";
import { defaultExportSettings } from "@/persist/exportSettings";
import { strings } from "@/strings";
import { errorMessage } from "../errorMessage";
import { defaultExportDeps, runExport, type ExportDeps } from "./runExport";

const project = () => createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }] }));

describe("runExport", () => {
  it("builds, zips and saves under the built name, and returns the name", async () => {
    const calls: string[] = [];
    const saved: { name: string; bytes: Uint8Array }[] = [];
    const deps: ExportDeps = {
      build: () => { calls.push("build"); return { entries: [{ name: "a.txt", data: new Uint8Array([1, 2, 3]) }], fileName: "cube_INDX_CMY.3mf" }; },
      zip: async (entries) => { calls.push("zip"); return zipAll(entries); },
      save: (name, bytes) => { calls.push("save"); saved.push({ name, bytes }); },
    };
    const name = await runExport(project(), defaultExportSettings(), deps);
    expect(name).toBe("cube_INDX_CMY.3mf");
    expect(calls).toEqual(["build", "zip", "save"]);
    expect(saved[0].name).toBe("cube_INDX_CMY.3mf");
    expect([...(await unzipAll(saved[0].bytes)).get("a.txt")!]).toEqual([1, 2, 3]);
  });

  it("saves nothing when the build refuses", async () => {
    let saved = 0;
    const deps: ExportDeps = {
      build: () => { throw Object.assign(new Error("no"), { code: "ERR_BBS_MAX16" }); },
      zip: zipAll,
      save: () => { saved++; },
    };
    await expect(runExport(project(), defaultExportSettings(), deps)).rejects.toMatchObject({ code: "ERR_BBS_MAX16" });
    expect(saved).toBe(0);
  });

  it("with the real build, saves a 3MF with the model and the design sidecar", async () => {
    const saved: { name: string; bytes: Uint8Array }[] = [];
    const name = await runExport(project(), defaultExportSettings(), { ...defaultExportDeps, save: (n, bytes) => { saved.push({ name: n, bytes }); } });
    expect(name).toMatch(/_INDX.*\.3mf$/);
    expect(saved).toHaveLength(1);
    const files = await unzipAll(saved[0].bytes);
    expect([...files.keys()].some((f) => f.endsWith(".model"))).toBe(true);
    expect(files.has("Metadata/PaintPortPlus.json")).toBe(true);
  });

  it("refuses with the document's error when no spool is on", async () => {
    const settings = defaultExportSettings();
    const off = { ...settings, spools: settings.spools.map((s) => ({ ...s, on: false })) };
    let saved = 0;
    const error = await runExport(project(), off, { ...defaultExportDeps, save: () => { saved++; } }).catch((e: unknown) => e);
    expect(saved).toBe(0);
    expect(errorMessage(error, strings.export.failed)).toBe(strings.errors.codes.EXPORT_NO_SPOOL);
  });
});
