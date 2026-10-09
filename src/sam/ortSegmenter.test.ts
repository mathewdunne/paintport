import { describe, expect, it } from "vitest";
import { OrtSegmenter, type SessionLike, type TensorFactory, type TensorLike } from "./ortSegmenter";
import { SAM_MODEL } from "./model";
import { settle } from "../../test/support/fakeSam";

type FakeTensor = TensorLike & { type: string; disposed: boolean };
const tensor: TensorFactory = (type, data, dims) => {
  const t: FakeTensor = { type, data, dims, disposed: false, dispose() { t.disposed = true; } };
  return t;
};

class FakeSession implements SessionLike {
  readonly feeds: Record<string, TensorLike>[] = [];
  released = false;
  constructor(private readonly answer: () => Record<string, TensorLike>) {}
  async run(feeds: Record<string, TensorLike>) {
    this.feeds.push(feeds);
    return this.answer();
  }
  async release() { this.released = true; }
}

const model = { ...SAM_MODEL, inputSize: 16 };
const GRID = 4; // decoder masks are 4 x 4 cells over the 16 px input

function setup() {
  const embeddings = tensor("float32", new Float32Array(1), [1]);
  const positional = tensor("float32", new Float32Array(1), [1]);
  const encoder = new FakeSession(() => ({ image_embeddings: embeddings, image_positional_embeddings: positional }));
  const masks = Float32Array.from({ length: 3 * GRID * GRID }, (_, i) => i);
  const decoder = new FakeSession(() => ({
    iou_scores: tensor("float32", Float32Array.of(0.1, 0.9, 0.5), [1, 1, 3]),
    pred_masks: tensor("float32", masks, [1, 1, 3, GRID, GRID]),
  }));
  return { segmenter: new OrtSegmenter(tensor, encoder, decoder, model), encoder, decoder, embeddings, positional };
}

const image = { width: 16, height: 8, data: new Uint8Array(16 * 8 * 4) };

describe("OrtSegmenter", () => {
  it("feeds the normalized, padded image to the encoder and frees its input", async () => {
    const { segmenter, encoder } = setup();
    const embedding = await segmenter.encode(image);
    expect(embedding).toMatchObject({ width: 16, height: 8 });
    const pixels = encoder.feeds[0].pixel_values as FakeTensor;
    expect(pixels.dims).toEqual([1, 3, 16, 16]);
    expect(pixels.type).toBe("float32");
    expect(pixels.disposed).toBe(true);
  });

  it("feeds points and labels to the decoder and returns the masks cropped to the image", async () => {
    const { segmenter, decoder, embeddings, positional } = setup();
    const embedding = await segmenter.encode(image);
    const masks = await segmenter.decode(embedding, [{ x: 3, y: 4, positive: true }, { x: 10, y: 2, positive: false }]);
    const feeds = decoder.feeds[0];
    expect(Array.from(feeds.input_points.data as Float32Array)).toEqual([3, 4, 10, 2]);
    expect(feeds.input_points.dims).toEqual([1, 1, 2, 2]);
    expect(Array.from(feeds.input_labels.data as BigInt64Array)).toEqual([1n, 0n]);
    expect(feeds.input_labels.dims).toEqual([1, 1, 2]);
    expect(feeds.image_embeddings).toBe(embeddings);
    expect(feeds.image_positional_embeddings).toBe(positional);
    expect(masks.map((m) => m.score)).toEqual([0.1, 0.9, 0.5].map((s) => Math.fround(s)));
    expect(masks[1]).toMatchObject({ width: 4, height: 2 }); // 16 x 8 image: the top half of the grid
    expect(Array.from(masks[1].logits)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it("frees the embedding tensors with the embedding and releases the sessions", async () => {
    const { segmenter, encoder, decoder, embeddings } = setup();
    (await segmenter.encode(image)).dispose();
    expect((embeddings as FakeTensor).disposed).toBe(true);
    segmenter.dispose();
    await settle();
    expect(encoder.released && decoder.released).toBe(true);
  });

  it("serializes encodes and decodes that share the WebGPU runtime", async () => {
    const s = setup();
    const embedding = await s.segmenter.encode(image);
    let finish!: () => void;
    const run = s.encoder.run.bind(s.encoder);
    s.encoder.run = async (feeds) => {
      const result = await run(feeds);
      await new Promise<void>((resolve) => { finish = resolve; });
      return result;
    };
    const second = s.segmenter.encode(image);
    const third = s.segmenter.encode(image);
    const decode = s.segmenter.decode(embedding, [{ x: 3, y: 4, positive: true }]);
    await settle();
    expect(s.encoder.feeds).toHaveLength(2); // only the first new encode is running
    expect(s.decoder.feeds).toHaveLength(0);
    finish();
    await second;
    await settle();
    expect(s.encoder.feeds).toHaveLength(3);
    expect(s.decoder.feeds).toHaveLength(0);
    finish();
    await third;
    await decode;
    expect(s.decoder.feeds).toHaveLength(1);
  });

  it("does not release a session while it is running", async () => {
    const s = setup();
    let finish!: () => void;
    const run = s.encoder.run.bind(s.encoder);
    s.encoder.run = async (feeds) => {
      const result = await run(feeds);
      await new Promise<void>((resolve) => { finish = resolve; });
      return result;
    };
    const pending = s.segmenter.encode(image);
    await settle();
    s.segmenter.dispose();
    expect(s.encoder.released || s.decoder.released).toBe(false);
    finish();
    await pending;
    await settle();
    expect(s.encoder.released && s.decoder.released).toBe(true);
    await expect(s.segmenter.encode(image)).rejects.toThrow(/disposed/i);
  });

  it("continues accepting work after an inference failure", async () => {
    const s = setup();
    const run = s.encoder.run.bind(s.encoder);
    s.encoder.run = async () => { throw new Error('inference failed'); };
    await expect(s.segmenter.encode(image)).rejects.toThrow('inference failed');
    s.encoder.run = run;
    await expect(s.segmenter.encode(image)).resolves.toMatchObject({ width: 16 });
  });
});
