import { describe, expect, it } from "vitest";
import { strings } from "./strings";

describe("strings", () => {
  it("exposes the app name", () => {
    expect(strings.appName).toBe("PaintPort+");
  });

  it("has no empty user-facing strings", () => {
    const empty: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (typeof node === "string") {
        if (node.trim() === "") empty.push(path);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
      }
    };
    walk(strings, "strings");
    expect(empty).toEqual([]);
  });
});
