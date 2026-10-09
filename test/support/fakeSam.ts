// Stand-ins for AI Paint's model and the viewer's capture, so the tool logic runs in Node.
import type { SamEmbedding, SamImage, SamMask, SamPoint, Segmenter } from "../../src/sam/types";
import type { SamCapture } from "../../src/tools/types";
import { VisibilityTest } from "../../src/view/visibility";
import { depthViewOf, lookAtCamera, rasterizeDepth } from "./depthRaster";
import type { MeshSpec } from "./docFixtures";

/** Side of the fake captures and the fake model's input. */
export const CAPTURE_SIZE = 64;

/** Lets pending promise callbacks run (the fake model answers asynchronously). */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A triangle soup as a mesh with shared vertices, so fills can cross edges. */
export function weldSoup(soup: ArrayLike<number>): MeshSpec {
  const index = new Map<string, number>(), vertices: number[] = [], tris: number[] = [];
  for (let i = 0; i < soup.length; i += 3) {
    const key = `${soup[i]},${soup[i + 1]},${soup[i + 2]}`;
    let v = index.get(key);
    if (v === undefined) {
      v = vertices.length / 3;
      index.set(key, v);
      vertices.push(soup[i], soup[i + 1], soup[i + 2]);
    }
    tris.push(v);
  }
  return { vertices, tris };
}

/** A mesh's triangles as 9 numbers each. */
export function soupOf(mesh: { vertices: ArrayLike<number>; tris: ArrayLike<number> }): number[] {
  const out: number[] = [];
  for (let i = 0; i < mesh.tris.length; i++) {
    const v = mesh.tris[i] * 3;
    out.push(mesh.vertices[v], mesh.vertices[v + 1], mesh.vertices[v + 2]);
  }
  return out;
}

/** What the viewer captures looking from `eye` at `target`: a 64 px square view (the image is blank). */
export function captureFor(
  mesh: { vertices: ArrayLike<number>; tris: ArrayLike<number> }, eye: [number, number, number], target: [number, number, number] = [0.5, 0.5, 0.5],
): SamCapture & { renders: number } {
  const camera = lookAtCamera(eye, target, 1);
  const dv = depthViewOf(camera);
  const capture = {
    key: `eye ${eye.join(",")}`,
    camera: { ...dv, width: CAPTURE_SIZE, height: CAPTURE_SIZE },
    visibility: new VisibilityTest(rasterizeDepth(soupOf(mesh), camera, CAPTURE_SIZE, CAPTURE_SIZE), dv),
    renders: 0,
    render(): SamImage {
      capture.renders++;
      return { width: CAPTURE_SIZE, height: CAPTURE_SIZE, data: new Uint8Array(CAPTURE_SIZE * CAPTURE_SIZE * 4) };
    },
  };
  return capture;
}

/** A candidate mask as a logit per image position (x, y in pixels). */
export interface FakeCandidate {
  score: number;
  logit: (x: number, y: number) => number;
}

/** A segmenter whose candidate masks are fixed functions of the image position, on a grid of 4 px cells. */
export class FakeSegmenter implements Segmenter {
  readonly inputSize = CAPTURE_SIZE;
  encodes = 0;
  readonly decodes: SamPoint[][] = [];
  disposedEmbeddings = 0;
  /** Decodes wait until `release()`. */
  hold = false;
  /** Decodes fail. */
  fail = false;
  private held: (() => void)[] = [];

  constructor(public candidates: FakeCandidate[]) {}

  async encode(image: SamImage): Promise<SamEmbedding> {
    this.encodes++;
    return { width: image.width, height: image.height, dispose: () => { this.disposedEmbeddings++; } };
  }

  async decode(embedding: SamEmbedding, points: readonly SamPoint[]): Promise<SamMask[]> {
    this.decodes.push([...points]);
    if (this.hold) await new Promise<void>((resolve) => this.held.push(resolve));
    if (this.fail) throw new Error("decode failed");
    const cell = 4, width = embedding.width / cell, height = embedding.height / cell;
    return this.candidates.map(({ score, logit }) => {
      const logits = new Float32Array(width * height);
      for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) logits[j * width + i] = logit((i + 0.5) * cell, (j + 0.5) * cell);
      return { width, height, logits, score };
    });
  }

  release(): void {
    for (const resolve of this.held.splice(0)) resolve();
  }

  dispose(): void {}
}
