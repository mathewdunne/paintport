// AI Paint spike: SAM on renders of a real model, compared with guided fill. Throwaway code.
// Open http://localhost:5180/spike/sam/?file=/@fs/D:/Downloads/yoshi.3mf
import * as ort from "onnxruntime-web/webgpu";
import {
  Color, DoubleSide, MeshLambertMaterial, MeshNormalMaterial, RGBAFormat, SRGBColorSpace, UnsignedByteType, WebGLRenderTarget,
  type Material, type PerspectiveCamera, type Scene, type WebGLRenderer,
} from "three";
import { featureBend } from "@/doc/featureField";
import { importProject } from "@/doc/importProject";
import { resolveTriangleState } from "@/doc/display";
import { fitLongSide, flipRows, toPixelValues } from "@/sam/image";
import { liftMask, projectToImage, triangleFrames } from "@/sam/lift";
import { cropToImage, maskCovers, rankCandidates } from "@/sam/masks";
import type { ImageCamera, SamImage, SamMask, SamPoint } from "@/sam/types";
import { MODEL_LAYER } from "@/view/depthPass";
import { ModelViewer } from "@/view/ModelViewer";
import { projectToScene } from "@/view/projectScene";
import type { VisibilityTest } from "@/view/visibility";

const INPUT = 1024;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logEl = $("log");
const log = (msg: string) => { logEl.textContent = `${msg}\n${logEl.textContent}`; console.log(msg); };
const time = async <T>(label: string, fn: () => Promise<T> | T): Promise<T> => {
  const t0 = performance.now();
  const r = await fn();
  log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
  return r;
};

ort.env.wasm.wasmPaths = "/node_modules/onnxruntime-web/dist/"; // same origin; the network log shows which file loads
ort.env.wasm.numThreads = 1; // as on GitHub Pages (not cross-origin isolated)

const file = new URLSearchParams(location.search).get("file");
if (!file) throw new Error("add ?file=/@fs/<path to a .3mf>");
const bytes = new Uint8Array(await (await fetch(file)).arrayBuffer());
const { project } = await time("import", () => importProject(file.split("/").pop()!, bytes));
const viewer = new ModelViewer($("view"));
const scene = projectToScene(project);
viewer.setScene(scene);
const v = viewer as unknown as { renderer: WebGLRenderer; scene: Scene; camera: PerspectiveCamera; container: HTMLElement; visibility(): VisibilityTest };
const OBJECT = 0;
const object = project.objects[OBJECT];
const frames = await time("triangleFrames", () => triangleFrames(object.mesh, object.transform));

let encoder: ort.InferenceSession | null = null, decoder: ort.InferenceSession | null = null, loaded = "";
let view: { image: SamImage; camera: ImageCamera; visibility: VisibilityTest; emb: Record<string, ort.Tensor> } | null = null;
let clicks: { tri: number; point: SamPoint }[] = [];
let masks: SamMask[] = [], candidate = 0;

/** Select value -> Hugging Face repo and file-name suffix. The spike reads `main`; the app pins a commit (Task 8). */
const VARIANTS: Record<string, { repo: string; suffix: string }> = {
  "slimsam-77": { repo: "Xenova/slimsam-77-uniform", suffix: "" },
  "slimsam-77-fp16": { repo: "Xenova/slimsam-77-uniform", suffix: "_fp16" },
  "slimsam-77-q": { repo: "Xenova/slimsam-77-uniform", suffix: "_quantized" },
  "slimsam-50": { repo: "Xenova/slimsam-50-uniform", suffix: "" },
  "slimsam-50-fp16": { repo: "Xenova/slimsam-50-uniform", suffix: "_fp16" },
  "slimsam-50-q": { repo: "Xenova/slimsam-50-uniform", suffix: "_quantized" },
};

async function ensureModel(): Promise<void> {
  const id = $<HTMLSelectElement>("model").value;
  if (id === loaded) return;
  const { repo, suffix } = VARIANTS[id];
  const url = (name: string) => `https://huggingface.co/${repo}/resolve/main/onnx/${name}${suffix}.onnx`;
  const [enc, dec] = await time(`${id} fetch`, () => Promise.all(["vision_encoder", "prompt_encoder_mask_decoder"].map(async (f) => new Uint8Array(await (await fetch(url(f))).arrayBuffer()))));
  encoder = await time(`${id} encoder session`, () => ort.InferenceSession.create(enc, { executionProviders: ["webgpu"] }));
  decoder = await time(`${id} decoder session`, () => ort.InferenceSession.create(dec, { executionProviders: ["webgpu"] }));
  log(`encoder ${encoder.inputNames} -> ${encoder.outputNames}; decoder ${decoder.inputNames} -> ${decoder.outputNames}`);
  loaded = id;
}

const looks: Record<string, Material | null> = {
  design: null,
  normals: new MeshNormalMaterial({ flatShading: true, side: DoubleSide }),
  clay: new MeshLambertMaterial({ color: 0xd8d8d8, flatShading: true, side: DoubleSide }),
  bend: null,
};

/** The bend look: each triangle's feature bend as gray, through the viewer's own color table. */
function withBendColors<T>(fn: () => T): T {
  const scale = project.autoFeatureScale(OBJECT);
  const bend = featureBend(project.topology(OBJECT), scale);
  const states = scene.objects[OBJECT].states, saved = states.slice();
  const ramp = ["#000000", ...Array.from({ length: 255 }, (_, i) => `#${Math.round((i / 254) * 255).toString(16).padStart(2, "0").repeat(3)}`)];
  for (let t = 0; t < states.length; t++) states[t] = 1 + Math.min(254, Math.round(((bend?.[t] ?? 0) / 0.6) * 254));
  viewer.refreshStates();
  viewer.setPalette(ramp);
  try { return fn(); } finally {
    states.set(saved);
    viewer.refreshStates();
    viewer.setPalette(scene.palette);
  }
}

function render(): { image: SamImage; camera: ImageCamera; visibility: VisibilityTest } {
  const { renderer, camera, container } = v;
  viewer.setRegionHighlight(OBJECT, null);
  camera.updateMatrixWorld(true);
  const { width, height } = fitLongSide(container.clientWidth, container.clientHeight, INPUT);
  const look = $<HTMLSelectElement>("look").value;
  const draw = () => {
    const target = new WebGLRenderTarget(width, height, { type: UnsignedByteType, format: RGBAFormat, colorSpace: SRGBColorSpace });
    const pixels = new Uint8Array(width * height * 4);
    const clear = new Color(); renderer.getClearColor(clear);
    const alpha = renderer.getClearAlpha(), mask = camera.layers.mask, override = v.scene.overrideMaterial;
    try {
      v.scene.overrideMaterial = looks[look];
      camera.layers.set(MODEL_LAYER);
      renderer.setRenderTarget(target);
      renderer.setClearColor(new Color(`#${$<HTMLSelectElement>("bg").value}`), 1);
      renderer.clear();
      renderer.render(v.scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      v.scene.overrideMaterial = override; camera.layers.mask = mask;
      renderer.setRenderTarget(null); renderer.setClearColor(clear, alpha); target.dispose();
    }
    return flipRows(pixels, width, height);
  };
  const image = look === "bend" ? withBendColors(draw) : draw();
  const p = camera.position;
  return {
    image,
    camera: { view: Array.from(camera.matrixWorldInverse.elements), proj: Array.from(camera.projectionMatrix.elements), eye: [p.x, p.y, p.z], width, height },
    visibility: v.visibility(),
  };
}

$("encode").onclick = async () => {
  await ensureModel();
  const r = await time("render", render);
  const pixels = new ort.Tensor("float32", toPixelValues(r.image, INPUT), [1, 3, INPUT, INPUT]);
  const emb = await time("encode (1st run includes shader compile)", () => encoder!.run({ [encoder!.inputNames[0]]: pixels }));
  await time("encode (2nd run)", () => encoder!.run({ [encoder!.inputNames[0]]: pixels }));
  view = { ...r, emb };
  clicks = []; masks = [];
  draw();
};

v.container.addEventListener("pointerdown", async (e) => {
  if (e.button !== 0 || e.altKey || !view) return;
  const hit = viewer.pick(e.clientX, e.clientY);
  if (!hit || hit.object !== OBJECT) return;
  const q = projectToImage(view.camera, ...hit.point)!;
  clicks.push({ tri: hit.tri, point: { x: q[0], y: q[1], positive: !e.shiftKey } });
  await decode();
});

async function decode(): Promise<void> {
  if (!view || !decoder) return;
  const n = clicks.length;
  const coords = new Float32Array(n * 2), labels = new BigInt64Array(n);
  clicks.forEach((c, i) => { coords[i * 2] = c.point.x; coords[i * 2 + 1] = c.point.y; labels[i] = c.point.positive ? 1n : 0n; });
  const feeds: Record<string, ort.Tensor> = {
    input_points: new ort.Tensor("float32", coords, [1, 1, n, 2]),
    input_labels: new ort.Tensor("int64", labels, [1, 1, n]),
    ...view.emb,
  };
  const out = await time("decode", () => decoder!.run(feeds));
  const data = out.pred_masks.data as Float32Array, grid = out.pred_masks.dims[4], k = out.pred_masks.dims[2];
  const scores = out.iou_scores.data as Float32Array;
  masks = rankCandidates(Array.from({ length: k }, (_, i) => cropToImage(data.subarray(i * grid * grid, (i + 1) * grid * grid), grid, INPUT, view!.image, scores[i])));
  candidate = 0;
  log(`scores ${masks.map((m) => m.score.toFixed(3)).join(" ")}`);
  apply();
}

function apply(): void {
  if (!view || masks.length === 0) return;
  const mask = masks[candidate];
  const split = liftMaskTimed(mask);
  const first = clicks.find((c) => c.point.positive);
  if (!first) return;
  const state = resolveTriangleState(project, OBJECT, first.tri);
  const shown = (t: number) => resolveTriangleState(project, OBJECT, t);
  const inside = Array.from(split.inside).filter((t) => shown(t) === state);
  const t0 = performance.now();
  const region = project.guidedFillRegion(OBJECT, inside, Array.from(split.outside), 20, project.autoFeatureScale(OBJECT));
  log(`lift ${split.inside.length} in / ${split.outside.length} out; race ${(performance.now() - t0).toFixed(0)} ms -> ${region.length} triangles`);
  viewer.setRegionHighlight(OBJECT, region);
  draw();
}

function liftMaskTimed(mask: SamMask) {
  const t0 = performance.now();
  const split = liftMask(frames, object.paintable, view!.camera, view!.visibility, (x, y) => maskCovers(mask, view!.camera, x, y));
  log(`liftMask ${(performance.now() - t0).toFixed(0)} ms`);
  return split;
}

$("cand").onclick = () => { if (masks.length) { candidate = (candidate + 1) % masks.length; apply(); } };
$("reset").onclick = () => { clicks = []; masks = []; viewer.setRegionHighlight(OBJECT, null); draw(); };
$("guided").onclick = () => {
  const t0 = performance.now();
  const region = project.guidedFillRegion(OBJECT, clicks.filter((c) => c.point.positive).map((c) => c.tri), clicks.filter((c) => !c.point.positive).map((c) => c.tri), 20, project.autoFeatureScale(OBJECT));
  log(`guided fill ${(performance.now() - t0).toFixed(0)} ms -> ${region.length} triangles`);
  viewer.setRegionHighlight(OBJECT, region);
};
$("save").onclick = () => {
  const a = document.createElement("a");
  a.download = "sam-view.png";
  a.href = $<HTMLCanvasElement>("sam").toDataURL("image/png");
  a.click();
};

/** The SAM image with the current mask tinted and the clicks as dots. */
function draw(): void {
  const canvas = $<HTMLCanvasElement>("sam");
  if (!view) return;
  const { image } = view;
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext("2d")!;
  const img = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  const mask = masks[candidate];
  if (mask) for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (!maskCovers(mask, image, x + 0.5, y + 0.5)) continue;
    const o = (y * image.width + x) * 4;
    img.data[o] = (img.data[o] + 255) / 2; img.data[o + 1] /= 2; img.data[o + 2] /= 2;
  }
  ctx.putImageData(img, 0, 0);
  for (const c of clicks) {
    ctx.fillStyle = c.point.positive ? "#2a2" : "#d22";
    ctx.beginPath(); ctx.arc(c.point.x, c.point.y, 8, 0, Math.PI * 2); ctx.fill();
  }
}
