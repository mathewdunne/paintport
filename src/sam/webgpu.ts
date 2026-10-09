// AI Paint runs on WebGPU only (spec Q10.7). DOM-free: the caller passes `navigator.gpu`.

interface AdapterLike {
  features: { has(feature: string): boolean };
}

/** The part of `navigator.gpu` the check uses. */
export interface GpuLike {
  requestAdapter(options?: { powerPreference?: "high-performance" | "low-power" }): Promise<AdapterLike | null>;
}

export type GpuAvailability = { ok: true } | { ok: false; reason: "noWebGpu" | "noAdapter" | "noF16" };

/** Whether the model can run here: WebGPU, an adapter, and shader-f16 for a float16 model. */
export async function checkWebGpu(gpu: GpuLike | undefined, requireF16: boolean): Promise<GpuAvailability> {
  if (!gpu) return { ok: false, reason: "noWebGpu" };
  let adapter: AdapterLike | null = null;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    adapter = null;
  }
  if (!adapter) return { ok: false, reason: "noAdapter" };
  if (requireF16 && !adapter.features.has("shader-f16")) return { ok: false, reason: "noF16" };
  return { ok: true };
}
