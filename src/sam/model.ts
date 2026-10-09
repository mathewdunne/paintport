// The model AI Paint uses (spec Q10.11), chosen in the spike (docs/plans/2026-10-09-ai-paint-spike.md).
// Bundled with the app so availability is known without a request; the weights are fetched
// from Hugging Face on first use (pinned commit, SHA-256 checked).
import { IMAGENET } from "./image";
import type { SamManifest } from "./manifest";

const REPO = `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx`;

export const SAM_MODEL: SamManifest = {
  id: "slimsam-77",
  name: "SlimSAM-77",
  license: "Apache-2.0",
  inputSize: 1024,
  normalization: IMAGENET,
  requiresF16: false,
  encoder: { url: `${REPO}/vision_encoder.onnx`, bytes: 23276014, sha256: "9f8433273a6750b587779baa0cf5508111001bf7e7acfcf585d370139fd366d0" },
  decoder: { url: `${REPO}/prompt_encoder_mask_decoder.onnx`, bytes: 16557892, sha256: "f4514391764fbd56e08e119060d874ecd7d52994bfb1968af159e12d4943b5bb" },
  runtimeBytes: 26781914,
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
