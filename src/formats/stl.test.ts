import { describe, expect, it } from "vitest";
import { FormatError } from "./errors";
import { asciiStl, binaryStl, CUBE_TRIS } from "../../test/support/fixtures";
import { IMPORT_DEFAULT_COLOR } from "./singleMesh";
import { isBinaryStl, parseStl } from "./stl";

const text = (s: string) => new TextEncoder().encode(s);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof FormatError ? e.code : "OTHER";
  }
  return "NONE";
};

describe("parseStl", () => {
  it("reads a binary STL and welds shared corners", () => {
    const m = parseStl(binaryStl(CUBE_TRIS), "cube");
    expect(m.objects).toHaveLength(1);
    const o = m.objects[0];
    expect(o.name).toBe("cube");
    expect(o.tris.length / 3).toBe(12);
    expect(o.vertices.length / 3).toBe(8);
    expect(o.paints).toHaveLength(12);
    expect(o.paints.every((p) => p === null)).toBe(true);
    expect(o.parts).toEqual([{ firstTri: 0, triCount: 12, extruder: 1, type: "ModelPart", name: null }]);
    expect(o.defaultExtruder).toBe(1);
    expect(o.printable).toBe(true);
    expect(o.transform).toBeNull();
    expect(o.triState).toHaveLength(12);
  });

  it("reads an ASCII STL to the same mesh as the binary one", () => {
    const a = parseStl(asciiStl(CUBE_TRIS));
    const b = parseStl(binaryStl(CUBE_TRIS));
    expect(Array.from(a.objects[0].tris)).toEqual(Array.from(b.objects[0].tris));
    expect(Array.from(a.objects[0].vertices)).toEqual(Array.from(b.objects[0].vertices));
  });

  it("tolerates uppercase keywords, CRLF and a BOM in ASCII files", () => {
    const src = "﻿SOLID x\r\nFACET NORMAL 0 0 1\r\nOUTER LOOP\r\nVERTEX 0 0 0\r\nVERTEX 1 0 0\r\nVERTEX 0 1 0\r\nENDLOOP\r\nENDFACET\r\nENDSOLID x\r\n";
    expect(parseStl(text(src)).totalTris).toBe(1);
  });

  it("treats a binary file whose header starts with solid as binary", () => {
    const bytes = binaryStl(CUBE_TRIS, "solid exported by something");
    expect(isBinaryStl(bytes)).toBe(true);
    expect(parseStl(bytes).totalTris).toBe(12);
  });

  it("accepts a solid-prefixed binary file with trailing padding", () => {
    const bytes = binaryStl(CUBE_TRIS, "solid padded");
    const padded = new Uint8Array(bytes.length + 20);
    padded.set(bytes);
    expect(isBinaryStl(padded)).toBe(true);
    expect(parseStl(padded).totalTris).toBe(12);
  });

  it("rejects a truncated solid-prefixed binary file as invalid, not empty", () => {
    const bytes = binaryStl(CUBE_TRIS, "solid truncated");
    expect(code(() => parseStl(bytes.subarray(0, bytes.length - 60)))).toBe("ERR_STL_INVALID");
    expect(code(() => parseStl(text("solid")))).toBe("ERR_STL_INVALID");
  });

  it("does not take an ASCII file for binary", () => {
    expect(isBinaryStl(asciiStl(CUBE_TRIS))).toBe(false);
  });

  it("accepts padding after the last binary record", () => {
    const bytes = binaryStl(CUBE_TRIS);
    const padded = new Uint8Array(bytes.length + 7);
    padded.set(bytes);
    expect(parseStl(padded).totalTris).toBe(12);
  });

  it("welds -0 and 0 together", () => {
    const m = parseStl(binaryStl([[0, 0, 0, 1, 0, 0, 0, 1, 0], [-0, -0, 0, 0, 1, 0, -1, 0, 0]]));
    expect(m.objects[0].vertices.length / 3).toBe(4);
  });

  it("drops triangles that collapse to a line or point", () => {
    const m = parseStl(binaryStl([[0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 0, 0, 0, 0, 1, 0, 0]]));
    expect(m.totalTris).toBe(1);
    expect(m.objects[0].parts[0].triCount).toBe(1);
  });

  it("gives the default filament and consistent statistics", () => {
    const m = parseStl(binaryStl(CUBE_TRIS));
    expect(m.filaments).toEqual([{
      index: 1, color: IMPORT_DEFAULT_COLOR, colorKnown: false,
      paintedTris: 0, baseTris: 12, paintedShare: 0, baseShare: 12, isDefaultOf: 1,
    }]);
    expect(m.unpainted).toBe(12);
    expect(m.totalTris).toBe(12);
    expect(m.usedExtruders).toEqual([]);
    expect(m.specialVolumes).toBe(0);
    expect(m.sourceIdentity).toBeNull();
  });

  it("rejects garbage, truncated and empty input with typed errors", () => {
    expect(code(() => parseStl(new Uint8Array(0)))).toBe("ERR_STL_INVALID");
    expect(code(() => parseStl(text("hello world")))).toBe("ERR_STL_INVALID");
    expect(code(() => parseStl(binaryStl([])))).toBe("ERR_STL_EMPTY");
    expect(code(() => parseStl(text("solid x\nendsolid x\n")))).toBe("ERR_STL_EMPTY");
    expect(code(() => parseStl(text("solid x\nvertex 0 0 0\nvertex 1 0 0\nendsolid")))).toBe("ERR_STL_INVALID");
    expect(code(() => parseStl(text("solid x\nvertex 0 0 a\nvertex 1 0 0\nvertex 0 1 0\nendsolid")))).toBe("ERR_STL_INVALID");
    expect(code(() => parseStl(binaryStl([[0, 0, 0, 1, 0, 0, NaN, 1, 0]])))).toBe("ERR_STL_INVALID");
    expect(code(() => parseStl(binaryStl([[0, 0, 0, 1, 0, 0, 0, 1, 0]]).subarray(0, 100)))).toBe("ERR_STL_INVALID");
  });
});
