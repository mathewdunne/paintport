import { describe, expect, it } from "vitest";
import { CORE_ERRORS, CoreError } from "@/core";
import type { DocErrorCode } from "@/doc/errors";
import { FORMAT_ERRORS, FormatError } from "@/formats/errors";
import { strings } from "@/strings";
import { errorMessage } from "./errorMessage";

// The DocError codes the export can refuse with (src/doc/export.ts); the other DocError codes
// are internal and never shown through errorMessage.
const EXPORT_CODES = ["EXPORT_NO_SPOOL", "EXPORT_UNMAPPED", "EXPORT_MIX_OFF", "EXPORT_BAMBU_LIMIT", "EXPORT_TOO_MANY"] as const satisfies readonly DocErrorCode[];

describe("errorMessage", () => {
  it("has a human message for every core, format and export error code", () => {
    const codes = [...Object.keys(CORE_ERRORS), ...Object.keys(FORMAT_ERRORS), ...EXPORT_CODES];
    for (const code of codes) {
      expect(strings.errors.codes, code).toHaveProperty(code);
    }
    expect(Object.keys(strings.errors.codes).sort()).toEqual(codes.sort());
  });

  it("translates by code and never leaks the English technical text or file content", () => {
    expect(errorMessage(new FormatError("ERR_STL_INVALID", "bad vertex <b>x</b> &amp;"))).toBe(strings.errors.codes.ERR_STL_INVALID);
    expect(errorMessage(new CoreError("ERR_UNIT", "inch"))).toBe(strings.errors.codes.ERR_UNIT);
  });

  it("uses the caller's fallback for unknown errors, and still never shows their text", () => {
    expect(errorMessage(new Error("boom"), "Export failed.")).toBe("Export failed.");
    expect(errorMessage(new FormatError("ERR_STL_INVALID", "x"), "Export failed.")).toBe(strings.errors.codes.ERR_STL_INVALID);
  });

  it("falls back to the generic message", () => {
    expect(errorMessage(new Error("boom"))).toBe(strings.errors.generic);
    expect(errorMessage({ code: "toString" })).toBe(strings.errors.generic);
    expect(errorMessage(null)).toBe(strings.errors.generic);
    expect(errorMessage("x")).toBe(strings.errors.generic);
  });
});
