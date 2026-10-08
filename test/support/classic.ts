// Loads the ORIGINAL core (the CORE-START/CORE-END block of public/classic/index.html)
// into an isolated node:vm context, so the TypeScript port can be compared against it.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import type { PaintPortCore } from "../../src/core";
import type { Transform } from "../../src/core/threemf/transform";

export type CoreApi = typeof PaintPortCore;

/** Core functions that the original does not export on PaintPortCore. */
export interface ClassicInternals {
  composeTransform(a: Transform | null, b: Transform | null): Transform | null;
  rgbToHex(rgb: number[]): string;
  rgbToLab(rgb: number[]): [number, number, number];
  srgbToLinear(c: number): number;
  linearToSrgb(c: number): number;
  parseAttrs(tag: string): Record<string, string>;
  parseModelXML(xml: string): unknown;
  crc32(bytes: Uint8Array): number;
  VOLUME_TYPES: Record<string, string>;
  PAINTPORT_VERSION: string;
  CORE_ERRORS: Record<string, string>;
}

export interface ClassicCore {
  core: CoreApi;
  internals: ClassicInternals;
}

let cached: ClassicCore | null = null;

export function loadClassicCore(): ClassicCore {
  if (cached) return cached;
  const html = readFileSync(new URL("../../public/classic/index.html", import.meta.url), "utf8");
  const src = html.split("/*CORE-START*/")[1].split("/*CORE-END*/")[0];
  // Platform globals the core relies on. Everything else (Map, Math, typed arrays, ...) comes
  // from the context's own intrinsics. The core uses no Date or randomness, so no clock
  // freezing is needed for a fair comparison.
  const sandbox = { CompressionStream, DecompressionStream, TextEncoder, TextDecoder, Blob };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx, { filename: "classic-core.js" });
  // Top-level declarations of one script are visible to the next script in the same context.
  vm.runInContext(
    "globalThis.__internals = { composeTransform, rgbToHex, rgbToLab, srgbToLinear, linearToSrgb, parseAttrs, parseModelXML, crc32, VOLUME_TYPES, PAINTPORT_VERSION, CORE_ERRORS };",
    ctx,
  );
  const g = vm.runInContext("globalThis", ctx) as { PaintPortCore: CoreApi; __internals: ClassicInternals };
  cached = { core: g.PaintPortCore, internals: g.__internals };
  return cached;
}
