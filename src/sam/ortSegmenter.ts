// AI Paint (spec Q10): the model on ONNX Runtime Web with WebGPU. The runtime's WebAssembly
// binary is handed over as bytes (loaded from our own origin and cache, see loadModel.ts), so ORT
// never fetches anything itself. The class takes the runtime pieces as parameters so it runs
// in Node tests with fakes; `createOrtSegmenter` wires in the real runtime.
import { toPixelValues } from "./image";
import { ORT_MJS_URL } from "./loadModel";
import type { SamManifest } from "./manifest";
import { cropToImage } from "./masks";
import type { SamEmbedding, SamImage, SamMask, SamPoint, Segmenter } from "./types";

export interface TensorLike {
  readonly data: unknown;
  readonly dims: readonly number[];
  dispose?(): void;
}

export type TensorFactory = (type: "float32" | "int64", data: Float32Array | BigInt64Array, dims: number[]) => TensorLike;

export interface SessionLike {
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
  release(): Promise<void>;
}

interface OrtEmbedding extends SamEmbedding {
  readonly embeddings: TensorLike;
  readonly positional: TensorLike;
}

export class OrtSegmenter implements Segmenter {
  readonly inputSize: number;
  // Encoder and decoder share ORT's WebGPU/WASM runtime. Overlapping runs (for example,
  // clearing a selection and clicking again during encoding) can deadlock that runtime.
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly tensor: TensorFactory,
    private readonly encoder: SessionLike,
    private readonly decoder: SessionLike,
    private readonly manifest: SamManifest,
  ) {
    this.inputSize = manifest.inputSize;
  }

  encode(image: SamImage): Promise<SamEmbedding> {
    return this.enqueue(() => this.encodeNow(image));
  }

  private async encodeNow(image: SamImage): Promise<SamEmbedding> {
    const { io, inputSize, normalization } = this.manifest;
    const pixels = this.tensor("float32", toPixelValues(image, inputSize, normalization), [1, 3, inputSize, inputSize]);
    try {
      const out = await this.encoder.run({ [io.pixels]: pixels });
      const embeddings = out[io.embeddings], positional = out[io.positional];
      if (!embeddings || !positional) throw new Error("The SAM encoder returned no embeddings");
      const embedding: OrtEmbedding = {
        width: image.width,
        height: image.height,
        embeddings,
        positional,
        dispose() {
          embeddings.dispose?.();
          positional.dispose?.();
        },
      };
      return embedding;
    } finally {
      pixels.dispose?.();
    }
  }

  decode(embedding: SamEmbedding, points: readonly SamPoint[]): Promise<SamMask[]> {
    return this.enqueue(() => this.decodeNow(embedding, points));
  }

  private async decodeNow(embedding: SamEmbedding, points: readonly SamPoint[]): Promise<SamMask[]> {
    const { io, inputSize } = this.manifest;
    const e = embedding as OrtEmbedding;
    const coords = new Float32Array(points.length * 2), labels = new BigInt64Array(points.length);
    points.forEach((p, i) => {
      coords[i * 2] = p.x;
      coords[i * 2 + 1] = p.y;
      labels[i] = p.positive ? 1n : 0n;
    });
    const pointTensor = this.tensor("float32", coords, [1, 1, points.length, 2]);
    const labelTensor = this.tensor("int64", labels, [1, 1, points.length]);
    try {
      const out = await this.decoder.run({ [io.points]: pointTensor, [io.labels]: labelTensor, [io.embeddings]: e.embeddings, [io.positional]: e.positional });
      const scores = out[io.scores], masks = out[io.masks];
      if (!scores || !masks) throw new Error("The SAM decoder returned no masks");
      try {
        const [, , count, rows, cols] = masks.dims;
        if (rows !== cols) throw new Error("The SAM decoder returned non-square masks");
        const data = masks.data as Float32Array, s = scores.data as Float32Array, cells = rows * cols;
        return Array.from({ length: count }, (_, i) => cropToImage(data.subarray(i * cells, (i + 1) * cells), cols, inputSize, embedding, s[i]));
      } finally {
        scores.dispose?.();
        masks.dispose?.();
      }
    } finally {
      pointTensor.dispose?.();
      labelTensor.dispose?.();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.tail.then(async () => {
      try { await this.encoder.release(); }
      finally { await this.decoder.release(); }
    }).catch((error) => console.error("AI Paint runtime cleanup failed", error));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("AI Paint model is disposed"));
    const result = this.tail.then(operation);
    this.tail = result.then(() => {}, () => {}); // a failed run must not poison the queue
    return result;
  }
}

/** The segmenter on WebGPU. `wasm` is ONNX Runtime's WebAssembly binary. */
export async function createOrtSegmenter(manifest: SamManifest, files: { encoder: Uint8Array; decoder: Uint8Array; wasm: Uint8Array }): Promise<Segmenter> {
  const ort = await import("onnxruntime-web/webgpu");
  ort.env.wasm.wasmBinary = files.wasm;
  ort.env.wasm.wasmPaths = { mjs: ORT_MJS_URL };
  ort.env.wasm.numThreads = 1; // GitHub Pages is not cross-origin isolated, so no threads
  const options = { executionProviders: ["webgpu"] };
  const encoder = await ort.InferenceSession.create(files.encoder, options);
  try {
    const decoder = await ort.InferenceSession.create(files.decoder, options);
    const tensor: TensorFactory = (type, data, dims) =>
      type === "int64" ? new ort.Tensor("int64", data as BigInt64Array, dims) : new ort.Tensor("float32", data as Float32Array, dims);
    // ORT's session and tensor types are wider than the parts used here.
    return new OrtSegmenter(tensor, encoder as unknown as SessionLike, decoder as unknown as SessionLike, manifest);
  } catch (error) {
    await encoder.release();
    throw error;
  }
}
