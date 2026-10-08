import { describe, expect, it } from "vitest";
import { zipAll } from "../core";
import { FormatError } from "./errors";
import { asciiStl, binaryStl, CUBE_TRIS } from "../../test/support/fixtures";
import { importFile } from "./import";

const enc = new TextEncoder();

const THREEMF = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model" name="Tri"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
const threeMf = () => zipAll([{ name: "3D/3dmodel.model", data: enc.encode(THREEMF) }]);

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e instanceof FormatError ? e.code : "OTHER";
  }
  return "NONE";
}

describe("importFile", () => {
  it("dispatches by extension, case-insensitively", async () => {
    expect((await importFile("part.stl", binaryStl(CUBE_TRIS))).objects[0].name).toBe("part");
    expect((await importFile("PART.STL", asciiStl(CUBE_TRIS))).totalTris).toBe(12);
    expect((await importFile("C:\\models\\q.obj", enc.encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3"))).objects[0].name).toBe("q");
    expect((await importFile("fig.3mf", await threeMf())).objects[0].name).toBe("Tri");
  });

  it("falls back to content when the extension is unknown or missing", async () => {
    expect((await importFile("download", await threeMf())).objects[0].name).toBe("Tri");
    expect((await importFile("mesh.bin", binaryStl(CUBE_TRIS))).totalTris).toBe(12);
    expect((await importFile("mesh.txt", asciiStl(CUBE_TRIS))).totalTris).toBe(12);
  });

  it("rejects unsupported content with a typed error", async () => {
    expect(await code(importFile("notes.txt", enc.encode("just some text")))).toBe("ERR_UNSUPPORTED_FORMAT");
    expect(await code(importFile("empty", new Uint8Array(0)))).toBe("ERR_UNSUPPORTED_FORMAT");
  });

  it("surfaces the format parsers' errors", async () => {
    expect(await code(importFile("a.stl", enc.encode("garbage")))).toBe("ERR_STL_INVALID");
    expect(await code(importFile("a.obj", enc.encode("f 1 2 3")))).toBe("ERR_OBJ_INVALID");
  });
});
