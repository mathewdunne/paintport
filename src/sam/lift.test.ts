import { describe, expect, it } from "vitest";
import { depthViewOf, gridBox, lookAtCamera, rasterizeDepth } from "../../test/support/depthRaster";
import type { EditableMesh } from "../doc/paintField";
import { VisibilityTest } from "../view/visibility";
import { EDGE_BAND, liftMask, projectToImage, triangleFrames } from "./lift";
import type { MaskField } from "./masks";
import type { ImageCamera } from "./types";

const SIZE = 64;

/** A triangle soup as a mesh; lifting needs no shared vertices. */
function soupMesh(soup: number[]): EditableMesh {
  return { vertices: Float64Array.from(soup), tris: Int32Array.from({ length: soup.length / 3 }, (_, i) => i), triCount: soup.length / 9 };
}

/** A field from a signed distance per pixel center (> 0 inside). */
function fieldOf(distance: (x: number, y: number) => number): MaskField {
  const values = Float32Array.from({ length: SIZE * SIZE }, (_, i) => distance((i % SIZE) + 0.5, Math.floor(i / SIZE) + 0.5));
  return { width: SIZE, height: SIZE, distance: values, depth: Math.max(0, ...values) };
}

/** A square 64 px view from `eye` toward the unit cube's center, with its depth-based visibility. */
function view(soup: number[], eye: [number, number, number]) {
  const camera = lookAtCamera(eye, [0.5, 0.5, 0.5], 1);
  const dv = depthViewOf(camera);
  const cam: ImageCamera = { ...dv, width: SIZE, height: SIZE };
  return { cam, visibility: new VisibilityTest(rasterizeDepth(soup, camera, SIZE, SIZE), dv) };
}

describe("triangleFrames", () => {
  it("gives world centroids and winding normals under the build transform", () => {
    const frames = triangleFrames(soupMesh([0, 0, 0, 1, 0, 0, 0, 1, 0]), "2 0 0 0 2 0 0 0 2 10 0 0");
    expect(frames.centroids[0]).toBeCloseTo(32 / 3);
    expect(frames.centroids[1]).toBeCloseTo(2 / 3);
    expect(frames.centroids[2]).toBe(0);
    expect(Array.from(frames.normals)).toEqual([0, 0, 4]);
  });
});

describe("projectToImage", () => {
  it("maps the view center to the image center, with x to the right and y down", () => {
    const { cam } = view(gridBox([0, 0, 0], [1, 1, 1]), [5, 0.5, 0.5]);
    const center = projectToImage(cam, 1, 0.5, 0.5)!;
    expect(center[0]).toBeCloseTo(32);
    expect(center[1]).toBeCloseTo(32);
    expect(projectToImage(cam, 1, 0.25, 0.5)![0]).toBeLessThan(32); // seen from +x, +y is to the right
    expect(projectToImage(cam, 1, 0.5, 0.75)![1]).toBeLessThan(32); // +z is up
    expect(projectToImage(cam, 6, 0.5, 0.5)).toBeNull(); // behind the camera
  });
});

describe("liftMask", () => {
  const soup = gridBox([0, 0, 0], [1, 1, 1], 4);
  const mesh = soupMesh(soup);
  const frames = triangleFrames(mesh, null);
  const { cam, visibility } = view(soup, [5, 0.5, 0.5]);
  const centroid = (t: number) => [frames.centroids[t * 3], frames.centroids[t * 3 + 1]];

  it("splits the visible triangles by the mask and leaves hidden ones out", () => {
    const split = liftMask(frames, new Uint8Array(mesh.triCount).fill(1), cam, visibility, fieldOf((x) => SIZE / 2 - x));
    expect(split.inside).toHaveLength(16); // the +x face has 32 triangles; the left half of the image is y < 0.5
    expect(split.outside).toHaveLength(16);
    for (const t of split.inside) {
      expect(centroid(t)[0]).toBeCloseTo(1);
      expect(centroid(t)[1]).toBeLessThan(0.5);
    }
    for (const t of split.outside) {
      expect(centroid(t)[0]).toBeCloseTo(1);
      expect(centroid(t)[1]).toBeGreaterThan(0.5);
    }
  });

  it("skips triangles that are not paintable", () => {
    const paintable = new Uint8Array(mesh.triCount);
    paintable.fill(1, 0, 8);
    const split = liftMask(frames, paintable, cam, visibility, fieldOf(() => 10));
    expect([...split.inside, ...split.outside].every((t) => t < 8)).toBe(true);
    expect(split.inside.length).toBeGreaterThan(0);
  });

  it("leaves triangles near the mask's edge to the race", () => {
    const all = new Uint8Array(mesh.triCount).fill(1);
    const { inside } = liftMask(frames, all, cam, visibility, fieldOf(() => 10));
    const t = inside[0];
    const edge = projectToImage(cam, frames.centroids[t * 3], frames.centroids[t * 3 + 1], frames.centroids[t * 3 + 2])![0];
    const split = liftMask(frames, all, cam, visibility, fieldOf((x) => edge + (EDGE_BAND * SIZE) / 2 - x));
    expect(split.inside).not.toContain(t);
    expect(split.outside).not.toContain(t);
    expect(split.inside.length + split.outside.length).toBeGreaterThan(16);
  });

  it("keeps the middle of a mask thinner than the edge band", () => {
    const split = liftMask(frames, new Uint8Array(mesh.triCount).fill(1), cam, visibility, fieldOf(() => (EDGE_BAND * SIZE) / 2));
    expect(split.inside).toHaveLength(32);
  });

  it("leaves faces seen at a grazing angle to the race", () => {
    const { cam: side, visibility: sideVisibility } = view(soup, [1.3, 5, 0.5]); // the +y face head-on, the +x face edge-on
    const split = liftMask(frames, new Uint8Array(mesh.triCount).fill(1), side, sideVisibility, fieldOf(() => 10));
    expect(split.inside.length).toBeGreaterThan(0);
    for (const t of split.inside) expect(frames.normals[t * 3 + 1]).toBeGreaterThan(0);
  });
});
