// The export's belt-and-braces refusals: mapping resolution should never produce them (it falls
// back before), so they are exercised with a resolver that misbehaves.
import { describe, expect, it, vi } from "vitest";
import { cubeMesh, leaf, makeModel } from "../../test/support/docFixtures";
import { defaultExportSettings } from "../persist/exportSettings";
import { buildExport } from "./export";
import * as mapping from "./mapping";
import { createProject } from "./project";

vi.mock("./mapping", async (original) => ({ ...(await original<typeof import("./mapping")>()), resolveMapping: vi.fn() }));

const project = () => createProject(makeModel(cubeMesh(), { paints: [leaf(1)], filaments: [{ color: "#FF0000" }] }), { name: "g" });
const refusal = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe("export guards", () => {
  it("refuses a used color that resolved to nothing", () => {
    vi.mocked(mapping.resolveMapping).mockReturnValue(new Map([[1, { kind: "none", source: "auto" }]]));
    expect(refusal(() => buildExport(project(), defaultExportSettings()))).toBe("EXPORT_UNMAPPED");
  });

  it("refuses a blend while ColorMix is off", () => {
    const blend = { kind: "blend" as const, source: "auto" as const, color: "#808080", deltaE: 1, components: [{ slot: 1, color: "#FFFFFF", ratio: 1 }, { slot: 2, color: "#000000", ratio: 1 }] };
    vi.mocked(mapping.resolveMapping).mockReturnValue(new Map([[1, blend]]));
    const settings = defaultExportSettings();
    settings.allowMix = false;
    expect(refusal(() => buildExport(project(), settings))).toBe("EXPORT_MIX_OFF");
    settings.allowMix = true; // and the same resolution is fine with ColorMix on
    expect(refusal(() => buildExport(project(), settings))).toBeUndefined();
  });
});
