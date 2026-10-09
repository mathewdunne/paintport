import { describe, expect, it } from "vitest";
import { interpretKey } from "@/tools/keys";
import { keyActionAllowed, toolsEnabled } from "./viewMode";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
  interpretKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }, false);

const keys = {
  tools: ["b", "f", "s", "e", "i"].map((k) => key(k)!),
  radius: ["[", "]"].map((k) => key(k)!),
  undo: key("z", { ctrlKey: true })!,
  redo: [key("z", { ctrlKey: true, shiftKey: true })!, key("y", { ctrlKey: true })!],
};

describe("view mode", () => {
  it("has the tools on in Design and off in Print", () => {
    expect(toolsEnabled("design")).toBe(true);
    expect(toolsEnabled("print")).toBe(false);
  });

  it("lets every editor key through in Design", () => {
    for (const action of [...keys.tools, ...keys.radius, keys.undo, ...keys.redo]) {
      expect(action).toBeTruthy();
      expect(keyActionAllowed(action, toolsEnabled("design"))).toBe(true);
    }
  });

  it("stops every editor key in Print, undo and redo included (view-only)", () => {
    for (const action of [...keys.tools, ...keys.radius, keys.undo, ...keys.redo]) {
      expect(keyActionAllowed(action, toolsEnabled("print"))).toBe(false);
    }
  });
});
