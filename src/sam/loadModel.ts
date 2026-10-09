// AI Paint (spec Q10.6): fetching the model weights (from Hugging Face, pinned in the manifest)
// and ONNX Runtime's WebAssembly binary (a same-origin build asset: Vite emits it next to the
// bundle from this `new URL`, so its URL changes with the ORT version), through the verified cache.
import { isCached, loadCached, type CacheLike, type FetchLike } from "../persist/modelCache";
import type { SamManifest } from "./manifest";

export const ORT_WASM_URL = new URL("../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm", import.meta.url).href;
/** ORT 1.30's WebGPU build also loads its glue script by URL (found in the spike). */
export const ORT_MJS_URL = new URL("../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs", import.meta.url).href;

export interface ModelUrls {
  encoder: string;
  decoder: string;
  wasm: string;
}

export interface SamFiles {
  encoder: Uint8Array<ArrayBuffer>;
  decoder: Uint8Array<ArrayBuffer>;
  wasm: Uint8Array<ArrayBuffer>;
}

/** The files' URLs: the model's from the manifest, and the runtime's wasm asset. */
export function modelUrls(manifest: SamManifest, wasm: string): ModelUrls {
  return { encoder: manifest.encoder.url, decoder: manifest.decoder.url, wasm };
}

/** What the first use downloads, for the prompt. */
export function downloadBytes(manifest: SamManifest): number {
  return manifest.encoder.bytes + manifest.decoder.bytes + manifest.runtimeBytes;
}

export async function isModelCached(urls: ModelUrls, cache: CacheLike): Promise<boolean> {
  for (const url of [urls.encoder, urls.decoder, urls.wasm]) if (!(await isCached(url, cache))) return false;
  return true;
}

/** Loads the three files one after another, reporting the bytes received across all of them. */
export async function loadModelFiles(
  manifest: SamManifest, urls: ModelUrls, cache: CacheLike, fetch: FetchLike, onProgress?: (loaded: number) => void,
): Promise<SamFiles> {
  let done = 0;
  const load = async (url: string, sha256?: string) => {
    const bytes = await loadCached(url, { cache, fetch, sha256, onProgress: (loaded) => onProgress?.(done + loaded) });
    done += bytes.length;
    return bytes;
  };
  const encoder = await load(urls.encoder, manifest.encoder.sha256);
  const decoder = await load(urls.decoder, manifest.decoder.sha256);
  const wasm = await load(urls.wasm);
  return { encoder, decoder, wasm };
}
