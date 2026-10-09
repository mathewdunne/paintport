# AI Paint spike report (2026-10-09), PARTIAL

Chrome-based Browser pane, WebGPU adapter with shader-f16. yoshi.3mf (about 200k triangles, unpainted, read in place).
onnxruntime-web 1.30.0 (MIT), WebGPU, numThreads 1. Model: slimsam-77 fp32 from Xenova/slimsam-77-uniform (`main`, unpinned in the spike).

## Measured (slimsam-77 fp32, look = design, white background)
| Step | Time |
|---|---|
| Weights fetch (both files) | 990 ms |
| Encoder session / decoder session | 1240 ms / 129 ms |
| Render | 32 ms |
| Encode, 1st run (shader compile) / 2nd run | 1394 ms / 441 ms |
| Decode (first click) | 1051 ms |
| liftMask (200k triangles) | 46 ms |
| Guided-fill race from the mask | 691 ms |

Encode is inside the 2 s bar.

## Results so far
- Eye dome, 1 click: SAM mask (score 0.886) outlines the eye cleanly, lifted to 4792 triangles through the race. Guided fill with the same single click (no outside click) gave 3292. Not a controlled comparison.
- Pupil highlight, shell, shell rim: not yet tried. Yoshi is unpainted, so SAM only sees shading; the user's painted or real design is the fairer test.

## Decisions / facts for later tasks
- IO names match the transformers.js layout: encoder `pixel_values` -> `image_embeddings`, `image_positional_embeddings`; decoder `input_points`, `input_labels`, `image_embeddings`, `image_positional_embeddings` -> `iou_scores`, `pred_masks`.
- ORT logs a warning that some shape ops run on CPU (expected).
- Main-thread stall during encode: not assessed.
- Go / no-go: pending the user. Still to run: other variants (fp16, quantized), looks (normals, clay, bend), the three remaining targets.
