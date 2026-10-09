import { describe, expect, it } from "vitest";
import { isCached, loadCached, sha256Hex, type CacheLike } from "./modelCache";

class MapCache implements CacheLike {
  readonly store = new Map<string, Uint8Array<ArrayBuffer>>();
  async match(url: string) {
    const b = this.store.get(url);
    return b ? new Response(b.slice()) : undefined;
  }
  async put(url: string, response: Response) {
    this.store.set(url, new Uint8Array(await response.arrayBuffer()));
  }
  async delete(url: string) {
    return this.store.delete(url);
  }
}

const BYTES = new TextEncoder().encode("abc");
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function server(body: Uint8Array<ArrayBuffer> = BYTES, status = 200) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return new Response(body.slice(), { status });
  };
  return { fetch, calls };
}

describe("sha256Hex", () => {
  it("hashes like the standard test vector", async () => {
    expect(await sha256Hex(BYTES)).toBe(ABC_SHA256);
  });
});

describe("loadCached", () => {
  it("downloads once, reports progress and serves the cached copy afterwards", async () => {
    const cache = new MapCache(), { fetch, calls } = server();
    const progress: number[] = [];
    expect(Array.from(await loadCached("models/a", { cache, fetch, sha256: ABC_SHA256, onProgress: (n) => progress.push(n) }))).toEqual(Array.from(BYTES));
    expect(progress.at(-1)).toBe(3);
    expect(await isCached("models/a", cache)).toBe(true);
    expect(Array.from(await loadCached("models/a", { cache, fetch, sha256: ABC_SHA256 }))).toEqual(Array.from(BYTES));
    expect(calls).toEqual(["models/a"]);
  });

  it("refuses a damaged download and does not cache it", async () => {
    const cache = new MapCache(), { fetch } = server(new TextEncoder().encode("abd"));
    await expect(loadCached("models/a", { cache, fetch, sha256: ABC_SHA256 })).rejects.toThrow(/damaged/);
    expect(await isCached("models/a", cache)).toBe(false);
  });

  it("replaces a damaged cached copy", async () => {
    const cache = new MapCache(), { fetch, calls } = server();
    cache.store.set("models/a", new TextEncoder().encode("old"));
    expect(Array.from(await loadCached("models/a", { cache, fetch, sha256: ABC_SHA256 }))).toEqual(Array.from(BYTES));
    expect(calls).toHaveLength(1);
  });

  it("fails on an HTTP error", async () => {
    const cache = new MapCache(), { fetch } = server(BYTES, 404);
    await expect(loadCached("models/a", { cache, fetch })).rejects.toThrow(/404/);
  });

  it("caches a file without a hash as it came", async () => {
    const cache = new MapCache(), { fetch } = server();
    await loadCached("runtime.wasm", { cache, fetch });
    expect(await isCached("runtime.wasm", cache)).toBe(true);
  });
});
