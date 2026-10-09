import { useCallback, useEffect, useRef, useState } from "react";
import { MODEL_CACHE } from "@/persist/modelCache";
import { downloadBytes, isModelCached, loadModelFiles, modelUrls, ORT_WASM_URL } from "@/sam/loadModel";
import { SAM_MODEL } from "@/sam/model";
import type { Segmenter } from "@/sam/types";
import { checkWebGpu, type GpuLike } from "@/sam/webgpu";

export type AiModelState =
  | { kind: "checking" }
  | { kind: "unavailable"; reason: "noWebGpu" | "noAdapter" | "noF16" | "noCache" }
  /** Available; the cache isn't checked until the tool is chosen. */
  | { kind: "idle" }
  | { kind: "needsDownload"; bytes: number }
  | { kind: "downloading"; loaded: number; total: number }
  | { kind: "starting" }
  | { kind: "ready"; segmenter: Segmenter }
  | { kind: "failed" };

const urls = () => modelUrls(SAM_MODEL, ORT_WASM_URL);

/**
 * AI Paint's model (spec Q10.6, Q10.7). WebGPU is checked once at startup, which decides whether
 * the tool is offered. The first time the tool is chosen, a cached model starts without asking;
 * otherwise the panel asks before `download()` fetches it (weights from Hugging Face, the runtime from our origin).
 */
export function useAiModel(toolChosen: boolean): { state: AiModelState; download: () => void } {
  const [state, setState] = useState<AiModelState>({ kind: "checking" });
  const segmenter = useRef<Segmenter | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    void checkWebGpu((navigator as Navigator & { gpu?: GpuLike }).gpu, SAM_MODEL.requiresF16).then((a) => {
      if (live) setState(a.ok ? { kind: "idle" } : { kind: "unavailable", reason: a.reason });
    });
    return () => {
      live = false;
      segmenter.current?.dispose();
      segmenter.current = null;
    };
  }, []);

  const start = useCallback(async (fromCache: boolean) => {
    if (busy.current || segmenter.current) return;
    busy.current = true;
    try {
      const cache = await caches.open(MODEL_CACHE);
      const total = downloadBytes(SAM_MODEL);
      setState(fromCache ? { kind: "starting" } : { kind: "downloading", loaded: 0, total });
      const files = await loadModelFiles(SAM_MODEL, urls(), cache, (url) => fetch(url), fromCache ? undefined : (loaded) => setState({ kind: "downloading", loaded, total }));
      setState({ kind: "starting" });
      const { createOrtSegmenter } = await import("@/sam/ortSegmenter");
      const created = await createOrtSegmenter(SAM_MODEL, files);
      segmenter.current = created;
      setState({ kind: "ready", segmenter: created });
    } catch (error) {
      console.error("AI Paint model failed to load", error);
      setState({ kind: "failed" });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!toolChosen || state.kind !== "idle") return;
    let live = true;
    void (async () => {
      let cached = false;
      try {
        cached = await isModelCached(urls(), await caches.open(MODEL_CACHE));
      } catch {
        if (live) setState({ kind: "unavailable", reason: "noCache" }); // no Cache API (private window, insecure origin)
        return;
      }
      if (!live) return;
      if (cached) void start(true);
      else setState({ kind: "needsDownload", bytes: downloadBytes(SAM_MODEL) });
    })();
    return () => { live = false; };
  }, [toolChosen, state.kind, start]);

  const download = useCallback(() => void start(false), [start]);
  return { state, download };
}
