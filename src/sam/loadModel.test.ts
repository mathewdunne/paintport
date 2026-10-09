import { describe, expect, it } from "vitest";
import { sha256Hex, type CacheLike } from "../persist/modelCache";
import { downloadBytes, isModelCached, loadModelFiles, modelUrls } from "./loadModel";
import { SAM_MODEL } from "./model";
import type { SamManifest } from "./manifest";

class MapCache implements CacheLike {
  readonly store = new Map<string, Uint8Array<ArrayBuffer>>();
  async match(url: string) { const b = this.store.get(url); return b ? new Response(b.slice()) : undefined; }
  async put(url: string, r: Response) { this.store.set(url, new Uint8Array(await r.arrayBuffer())); }
  async delete(url: string) { return this.store.delete(url); }
}

const REV = `https://huggingface.co/Xenova/m/resolve/${"c".repeat(40)}/onnx`;
const WASM = "https://app.test/assets/ort.wasm";
const enc = new TextEncoder();
const FILES: Record<string, Uint8Array<ArrayBuffer>> = {
  [`${REV}/enc.onnx`]: enc.encode("encoder"),
  [`${REV}/dec.onnx`]: enc.encode("dec"),
  [WASM]: enc.encode("wasm!"),
};

async function manifest(): Promise<SamManifest> {
  return {
    ...SAM_MODEL,
    encoder: { url: `${REV}/enc.onnx`, bytes: 7, sha256: await sha256Hex(FILES[`${REV}/enc.onnx`]) },
    decoder: { url: `${REV}/dec.onnx`, bytes: 3, sha256: await sha256Hex(FILES[`${REV}/dec.onnx`]) },
    runtimeBytes: 5,
  };
}

const fetch = async (url: string) => (FILES[url] ? new Response(FILES[url].slice()) : new Response(null, { status: 404 }));

describe("model loading", () => {
  it("takes the model files from the manifest and the runtime from the app's wasm asset", async () => {
    expect(modelUrls(await manifest(), WASM)).toEqual({ encoder: `${REV}/enc.onnx`, decoder: `${REV}/dec.onnx`, wasm: WASM });
  });

  it("counts the bytes the download prompt names", async () => {
    expect(downloadBytes(await manifest())).toBe(15);
  });

  it("loads all three files, reports overall progress and is cached afterwards", async () => {
    const m = await manifest(), cache = new MapCache(), urls = modelUrls(m, WASM);
    expect(await isModelCached(urls, cache)).toBe(false);
    const progress: number[] = [];
    const files = await loadModelFiles(m, urls, cache, fetch, (loaded) => progress.push(loaded));
    expect(new TextDecoder().decode(files.encoder)).toBe("encoder");
    expect(new TextDecoder().decode(files.wasm)).toBe("wasm!");
    expect(progress.at(-1)).toBe(15);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);
    expect(await isModelCached(urls, cache)).toBe(true);
  });

  it("fails when a model file doesn't match its hash", async () => {
    const m = await manifest();
    m.decoder.sha256 = "f".repeat(64);
    await expect(loadModelFiles(m, modelUrls(m, WASM), new MapCache(), fetch)).rejects.toThrow(/damaged/);
  });
});
