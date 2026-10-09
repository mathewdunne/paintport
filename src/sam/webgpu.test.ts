import { describe, expect, it } from "vitest";
import { checkWebGpu, type GpuLike } from "./webgpu";

const gpu = (adapter: { features: string[] } | null | "throws"): GpuLike => ({
  requestAdapter: async () => {
    if (adapter === "throws") throw new Error("no");
    return adapter && { features: new Set(adapter.features) };
  },
});

describe("checkWebGpu", () => {
  it("needs the API, an adapter and, for float16 models, shader-f16", async () => {
    expect(await checkWebGpu(undefined, false)).toEqual({ ok: false, reason: "noWebGpu" });
    expect(await checkWebGpu(gpu(null), false)).toEqual({ ok: false, reason: "noAdapter" });
    expect(await checkWebGpu(gpu("throws"), false)).toEqual({ ok: false, reason: "noAdapter" });
    expect(await checkWebGpu(gpu({ features: [] }), true)).toEqual({ ok: false, reason: "noF16" });
    expect(await checkWebGpu(gpu({ features: [] }), false)).toEqual({ ok: true });
    expect(await checkWebGpu(gpu({ features: ["shader-f16"] }), true)).toEqual({ ok: true });
  });
});
