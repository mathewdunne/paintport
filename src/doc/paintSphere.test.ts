import { describe, expect, it } from "vitest";
import { cubeMesh, leaf, makeModel, split2, tree, type MeshSpec } from "../../test/support/docFixtures";
import { makeRng } from "../../test/support/prng";
import { createProject, type Project } from "./project";
import { sqDistPointTriangle } from "./triangleMath";
import { TrianglePaintField } from "./trianglePaintField";

/** One big triangle in the z = 0 plane: right angle at the origin, legs of length 10. */
const BIG: MeshSpec = { vertices: [0, 0, 0, 10, 0, 0, 0, 10, 0], tris: [0, 1, 2] };

function projectOf(mesh: MeshSpec, extra: Parameters<typeof makeModel>[1] = {}): Project {
  const p = createProject(makeModel(mesh, extra));
  p.addColor("#336699"); // state 2 (state 1 is the base color)
  return p;
}

const hit = (p: Project, center: [number, number, number], radius: number, opts?: { candidates?: number[] }): number =>
  p.paintSphere(0, center, radius, 2, opts);

describe("paintSphere", () => {
  it("hits a triangle much larger than the sphere when the sphere touches its face", () => {
    // Every vertex is more than 4 away from the center, so a vertex test would miss it.
    expect(hit(projectOf(BIG), [3, 3, 0.5], 1)).toBe(1);
    expect(hit(projectOf(BIG), [3, 3, 1.5], 1)).toBe(0); // hovering above the face
    expect(hit(projectOf(BIG), [3, 3, 1], 1)).toBe(1); // exactly touching counts
    expect(hit(projectOf(BIG), [3, 3, -0.9], 1)).toBe(1); // below the face works the same
  });

  it("decides near an edge by the distance to that edge", () => {
    expect(hit(projectOf(BIG), [5, -0.5, 0], 0.6)).toBe(1);
    expect(hit(projectOf(BIG), [5, -0.5, 0], 0.4)).toBe(0);
    expect(hit(projectOf(BIG), [6, 6, 0], 1.42)).toBe(1); // hypotenuse: distance 1.4142
    expect(hit(projectOf(BIG), [6, 6, 0], 1.41)).toBe(0);
  });

  it("decides near a vertex by the distance to that vertex", () => {
    expect(hit(projectOf(BIG), [-0.5, -0.5, 0], 0.71)).toBe(1); // distance 0.7071 to the origin
    expect(hit(projectOf(BIG), [-0.5, -0.5, 0], 0.7)).toBe(0);
    expect(hit(projectOf(BIG), [10.5, 0.5, 0], 0.71)).toBe(1); // near the vertex (10, 0, 0): distance 0.7071
    expect(hit(projectOf(BIG), [10.5, 0.5, 0], 0.7)).toBe(0);
  });

  it("agrees with an independent distance computation on random spheres and triangles", () => {
    const rng = makeRng(7, "sphere-vs-reference");
    const dist2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    // Reference: the closest of (projection onto the plane, if inside) and the three edges, by sampling-free formulas.
    function reference(p: number[], a: number[], b: number[], c: number[]): number {
      const seg = (u: number[], v: number[]) => {
        const d = v.map((x, i) => x - u[i]);
        const t = Math.max(0, Math.min(1, d.reduce((s, x, i) => s + x * (p[i] - u[i]), 0) / d.reduce((s, x) => s + x * x, 0)));
        return dist2(p, u.map((x, i) => x + t * d[i]));
      };
      let best = Math.min(seg(a, b), seg(b, c), seg(c, a));
      const e1 = b.map((x, i) => x - a[i]), e2 = c.map((x, i) => x - a[i]), w = p.map((x, i) => x - a[i]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const nn = n.reduce((s, x) => s + x * x, 0);
      const h = w.reduce((s, x, i) => s + x * n[i], 0) / nn;
      const q = w.map((x, i) => x - h * n[i]); // projection relative to a
      const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const s = dot(cross(q, e2), n) / nn, t = dot(cross(e1, q), n) / nn;
      if (s >= 0 && t >= 0 && s + t <= 1) best = Math.min(best, dist2(w, q));
      return best;
    }
    for (let i = 0; i < 400; i++) {
      const pt = () => [rng.next() * 10 - 5, rng.next() * 10 - 5, rng.next() * 10 - 5];
      const [a, b, c, p] = [pt(), pt(), pt(), pt()];
      const vertices = Float64Array.from([...a, ...b, ...c]);
      expect(sqDistPointTriangle(vertices, Int32Array.of(0, 1, 2), 0, p[0], p[1], p[2])).toBeCloseTo(reference(p, a, b, c), 9);
    }
  });

  it("handles degenerate triangles by their edges", () => {
    const line = Float64Array.from([0, 0, 0, 2, 0, 0, 1, 0, 0]);
    expect(sqDistPointTriangle(line, Int32Array.of(0, 1, 2), 0, 1, 3, 0)).toBeCloseTo(9);
    expect(sqDistPointTriangle(line, Int32Array.of(0, 1, 2), 0, 5, 0, 0)).toBeCloseTo(9);
    const point = Float64Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(sqDistPointTriangle(point, Int32Array.of(0, 1, 2), 0, 1, 1, 3)).toBeCloseTo(4);
  });

  it("paints exactly the triangles around a cube corner", () => {
    const mesh = cubeMesh();
    const p = projectOf(mesh);
    const corner = mesh.vertices.findIndex((_, i) => i % 3 === 0 && mesh.vertices[i] === 1 && mesh.vertices[i + 1] === 1 && mesh.vertices[i + 2] === 1) / 3;
    const expected: number[] = [];
    for (let t = 0; t < 12; t++) if ([0, 1, 2].some((k) => mesh.tris[t * 3 + k] === corner)) expected.push(t);
    expect(expected.length).toBeGreaterThan(3);
    expect(hit(p, [1.05, 1.05, 1.05], 0.1)).toBe(expected.length);
    const field = p.fields[0] as TrianglePaintField;
    expect(Array.from(field.states).flatMap((s, t) => (s === 2 ? [t] : []))).toEqual(expected);
  });

  it("tests only the candidates the caller passes", () => {
    const p = projectOf(cubeMesh());
    const field = p.fields[0] as TrianglePaintField;
    expect(hit(p, [0.5, 0.5, 0], 0.1, { candidates: [] })).toBe(0);
    expect(hit(p, [0.5, 0.5, 0], 0.1, { candidates: [4, 5] })).toBe(0); // those two are far away
    expect(hit(p, [0.5, 0.5, 0], 0.1, { candidates: [0, 1, 0] })).toBeGreaterThan(0); // a duplicate id is harmless
    const painted = Array.from(field.states).flatMap((s, t) => (s === 2 ? [t] : []));
    expect(painted.every((t) => t === 0 || t === 1)).toBe(true);
    // Without a list every paintable triangle is tested.
    const q = projectOf(cubeMesh());
    expect(hit(q, [0.5, 0.5, 0], 0.1)).toBe(painted.length);
  });

  it("never paints triangles that are not print surface, even when the caller lists them", () => {
    const p = projectOf(cubeMesh(), {
      parts: [
        { firstTri: 0, triCount: 6, extruder: 1, type: "ModelPart", name: null },
        { firstTri: 6, triCount: 6, extruder: 1, type: "NegativeVolume", name: null },
      ],
    });
    expect(p.paintSphere(0, [0.5, 0.5, 0.5], 5, 2, { candidates: Array.from({ length: 12 }, (_, i) => i) })).toBe(6);
    const field = p.fields[0] as TrianglePaintField;
    expect(Array.from(field.states.slice(6))).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("erases with state 0 and clears preserved detail it touches", () => {
    const p = createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }, { color: "#00FF00" }], paints: [tree(split2(1, 2)), leaf(2)] }));
    const field = p.fields[0] as TrianglePaintField;
    expect(field.preserved.size).toBe(1);
    expect(p.paintSphere(0, [0.5, 0.5, 0], 0.05, 0)).toBeGreaterThan(0);
    expect(field.preserved.size).toBe(0);
    expect(field.states[0]).toBe(0);
  });

  it("skips triangles whose state already matches without testing geometry, and reports no change", () => {
    const p = projectOf(cubeMesh());
    expect(hit(p, [0.5, 0.5, 0], 0.1)).toBeGreaterThan(0);
    const steps = p.undoCount;
    expect(hit(p, [0.5, 0.5, 0], 0.1)).toBe(0);
    expect(p.undoCount).toBe(steps);
  });

  it("paints candidates flagged exact without testing them again, and still tests unflagged ones", () => {
    const p = projectOf(BIG);
    // The sphere is nowhere near the triangle: tested, it misses; flagged exact, the caller's word is taken.
    expect(hit(p, [50, 50, 50], 1, { candidates: [0] })).toBe(0);
    expect(p.paintSphere(0, [50, 50, 50], 1, 2, { candidates: [0], candidatesExact: true })).toBe(1);
    const q = projectOf(BIG);
    expect(q.paintSphere(0, [50, 50, 50], 1, 2, { candidatesExact: true })).toBe(0); // no candidates: the flag is ignored
  });

  it("still skips non-paintable triangles and ids out of range when candidates are exact", () => {
    const mesh = cubeMesh();
    const p = projectOf(mesh, { parts: [{ firstTri: 0, triCount: 6, extruder: 1, type: "ModelPart", name: null }, { firstTri: 6, triCount: 6, extruder: 1, type: "NegativeVolume", name: null }] });
    expect(p.paintSphere(0, [0, 0, 0], 1, 2, { candidates: [0, 7, 99], candidatesExact: true })).toBe(1);
  });

  it("ignores impossible radii", () => {
    const p = projectOf(BIG);
    expect(hit(p, [3, 3, 0], -1)).toBe(0);
    expect(hit(p, [3, 3, 0], NaN)).toBe(0);
    expect(hit(p, [3, 3, 0], Infinity)).toBe(0);
    expect(hit(p, [3, 3, 0], 0)).toBe(1); // a point on the face still touches it
  });

  it("undoes a sphere dab like any other edit", () => {
    const p = projectOf(cubeMesh());
    const field = p.fields[0] as TrianglePaintField;
    hit(p, [0.5, 0.5, 0], 0.1);
    expect(field.states.some((s) => s === 2)).toBe(true);
    p.undo();
    expect(field.states.every((s) => s === 0)).toBe(true);
  });
});
