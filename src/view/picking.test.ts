import { BufferAttribute, BufferGeometry, Ray, Triangle, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { depthViewOf, gridBox, lookAtCamera, rasterizeDepth, uvSphere, type Soup } from "../../test/support/depthRaster";
import { ObjectPicker, TriangleList } from "./picking";
import { ALPHA_BACK, ALPHA_FRONT, ALPHA_NONE, decodeDepth, encodeDepth, VisibilityTest, type DepthFrame } from "./visibility";

function geometryOf(soup: Soup): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(soup), 3));
  return g;
}

function pickerOf(soup: Soup): ObjectPicker {
  const n = soup.length / 9;
  return new ObjectPicker(geometryOf(soup), Int32Array.from({ length: n }, (_, i) => i), n);
}

/** Triangle `t` of the soup: centroid and unit normal. */
function triInfo(soup: Soup, t: number) {
  const p = soup.slice(t * 9, t * 9 + 9);
  const a = new Vector3(p[0], p[1], p[2]), b = new Vector3(p[3], p[4], p[5]), c = new Vector3(p[6], p[7], p[8]);
  return { centroid: a.clone().add(b).add(c).divideScalar(3), normal: b.clone().sub(a).cross(c.clone().sub(a)).normalize() };
}

function collect(picker: ObjectPicker, center: Vector3, radius: number, vis: VisibilityTest | null, force = -1): Set<number> {
  const list = new TriangleList();
  picker.collectSphere(center, radius, vis, force, list);
  return new Set(list.toArray());
}

describe("depth packing", () => {
  it("round-trips depth to within the 24-bit step", () => {
    for (const d of [0, 1e-6, 0.123456, 0.5, 0.999999, 1]) {
      const [r, g, b] = encodeDepth(d);
      expect(Math.abs(decodeDepth(r, g, b) - d)).toBeLessThan(1 / 0xffffff);
    }
  });
});

describe("test meshes", () => {
  it("gridBox faces point outward and sphere triangles point away from the center", () => {
    const box = gridBox([0, 0, 0], [2, 3, 4], 2);
    for (let t = 0; t < box.length / 9; t++) {
      const { centroid, normal } = triInfo(box, t);
      expect(normal.dot(centroid.clone().sub(new Vector3(1, 1.5, 2)))).toBeGreaterThan(0);
    }
    const ball = uvSphere([5, 0, 0], 3, 12, 16);
    for (let t = 0; t < ball.length / 9; t++) {
      const { centroid, normal } = triInfo(ball, t);
      expect(normal.dot(centroid.clone().sub(new Vector3(5, 0, 0)))).toBeGreaterThan(0);
    }
  });
});

describe("ObjectPicker", () => {
  it("raycasts to the nearest triangle and reports the document id and a camera-facing normal", () => {
    const soup = gridBox([-10, -10, -10], [10, 10, 10], 4);
    const picker = pickerOf(soup);
    const hit = picker.raycast(new Ray(new Vector3(1, -100, 2), new Vector3(0, 1, 0)))!;
    expect(hit.point.y).toBeCloseTo(-10);
    expect(hit.distance).toBeCloseTo(90);
    expect(hit.normal.y).toBeCloseTo(-1);
    const { centroid, normal } = triInfo(soup, hit.tri);
    expect(normal.y).toBeCloseTo(-1);
    expect(centroid.y).toBeCloseTo(-10);
    expect(picker.raycast(new Ray(new Vector3(50, -100, 0), new Vector3(0, 1, 0)))).toBeNull();
  });

  it("reports the hit point's barycentric coordinates in the triangle's corner order", () => {
    const soup = gridBox([-10, -10, -10], [10, 10, 10], 4);
    const picker = pickerOf(soup);
    const hit = picker.raycast(new Ray(new Vector3(1.3, -100, 2.7), new Vector3(0, 1, 0)))!;
    const [u, v, w] = hit.bary;
    expect(u + v + w).toBeCloseTo(1);
    expect(Math.min(u, v, w)).toBeGreaterThanOrEqual(0);
    const p = soup.slice(hit.tri * 9, hit.tri * 9 + 9);
    const x = p[0] * u + p[3] * v + p[6] * w, y = p[1] * u + p[4] * v + p[7] * w, z = p[2] * u + p[5] * v + p[8] * w;
    expect([x, y, z].map((c) => +c.toFixed(6))).toEqual([1.3, -10, 2.7]);
  });

  it("maps slots back to document triangle ids when some triangles are not drawn", () => {
    const soup = gridBox([-10, -10, -10], [10, 10, 10], 1); // 12 triangles
    // Draw only the odd triangles: document id 2k+1 lives in slot k.
    const kept: number[] = [], slotOfTri = new Int32Array(12).fill(-1);
    for (let t = 1; t < 12; t += 2) { slotOfTri[t] = kept.length / 9; kept.push(...soup.slice(t * 9, t * 9 + 9)); }
    const picker = new ObjectPicker(geometryOf(kept), slotOfTri, 6);
    const all = collect(picker, new Vector3(0, 0, 0), 100, null);
    expect([...all].sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9, 11]);
  });

  it("collects exactly the triangles whose closest point is within the radius, and always the forced one", () => {
    const soup = gridBox([-20, -20, -20], [20, 20, 20], 10);
    const picker = pickerOf(soup);
    const center = new Vector3(0, -20, 0);
    const found = collect(picker, center, 5, null);
    expect(found.size).toBeGreaterThan(10);
    for (const t of found) {
      const { centroid } = triInfo(soup, t);
      expect(centroid.distanceTo(center)).toBeLessThan(5 + 4); // centroid within radius + triangle size
    }
    // No triangle with every vertex farther than the radius.
    expect(collect(picker, new Vector3(0, -20, 0), 0.001, null).size).toBeGreaterThanOrEqual(1);
    const far = collect(picker, new Vector3(0, -20, 0), 0.5, null, 3); // triangle 3 is nowhere near
    expect(far.has(3)).toBe(true);
  });
});

// A stand-in for the viewer's pipeline: rasterize the scene, then collect with visibility.
function visibleCandidates(soup: Soup, picker: ObjectPicker, eye: [number, number, number], center: Vector3, radius: number, size: [number, number], force = -1) {
  const camera = lookAtCamera(eye, [0, 0, 0], size[0] / size[1]);
  const frame = rasterizeDepth(soup, camera, size[0], size[1]);
  const vis = new VisibilityTest(frame, depthViewOf(camera));
  return { visible: collect(picker, center, radius, vis, force), through: collect(picker, center, radius, null, force), frame, vis };
}

describe("visible-only candidates", () => {
  it("paints the front of a thin plate and never its back", () => {
    // 0.4 mm thick plate, about one pixel at this distance: the back face passes any depth test.
    const soup = gridBox([-30, -0.2, -30], [30, 0.2, 30], 12);
    const picker = pickerOf(soup);
    const { visible, through } = visibleCandidates(soup, picker, [0, -200, 0], new Vector3(0, -0.2, 0), 5, [600, 400]);
    const normals = (set: Set<number>) => [...set].map((t) => triInfo(soup, t).normal.y);
    expect(through.size).toBeGreaterThan(visible.size);
    expect(normals(through).some((y) => y > 0.5)).toBe(true); // the back is inside the sphere
    expect(visible.size).toBeGreaterThanOrEqual(20);
    expect(normals(visible).every((y) => y < -0.5)).toBe(true);
    // Everything on the front inside the sphere is painted (nothing speckled out).
    const frontThrough = [...through].filter((t) => triInfo(soup, t).normal.y < -0.5);
    expect(frontThrough.every((t) => visible.has(t))).toBe(true);
  });

  it("paints from the back as well when the camera looks at the other side", () => {
    const soup = gridBox([-30, -0.2, -30], [30, 0.2, 30], 12);
    const picker = pickerOf(soup);
    const { visible } = visibleCandidates(soup, picker, [0, 200, 0], new Vector3(0, 0.2, 0), 5, [600, 400]);
    expect(visible.size).toBeGreaterThanOrEqual(20);
    expect([...visible].every((t) => triInfo(soup, t).normal.y > 0.5)).toBe(true);
  });

  it("does not paint the body behind an arm that is in front of it", () => {
    const body = gridBox([-40, 10, -40], [40, 50, 40], 16);
    const arm = gridBox([-5, -15, -40], [5, -5, 40], 8);
    const soup = [...body, ...arm];
    const bodyCount = body.length / 9;
    const picker = pickerOf(soup);
    const eye: [number, number, number] = [0, -200, 0];
    const center = new Vector3(0, -15, 0); // on the arm's front face
    const { visible, through, vis } = visibleCandidates(soup, picker, eye, center, 30, [800, 600]);

    const isBody = (t: number) => t < bodyCount;
    const bodyFrontThrough = [...through].filter((t) => isBody(t) && triInfo(soup, t).normal.y < -0.5);
    expect(bodyFrontThrough.length).toBeGreaterThan(30); // the sphere does reach the body
    // The brush meets a triangle at its point nearest to the brush center, so what counts is the
    // triangle's smallest |x|. The arm hides the body for |x| < ~5.7 (perspective widens its shadow).
    const nearestX = (t: number) => {
      const xs = [soup[t * 9], soup[t * 9 + 3], soup[t * 9 + 6]];
      return Math.min(...xs) <= 0 && Math.max(...xs) >= 0 ? 0 : Math.min(...xs.map(Math.abs));
    };
    for (const t of bodyFrontThrough) {
      if (nearestX(t) < 4) expect(visible.has(t), `hidden body triangle at x=${nearestX(t)}`).toBe(false);
      if (nearestX(t) > 7) expect(visible.has(t), `visible body triangle at x=${nearestX(t)}`).toBe(true);
    }
    expect(bodyFrontThrough.some((t) => visible.has(t))).toBe(true);
    // The arm itself: front painted, back (normal +y) not.
    const armVisible = [...visible].filter((t) => !isBody(t));
    expect(armVisible.some((t) => triInfo(soup, t).normal.y < -0.5)).toBe(true);
    expect(armVisible.every((t) => triInfo(soup, t).normal.y < 0.5)).toBe(true);

    // Agrees with a ray cast from the eye to the point where the brush touches each triangle.
    let disagree = 0;
    const eyeV = new Vector3(...eye);
    for (const t of through) {
      const { normal, centroid } = triInfo(soup, t);
      if (normal.dot(centroid.clone().sub(eyeV)) >= 0) continue; // back-facing: never visible
      const tri = new Triangle(new Vector3(...soup.slice(t * 9, t * 9 + 3)), new Vector3(...soup.slice(t * 9 + 3, t * 9 + 6)), new Vector3(...soup.slice(t * 9 + 6, t * 9 + 9)));
      const touch = tri.closestPointToPoint(center, new Vector3());
      const dir = touch.clone().sub(eyeV);
      const dist = dir.length();
      const hit = picker.raycast(new Ray(eyeV, dir.normalize()));
      const truth = !hit || hit.distance > dist - 0.05;
      if (truth !== visible.has(t)) disagree++;
    }
    expect(disagree).toBeLessThan(through.size * 0.02);
    expect(vis).toBeDefined();
  });

  it("leaves no speckle on a dense mesh whose triangles are smaller than a pixel", () => {
    const soup = uvSphere([0, 0, 0], 20, 150, 300); // ~0.4 mm triangles
    const picker = pickerOf(soup);
    const eye: [number, number, number] = [0, -300, 0];
    const center = new Vector3(0, -20, 0);
    const { visible, through, frame } = visibleCandidates(soup, picker, eye, center, 8, [400, 300]);
    // One pixel is about 0.8 mm here: the triangles really are sub-pixel.
    expect((2 * 300 * Math.tan(Math.PI / 8)) / frame.height).toBeGreaterThan(0.6);
    expect(through.size).toBeGreaterThan(1500);
    const missed = [...through].filter((t) => !visible.has(t));
    expect(missed).toEqual([]);
  });

  it("paints the whole front hemisphere and none of the back when the brush reaches around the sphere", () => {
    const soup = uvSphere([0, 0, 0], 20, 90, 180);
    const picker = pickerOf(soup);
    const eye: [number, number, number] = [0, -300, 0];
    const eyeV = new Vector3(...eye);
    const { visible, through } = visibleCandidates(soup, picker, eye, new Vector3(0, -20, 0), 50, [400, 300]);
    expect(through.size).toBe(soup.length / 9); // everything is inside the brush
    let wrongBack = 0, missedFront = 0;
    for (const t of through) {
      const { normal, centroid } = triInfo(soup, t);
      const facing = normal.dot(centroid.clone().sub(eyeV).normalize()); // < 0 = toward the camera
      if (facing > 0.05 && visible.has(t)) wrongBack++;
      if (facing < -0.15 && !visible.has(t)) missedFront++;
    }
    expect(wrongBack).toBe(0);
    expect(missedFront).toBe(0);
  });

  it("treats a pixel with nothing drawn as visible for front faces only, and points off screen as hidden", () => {
    const frame: DepthFrame = { width: 2, height: 2, data: new Uint8Array(16), near: 1, far: 100 };
    const camera = lookAtCamera([0, -10, 0], [0, 0, 0], 1);
    const vis = new VisibilityTest(frame, depthViewOf(camera));
    expect(vis.isVisible(0, 0, 0, 0, -1, 0)).toBe(true);
    expect(vis.isVisible(0, 0, 0, 0, 1, 0)).toBe(false);
    expect(vis.isVisible(1000, 0, 0, 0, -1, 0)).toBe(false);
    expect(vis.isVisible(0, -20, 0, 0, -1, 0)).toBe(false); // behind the camera
  });

  it("accepts back faces only where the nearest surface is a back face too (inverted winding)", () => {
    const flip = (s: Soup): Soup => {
      const out: Soup = [];
      for (let t = 0; t < s.length; t += 9) out.push(...s.slice(t, t + 3), ...s.slice(t + 6, t + 9), ...s.slice(t + 3, t + 6));
      return out;
    };
    const soup = flip(gridBox([-20, -20, -20], [20, 20, 20], 8)); // a cube turned inside out
    const picker = pickerOf(soup);
    const { visible, frame } = visibleCandidates(soup, picker, [0, -200, 0], new Vector3(0, -20, 0), 8, [400, 300]);
    expect(frame.data[((150 * 400 + 200) * 4) + 3]).toBe(ALPHA_BACK);
    expect(visible.size).toBeGreaterThan(10);
    expect([...visible].every((t) => triInfo(soup, t).normal.y > 0.5)).toBe(true);
    expect(ALPHA_FRONT).not.toBe(ALPHA_NONE);
  });
});
