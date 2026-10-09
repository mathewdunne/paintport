// AI Paint's model files (spec Q10.6): downloaded once (weights from Hugging Face, the runtime from our origin), kept in the
// browser's Cache API so later sessions (and offline use) don't download them again, and checked
// against their SHA-256 so a damaged file is never used. The cache and fetch are passed in, so
// this runs in Node tests.

/** The Cache API store the model files live in. */
export const MODEL_CACHE = "paintportplus-models";

/** The parts of a `Cache` used here. */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
  delete(url: string): Promise<boolean>;
}

export type FetchLike = (url: string) => Promise<Response>;

export interface LoadOptions {
  cache: CacheLike;
  fetch: FetchLike;
  /** When given, a cached copy that doesn't match is dropped and a download that doesn't match fails. */
  sha256?: string;
  /** Called with the number of bytes received so far. */
  onProgress?: (loaded: number) => void;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isCached(url: string, cache: CacheLike): Promise<boolean> {
  return (await cache.match(url)) !== undefined;
}

/** The file's bytes, from the cache or downloaded (then cached). */
export async function loadCached(url: string, options: LoadOptions): Promise<Uint8Array<ArrayBuffer>> {
  const { cache, sha256, onProgress } = options;
  const cached = await cache.match(url);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (!sha256 || (await sha256Hex(bytes)) === sha256) {
      onProgress?.(bytes.length);
      return bytes;
    }
    await cache.delete(url);
  }
  const response = await options.fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
  const bytes = await readAll(response, onProgress);
  if (sha256 && (await sha256Hex(bytes)) !== sha256) throw new Error(`Downloaded file is damaged: ${url}`);
  await cache.put(url, new Response(bytes.slice()));
  return bytes;
}

async function readAll(response: Response, onProgress?: (loaded: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.(bytes.length);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
