// Fills follow the pieces of split triangles (spec Q12.3): a fill stops exactly at a brushed
// line, with no gap next to it and no leak across it.
import { describe, expect, it } from "vitest";
import { makeModel } from "../../test/support/docFixtures";
import { createProject, type Project } from "./project";
import type { Region } from "./paintField";

const N = 4, CELL = 10; // a 40 x 40 mm plate of 4 x 4 cells, two triangles each

function plate(): Project {
  const vertices: number[] = [], tris: number[] = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) vertices.push(i * CELL, j * CELL, 0);
  const v = (i: number, j: number) => j * (N + 1) + i;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    tris.push(v(i, j), v(i + 1, j), v(i + 1, j + 1)); // lower right
    tris.push(v(i, j), v(i + 1, j + 1), v(i, j + 1)); // upper left
  }
  const p = createProject(makeModel({ vertices, tris }, {
    filaments: [{ color: "#FFFFFF" }],
    parts: [{ firstTri: 0, triCount: N * N * 2, extruder: 1, type: "ModelPart", name: null }],
  }));
  p.addColor("#FF0000"); // 2: the brushed line
  p.addColor("#0000FF"); // 3: the fill
  return p;
}

/** The triangle under (x, y) and the point's barycentric coordinates in it. */
function locate(p: Project, x: number, y: number): { tri: number; bary: [number, number, number] } {
  const { vertices, tris } = p.objects[0].mesh;
  for (let t = 0; t < tris.length / 3; t++) {
    const c = [0, 1, 2].map((k) => [vertices[tris[t * 3 + k] * 3], vertices[tris[t * 3 + k] * 3 + 1]]);
    const den = (c[1][1] - c[2][1]) * (c[0][0] - c[2][0]) + (c[2][0] - c[1][0]) * (c[0][1] - c[2][1]);
    const a = ((c[1][1] - c[2][1]) * (x - c[2][0]) + (c[2][0] - c[1][0]) * (y - c[2][1])) / den;
    const b = ((c[2][1] - c[0][1]) * (x - c[2][0]) + (c[0][0] - c[2][0]) * (y - c[2][1])) / den;
    if (a >= 0 && b >= 0 && a + b <= 1) return { tri: t, bary: [a, b, 1 - a - b] };
  }
  throw new Error(`no triangle at ${x}, ${y}`);
}

const shown = (p: Project, x: number, y: number) => { const l = locate(p, x, y); return p.stateShownAt(0, l.tri, l.bary); };

/** A brushed line across the plate at y = 21 (radius 1.5): it cuts through triangles, never along their sides. */
function brushLine(p: Project) {
  for (let x = -2; x <= 42; x += 0.5) p.paintSphere(0, [x, 21, 0], 1.5, 2, { split: { limit: 0.2 } });
  expect(p.fields[0].trees().size).toBeGreaterThan(4);
}

/** Every sample below the line is `below`, every sample above is `above`, and the line itself stays 2. */
function expectSides(p: Project, below: number, above: number) {
  for (let y = 0.5; y < 40; y += 1) for (let x = 0.5; x < 40; x += 1) {
    const d = Math.abs(y - 21);
    if (Math.abs(d - 1.5) < 0.3) continue; // within the cut resolution of the line's edge
    expect(shown(p, x, y), `at ${x}, ${y}`).toBe(d < 1.5 ? 2 : y < 21 ? below : above);
  }
}

const paint = (p: Project, region: Region) => p.paintRegion(0, region, 3);

describe("fills on split triangles", () => {
  it("smart fill fills up to the brushed line and not across it", () => {
    const p = plate();
    brushLine(p);
    paint(p, p.smartFillRegion(0, locate(p, 5, 5), 30));
    expectSides(p, 3, 1);
  });

  it("starts from the piece under the click, also on a split triangle", () => {
    const p = plate();
    brushLine(p);
    const seed = locate(p, 13, 18.5); // just below the line, inside a split triangle
    expect(p.fields[0].treeOf(seed.tri)).toBeDefined();
    paint(p, p.smartFillRegion(0, seed, 30));
    expectSides(p, 3, 1);
    const above = locate(p, 13, 23.5); // the same triangle's other side of the line
    paint(p, p.smartFillRegion(0, above, 30));
    expectSides(p, 3, 3);
  });

  it("Replace color (no edge limit) and guided fill stop at the line too", () => {
    const p = plate();
    brushLine(p);
    paint(p, p.smartFillRegion(0, locate(p, 35, 35), 180));
    expectSides(p, 1, 3);
    const q = plate();
    brushLine(q);
    paint(q, q.guidedFillRegion(0, [locate(q, 5, 5)], [locate(q, 35, 35)], 30));
    expectSides(q, 3, 1);
  });

  it("a feature-size fill on a flat plate is the smart fill", () => {
    const p = plate();
    brushLine(p);
    paint(p, p.smartFillRegion(0, locate(p, 5, 5), 30, 3));
    expectSides(p, 3, 1);
  });

  it("filling the line itself recolors only the line", () => {
    const p = plate();
    brushLine(p);
    paint(p, p.smartFillRegion(0, locate(p, 20, 21), 30));
    for (let x = 0.5; x < 40; x += 1) {
      expect(shown(p, x, 21)).toBe(3);
      expect(shown(p, x, 10)).toBe(1);
      expect(shown(p, x, 32)).toBe(1);
    }
  });

  it("is one undo step and leaves no tree where a whole triangle ends up one color", () => {
    const p = plate();
    brushLine(p);
    const before = new Map(p.fields[0].trees());
    p.clearHistory();
    paint(p, p.smartFillRegion(0, locate(p, 20, 21), 30));
    expect(p.undoCount).toBe(1);
    p.undo();
    expect(new Map(p.fields[0].trees())).toEqual(before);
  });
});
