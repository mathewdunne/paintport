import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest";
import { SAM_MODEL } from "./model";

const REV = `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/${"c".repeat(40)}/onnx`;

const valid = () => ({
  id: "slimsam-77", name: "SlimSAM-77", license: "Apache-2.0", inputSize: 1024,
  normalization: { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  requiresF16: false,
  encoder: { url: `${REV}/vision_encoder.onnx`, bytes: 100, sha256: "a".repeat(64) },
  decoder: { url: `${REV}/prompt_encoder_mask_decoder.onnx`, bytes: 50, sha256: "b".repeat(64) },
  runtimeBytes: 1000,
  io: { pixels: "pixel_values", embeddings: "image_embeddings", positional: "image_positional_embeddings", points: "input_points", labels: "input_labels", scores: "iou_scores", masks: "pred_masks" },
});

describe("parseManifest", () => {
  it("accepts a complete manifest", () => {
    expect(parseManifest(valid())).toEqual(valid());
  });

  it("only allows Hugging Face URLs pinned to a commit, so the model can't change under us", () => {
    const bad = [
      "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder.onnx", // not pinned
      `http://huggingface.co/Xenova/slimsam-77-uniform/resolve/${"c".repeat(40)}/onnx/x.onnx`,
      "https://cdn.example.com/x.onnx",
      `https://huggingface.co.evil.test/a/b/resolve/${"c".repeat(40)}/x.onnx`,
      `${REV}/../x.onnx`,
      "",
    ];
    for (const url of bad) {
      const m = valid();
      m.encoder.url = url;
      expect(() => parseManifest(m), url).toThrow(/encoder\.url/);
    }
  });

  it("rejects a bad hash, size or normalization", () => {
    const badHash = valid(); badHash.decoder.sha256 = "xyz";
    expect(() => parseManifest(badHash)).toThrow(/decoder\.sha256/);
    const badBytes = valid(); badBytes.encoder.bytes = 0;
    expect(() => parseManifest(badBytes)).toThrow(/encoder\.bytes/);
    const badStd = valid(); badStd.normalization.std = [0.2, 0, 0.2];
    expect(() => parseManifest(badStd)).toThrow(/normalization/);
    const noIo = { ...valid(), io: { ...valid().io, masks: "" } };
    expect(() => parseManifest(noIo)).toThrow(/io\.masks/);
  });

  it("the shipped model's manifest is valid", () => {
    expect(() => parseManifest(SAM_MODEL)).not.toThrow();
  });
});
