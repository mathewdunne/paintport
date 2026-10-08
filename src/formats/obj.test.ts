import { describe, expect, it } from "vitest";
import { FormatError } from "./errors";
import { parseObj } from "./obj";

const parse = (text: string, name?: string) => parseObj(new TextEncoder().encode(text), name);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof FormatError ? e.code : "OTHER";
  }
  return "NONE";
};

describe("parseObj", () => {
  it("reads vertices and a triangle", () => {
    const m = parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", "tri");
    const o = m.objects[0];
    expect(o.name).toBe("tri");
    expect(Array.from(o.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(o.tris)).toEqual([0, 1, 2]);
    expect(m.filaments).toHaveLength(1);
  });

  it("fan-triangulates quads and larger polygons", () => {
    const m = parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0.5 2 0\nf 1 2 3 4\nf 1 3 4 5\n");
    expect(m.totalTris).toBe(4);
    expect(Array.from(m.objects[0].tris.slice(0, 6))).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("accepts v/vt, v//vn and v/vt/vn face forms", () => {
    const m = parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1/1 2/1 3/1\nf 1//1 2//1 3//1\nf 1/1/1 2/1/1 3/1/1\n");
    expect(m.totalTris).toBe(3);
    expect(m.objects[0].vertices.length / 3).toBe(3);
  });

  it("resolves negative (relative) indices", () => {
    const m = parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\nv 5 5 5\nf -4 -2 -1\n");
    const o = m.objects[0];
    expect(Array.from(o.tris.slice(0, 3))).toEqual([0, 1, 2]);
    // Second face: file vertices 1, 3 and 4 (the welded ids follow first use).
    const verts = Array.from(o.vertices);
    const second = Array.from(o.tris.slice(3, 6)).map((i) => verts.slice(i * 3, i * 3 + 3));
    expect(second).toEqual([[0, 0, 0], [0, 1, 0], [5, 5, 5]]);
  });

  it("welds vertices that share a position and drops unused ones", () => {
    const m = parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 0\nv 9 9 9\nv 1 1 0\nf 1 2 3\nf 4 3 6\n");
    expect(m.objects[0].vertices.length / 3).toBe(4); // 9 9 9 is never used
    expect(m.totalTris).toBe(2);
  });

  it("ignores comments, groups, materials, normals, texcoords, lines, and v with w or colors", () => {
    const m = parse("# c\nmtllib a.mtl\no thing\ng grp\nusemtl red\ns off\nv 0 0 0 1\nv 1 0 0 0.5 0.5 0.5\nv 0 1 0\nvt 0 0\nvn 0 0 1\nl 1 2\nf 1 2 3\n");
    expect(m.totalTris).toBe(1);
  });

  it("handles CRLF, tabs, leading spaces and a missing final newline", () => {
    const m = parse("v 0 0 0\r\n\tv 1 0 0\r\n  v 0 1 0\r\nf 1 2 3");
    expect(m.totalTris).toBe(1);
  });

  it("joins backslash line continuations", () => {
    const m = parse("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 \\\n 3 4\n");
    expect(m.totalTris).toBe(2);
  });

  it("rejects invalid input with typed errors", () => {
    expect(code(() => parse("v 0 0\nf 1 2 3\n"))).toBe("ERR_OBJ_INVALID");
    expect(code(() => parse("v 0 0 x\n"))).toBe("ERR_OBJ_INVALID");
    expect(code(() => parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n"))).toBe("ERR_OBJ_INVALID");
    expect(code(() => parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 0\n"))).toBe("ERR_OBJ_INVALID");
    expect(code(() => parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf -4 -2 -1\n"))).toBe("ERR_OBJ_INVALID");
    expect(code(() => parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2\n"))).toBe("ERR_OBJ_INVALID");
    expect(code(() => parse("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 x\n"))).toBe("ERR_OBJ_INVALID");
    expect(code(() => parse("v 0 0 0\nv 1 0 0\nv 0 1 0\n"))).toBe("ERR_OBJ_EMPTY");
    expect(code(() => parse(""))).toBe("ERR_OBJ_EMPTY");
    expect(code(() => parse("v 0 0 0\nv 0 0 0\nv 0 0 0\nf 1 2 3\n"))).toBe("ERR_OBJ_EMPTY"); // collapses to nothing
  });
});
