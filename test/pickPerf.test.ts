// Picking and visibility cost on a ~1.3M-triangle mesh, in Node (the browser numbers are in the PR notes).
// Opt-in: PERF=1 npx vitest run test/pickPerf.test.ts
import { BufferAttribute, BufferGeometry, Ray, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { ObjectPicker, TriangleList } from "../src/view/picking";
import { VisibilityTest } from "../src/view/visibility";
import { depthViewOf, lookAtCamera, rasterizeDepth } from "./support/depthRaster";

const RINGS = 651, SEGMENTS = 1000, RADIUS = 50; // 2 * 1000 * 650 = 1.3M triangles

function sphere(): Float32Array {
  const pt = (r: number, s: number): [number, number, number] => {
    const phi = (Math.PI * r) / RINGS, theta = (2 * Math.PI * (s % SEGMENTS)) / SEGMENTS;
    return [RADIUS * Math.sin(phi) * Math.cos(theta), RADIUS * Math.sin(phi) * Math.sin(theta), RADIUS * Math.cos(phi)];
  };
  const out = new Float32Array(2 * SEGMENTS * (RINGS - 1) * 9);
  let o = 0;
  const put = (...ps: [number, number, number][]) => { for (const p of ps) { out[o++] = p[0]; out[o++] = p[1]; out[o++] = p[2]; } };
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = pt(r, s), b = pt(r, s + 1), c = pt(r + 1, s), d = pt(r + 1, s + 1);
      if (r > 0) put(a, c, b);
      if (r < RINGS - 1) put(b, c, d);
    }
  }
  return out;
}

describe.skipIf(!process.env.PERF)("picking on a 1.3M-triangle object", () => {
  it("builds the index quickly and answers ray and brush queries in well under a frame", () => {
    const time = <T>(label: string, fn: () => T): T => {
      const t0 = performance.now();
      const r = fn();
      console.log(`${label}: ${(performance.now() - t0).toFixed(2)} ms`);
      return r;
    };
    const soup = time("generate soup", sphere);
    const n = soup.length / 9;
    expect(n).toBe(1_300_000);
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(soup, 3));
    const picker = time("BVH build", () => new ObjectPicker(g, Int32Array.from({ length: n }, (_, i) => i), n));

    const eye = new Vector3(0, -300, 0);
    const hit = time("raycast x1000", () => { let h; for (let i = 0; i < 1000; i++) h = picker.raycast(new Ray(eye, new Vector3((i % 40) - 20, 300, 0).normalize())); return h; })!;
    expect(hit).not.toBeNull();

    const camera = lookAtCamera([0, -300, 0], [0, 0, 0], 640 / 480);
    const frame = time("CPU depth raster 640x480 (stands in for the GPU pass)", () => rasterizeDepth(soup, camera, 640, 480));
    const vis = new VisibilityTest(frame, depthViewOf(camera));
    const list = new TriangleList();
    for (const radius of [1, 3, 8, 20]) {
      const center = new Vector3(0, -RADIUS, 0);
      const runs = 50;
      const t0 = performance.now();
      for (let i = 0; i < runs; i++) { list.clear(); picker.collectSphere(center, radius, null, -1, list); }
      const through = (performance.now() - t0) / runs;
      const count = list.length;
      const t1 = performance.now();
      for (let i = 0; i < runs; i++) { list.clear(); picker.collectSphere(center, radius, vis, -1, list); }
      const visible = (performance.now() - t1) / runs;
      console.log(`brush radius ${radius}: ${count} candidates, ${through.toFixed(2)} ms paint-through, ${visible.toFixed(2)} ms visible-only (${list.length} kept)`);
      expect(visible).toBeLessThan(40);
    }
  }, 300000);
});
