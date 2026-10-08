import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards the tsconfig.test.json setup: test files can use Node APIs and types.
describe("test tsconfig", () => {
  it("allows node:fs and Buffer in tests", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url));
    expect(Buffer.isBuffer(html)).toBe(true);
    expect(html.toString("utf8")).toContain("PaintPort+");
  });
});
