// AI Paint (spec Q10.6): what the model is and how to call it. The weights are not in the repo:
// they're fetched from Hugging Face at a pinned commit, so a change upstream can't swap them,
// and checked against their SHA-256. DOM-free.
import type { Normalization } from "./image";

export interface ModelFile {
  /** `https://huggingface.co/<owner>/<repo>/resolve/<40-hex commit>/<file>`. */
  url: string;
  bytes: number;
  /** Lowercase hex SHA-256 of the file. */
  sha256: string;
}

/** Tensor names of the export (the transformers.js SAM layout). */
export interface SamIo {
  pixels: string;
  embeddings: string;
  positional: string;
  points: string;
  labels: string;
  scores: string;
  masks: string;
}

export interface SamManifest {
  id: string;
  /** Shown in the panel's credits. */
  name: string;
  license: string;
  inputSize: number;
  normalization: Normalization;
  /** Float16 weights: the GPU must support shader-f16. */
  requiresF16: boolean;
  encoder: ModelFile;
  decoder: ModelFile;
  /** Size of the ONNX Runtime WebAssembly file, for the download prompt. */
  runtimeBytes: number;
  io: SamIo;
}

const PINNED_URL = /^https:\/\/huggingface\.co\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/resolve\/[0-9a-f]{40}\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const IO_KEYS = ["pixels", "embeddings", "positional", "points", "labels", "scores", "masks"] as const;

function fail(field: string): never {
  throw new Error(`Invalid SAM manifest: ${field}`);
}

const record = (v: unknown, field: string): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(field);
const text = (v: unknown, field: string): string => (typeof v === "string" && v.length > 0 ? v : fail(field));
const count = (v: unknown, field: string): number => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : fail(field));

function triple(v: unknown, field: string, positive: boolean): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "number" && Number.isFinite(x) && (!positive || x > 0))) fail(field);
  return [v[0], v[1], v[2]];
}

function file(v: unknown, field: string): ModelFile {
  const f = record(v, field);
  const url = text(f.url, `${field}.url`);
  if (!PINNED_URL.test(url) || url.split("/").some((s) => s === "." || s === "..")) fail(`${field}.url`);
  const sha256 = text(f.sha256, `${field}.sha256`);
  if (!SHA256.test(sha256)) fail(`${field}.sha256`);
  return { url, bytes: count(f.bytes, `${field}.bytes`), sha256 };
}

/** Checks a manifest and returns it typed; throws an Error naming the first bad field. */
export function parseManifest(json: unknown): SamManifest {
  const m = record(json, "manifest");
  const norm = record(m.normalization, "normalization");
  const io = record(m.io, "io");
  if (typeof m.requiresF16 !== "boolean") fail("requiresF16");
  return {
    id: text(m.id, "id"),
    name: text(m.name, "name"),
    license: text(m.license, "license"),
    inputSize: count(m.inputSize, "inputSize"),
    normalization: { mean: triple(norm.mean, "normalization.mean", false), std: triple(norm.std, "normalization.std", true) },
    requiresF16: m.requiresF16,
    encoder: file(m.encoder, "encoder"),
    decoder: file(m.decoder, "decoder"),
    runtimeBytes: count(m.runtimeBytes, "runtimeBytes"),
    io: Object.fromEntries(IO_KEYS.map((k) => [k, text(io[k], `io.${k}`)])) as unknown as SamIo,
  };
}
