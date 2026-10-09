import { describe, expect, it } from "vitest";
import { OrtSegmenter, type SessionLike, type TensorFactory, type TensorLike } from "./ortSegmenter";
import { SAM_MODEL } from "./model";

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
    expect(encoder.released && decoder.released).toBe(true);
  });
});
