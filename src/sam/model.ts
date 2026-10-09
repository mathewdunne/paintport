// The model AI Paint uses (spec Q10.11), chosen in the spike (docs/plans/2026-10-09-ai-paint-spike.md).
// Bundled with the app so availability is known without a request; the weights are fetched
// from Hugging Face on first use (pinned commit, SHA-256 checked).
import { IMAGENET } from "./image";
import type { SamManifest } from "./manifest";

const REPO = `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/${"0".repeat(40)}/onnx`;

export const SAM_MODEL: SamManifest = {
  id: "slimsam-77",
  name: "SlimSAM-77",
  license: "Apache-2.0",
  inputSize: 1024,
  normalization: IMAGENET,
  requiresF16: false,
  encoder: { url: `${REPO}/vision_encoder.onnx`, bytes: 1, sha256: "0".repeat(64) },
  decoder: { url: `${REPO}/prompt_encoder_mask_decoder.onnx`, bytes: 1, sha256: "0".repeat(64) },
  runtimeBytes: 1,
  io: {
    pixels: "pixel_values",
    embeddings: "image_embeddings",
    positional: "image_positional_embeddings",
    points: "input_points",
    labels: "input_labels",
    scores: "iou_scores",
    masks: "pred_masks",
  },
};
