import { describe, expect, it } from "vitest";
import { liveHexInput, parseHexInput, readableOn } from "./hex";

describe("liveHexInput", () => {
  it("applies complete six-digit values, also with # and spaces", () => {
    expect(liveHexInput("123456")).toBe("#123456");
    expect(liveHexInput(" 123456 ")).toBe("#123456");
    expect(liveHexInput("#aBcDeF")).toBe("#ABCDEF");
  });

  it("returns null, never a color, for junk, shorthand and partial input", () => {
    // Regression: a stray letter used to slip through a malformed regex and hand a null color to the picker, which crashed the app.
    for (const text of ["s123456", "123456s", "s", "s 123456", "12345", "1234567", "#12345", "123", "#abc", "", " ", "##123456", "12 3456", "gg1234"]) {
      expect(liveHexInput(text)).toBeNull();
    }
  });
});

describe("parseHexInput", () => {
  it("accepts 3 and 6 digits, with or without #, in any case", () => {
    expect(parseHexInput("#1a2b3c")).toBe("#1A2B3C");
    expect(parseHexInput("1A2B3C")).toBe("#1A2B3C");
    expect(parseHexInput("  #fa0 ")).toBe("#FFAA00");
    expect(parseHexInput("fff")).toBe("#FFFFFF");
  });

  it("rejects half-typed and wrong input instead of padding it", () => {
    for (const bad of ["", "#", "#f", "ab", "#abcd", "#abcde", "#1234567", "#12345g", "red", "##fff", "#ff ff ff"]) expect(parseHexInput(bad)).toBeNull();
  });
});

describe("readableOn", () => {
  it("picks black on light colors and white on dark ones", () => {
    expect(readableOn("#FFFFFF")).toBe("#000000");
    expect(readableOn("#FFFF00")).toBe("#000000");
    expect(readableOn("#000000")).toBe("#FFFFFF");
    expect(readableOn("#0000FF")).toBe("#FFFFFF");
    expect(readableOn("#808080")).toBe("#000000");
    expect(readableOn("#333333")).toBe("#FFFFFF");
  });
});
