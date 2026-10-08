import { describe, expect, it } from "vitest";
import { CORE_ERRORS, CoreError } from "@/core";
import { FORMAT_ERRORS, FormatError } from "@/formats/errors";
import { strings } from "@/strings";
import { errorMessage } from "./errorMessage";

describe("errorMessage", () => {
  it("has a human message for every core and format error code", () => {
    for (const code of [...Object.keys(CORE_ERRORS), ...Object.keys(FORMAT_ERRORS)]) {
      expect(strings.errors.codes, code).toHaveProperty(code);
    }
    expect(Object.keys(strings.errors.codes).sort()).toEqual([...Object.keys(CORE_ERRORS), ...Object.keys(FORMAT_ERRORS)].sort());
  });

  it("translates by code and never leaks the English technical text or file content", () => {
    expect(errorMessage(new FormatError("ERR_STL_INVALID", "bad vertex <b>x</b> &amp;"))).toBe(strings.errors.codes.ERR_STL_INVALID);
    expect(errorMessage(new CoreError("ERR_UNIT", "inch"))).toBe(strings.errors.codes.ERR_UNIT);
  });

  it("falls back to the generic message", () => {
    expect(errorMessage(new Error("boom"))).toBe(strings.errors.generic);
    expect(errorMessage({ code: "toString" })).toBe(strings.errors.generic);
    expect(errorMessage(null)).toBe(strings.errors.generic);
    expect(errorMessage("x")).toBe(strings.errors.generic);
  });
});
