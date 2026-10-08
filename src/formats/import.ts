import { load3MF, type Model } from "../core";
import { formatError } from "./errors";
import { parseObj } from "./obj";
import { isBinaryStl, parseStl } from "./stl";

function baseName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem || "Model";
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"
}

function looksLikeAsciiStl(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("solid");
}

/**
 * Loads a 3MF, STL or OBJ file into the core's Model. The extension decides; unknown
 * extensions fall back to the content (ZIP signature -> 3MF, STL layout -> STL).
 */
export async function importFile(name: string, bytes: Uint8Array): Promise<Model> {
  const ext = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  switch (ext) {
    case "3mf":
      return load3MF(bytes);
    case "stl":
      return parseStl(bytes, baseName(name));
    case "obj":
      return parseObj(bytes, baseName(name));
  }
  if (isZip(bytes)) return load3MF(bytes);
  if (isBinaryStl(bytes) || looksLikeAsciiStl(bytes)) return parseStl(bytes, baseName(name));
  throw formatError("ERR_UNSUPPORTED_FORMAT", ext ? "." + ext : undefined);
}
