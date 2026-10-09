import { load3MFFiles, unzipAll, type Model } from "../core";
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

/** Unzips a 3MF, hands the members to `onArchive` (if any), then loads the model from them. */
async function load3MFBytes(bytes: Uint8Array, onArchive?: (files: ReadonlyMap<string, Uint8Array>) => void): Promise<Model> {
  const files = await unzipAll(bytes);
  onArchive?.(files);
  return load3MFFiles(files);
}

/**
 * Loads a 3MF, STL or OBJ file into the core's Model. The extension decides; unknown
 * extensions fall back to the content (ZIP signature -> 3MF, STL layout -> STL).
 *
 * For a 3MF, `onArchive` is called once with the unzipped members before the model is read,
 * so a caller that also wants some other member (the design sidecar) can take it from the same
 * unzipping instead of inflating the archive a second time. It is not called for STL or OBJ.
 * Copy what you need: the map is not kept alive after the import.
 */
export async function importFile(name: string, bytes: Uint8Array, onArchive?: (files: ReadonlyMap<string, Uint8Array>) => void): Promise<Model> {
  const ext = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  switch (ext) {
    case "3mf":
      return load3MFBytes(bytes, onArchive);
    case "stl":
      return parseStl(bytes, baseName(name));
    case "obj":
      return parseObj(bytes, baseName(name));
  }
  if (isZip(bytes)) return load3MFBytes(bytes, onArchive);
  if (isBinaryStl(bytes) || looksLikeAsciiStl(bytes)) return parseStl(bytes, baseName(name));
  throw formatError("ERR_UNSUPPORTED_FORMAT", ext ? "." + ext : undefined);
}
