// Property-style test: random sequences of document operations, then everything undone must
// give the initial snapshot and everything redone the final one. Also checks, after every
// operation, the invariants the UI relies on: the palette stays compact, and the change
// events alone keep a mirrored view exact. A failure prints the seed (PARITY_SEED / PARITY_SCALE
// as in the other randomized suites).
import { describe, expect, it } from "vitest";
import { parsePaintTree, type PaintNode, type PaintSplit } from "../core";
import { cubeMesh, joinMeshes, leaf, makeMultiModel, split2, split3, stripMesh, tree } from "../../test/support/docFixtures";
import { makeRng, PARITY_SCALE, PARITY_SEED, type Rng } from "../../test/support/prng";
import { ViewerSim } from "../../test/support/viewerSim";
import { DocError } from "./errors";
import { createProject, type Project } from "./project";
import { toSnapshot } from "./snapshot";
import { TrianglePaintField } from "./trianglePaintField";

const TRI = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], tris: [0, 1, 2] };

/**
 * Two objects over one palette. Object 0: a cube and a strip (ModelParts) plus a negative volume.
 * Object 1: a cube as ModelPart with a ParameterModifier. Both carry leaves and split trees.
 */
function randomStartProject(): Project {
  return createProject(makeMultiModel([
    {
      mesh: joinMeshes(cubeMesh(), stripMesh([10, 40, 25, 5]), TRI),
      spec: {
        parts: [
          { firstTri: 0, triCount: 12, extruder: 2, type: "ModelPart", name: null },
          { firstTri: 12, triCount: 10, extruder: 3, type: "ModelPart", name: null },
          { firstTri: 22, triCount: 1, extruder: 1, type: "NegativeVolume", name: null },
        ],
        paints: [
          leaf(1), leaf(4), tree(split2(1, 3)), tree(split3(2, 4, 0)), null, leaf(3),
          null, null, null, null, null, null,
          leaf(2), null, tree(split3(3, 3, 1)), leaf(4),
        ],
      },
    },
    {
      mesh: cubeMesh([5, 5, 0]),
      spec: {
        parts: [
          { firstTri: 0, triCount: 8, extruder: 3, type: "ModelPart", name: null },
          { firstTri: 8, triCount: 4, extruder: 4, type: "ParameterModifier", name: null },
        ],
        paints: [tree(split2(2, 4)), leaf(1), null, tree(split3(1, 1, 3)), leaf(4)],
      },
    },
  ], [{ color: "#FF0000" }, { color: "#00FF00" }, { color: "#0000FF" }, { color: "#FFFF00" }]));
}

function randomTris(rng: Rng, triCount: number): number[] {
  const n = rng.int(0, 8);
  return Array.from({ length: n }, () => rng.int(-1, triCount)); // includes invalid ids and non-print triangles
}

type Op = (p: Project, rng: Rng) => void;

const leafStates = (str: string): number[] => {
  const out: number[] = [];
  (function walk(n: PaintNode) {
    if ((n as PaintSplit).children) (n as PaintSplit).children.forEach(walk);
    else out.push((n as { state: number }).state);
  })(parsePaintTree(str, "bbs"));
  return out;
};

const randomObject = (p: Project, rng: Rng) => rng.int(0, p.objects.length - 1);
const randomState = (p: Project, rng: Rng, allowBase: boolean) => rng.int(allowBase ? 0 : 1, p.palette.length - 1);
const randomHex = (rng: Rng) => `#${rng.int(0, 0xffffff).toString(16).padStart(6, "0")}`;

const OPS: Op[] = [
  (p, rng) => { const o = randomObject(p, rng); p.paintTriangles(o, randomTris(rng, p.objects[o].triCount), randomState(p, rng, true)); },
  (p, rng) => {
    const o = randomObject(p, rng);
    const candidates = rng.bool() ? undefined : randomTris(rng, p.objects[o].triCount).filter((t) => t >= 0);
    p.paintSphere(o, [rng.next() * 6 - 1, rng.next() * 3 - 1, rng.next() * 3 - 1], rng.next() * 2, randomState(p, rng, true), { candidates });
  },
  (p, rng) => { const o = randomObject(p, rng); p.paintTriangles(o, p.smartFillRegion(o, rng.int(0, p.objects[o].triCount - 1), rng.pick([0, 15, 30, 60, 180])).tris, randomState(p, rng, true)); },
  (p, rng) => { const o = randomObject(p, rng); p.paintTriangles(o, p.shellFillRegion(o, rng.int(0, p.objects[o].triCount - 1)).tris, randomState(p, rng, true)); },
  (p, rng) => { p.addColor(randomHex(rng)); },
  (p, rng) => { p.setColor(randomState(p, rng, false), randomHex(rng)); },
  (p, rng) => {
    if (p.palette.length < 3) return; // keep at least two colors so there is something to merge into
    const state = randomState(p, rng, false);
    let into = rng.int(0, p.palette.length - 1);
    if (into === state) into = 0;
    if (into === 0 && p.isBaseColor(state)) {
      let threw: unknown;
      try { p.deleteColor(state, 0); } catch (e) { threw = e; }
      expect(threw).toBeInstanceOf(DocError);
      expect((threw as DocError).code).toBe("BASE_IN_USE");
      into = state === 1 ? 2 : 1;
    }
    p.deleteColor(state, into);
  },
  (p, rng) => {
    const o = randomObject(p, rng);
    const parts = p.objects[o].parts.map((part, i) => [part, i] as const).filter(([part]) => p.baseColor.has(part.id));
    if (parts.length) p.setBaseColor(o, rng.pick(parts)[1], randomState(p, rng, false));
  },
  (p, rng) => { p.setObjectBaseColor(randomObject(p, rng), randomState(p, rng, false)); },
  (p, rng) => {
    p.beginStroke();
    for (let i = rng.int(1, 4); i > 0; i--) OPS[rng.pick([0, 1, 1, 1, 5])](p, rng);
    if (rng.bool(0.2)) p.endAllStrokes(); else p.endStroke();
  },
  (p, rng) => {
    p.batch(() => {
      for (let i = rng.int(2, 4); i > 0; i--) OPS[rng.pick([0, 1, 2, 3, 4, 5, 6, 7, 8])](p, rng);
    });
  },
  (p, rng) => { if (rng.bool(0.5)) p.undo(); else p.redo(); },
];

function expectInvariants(p: Project): void {
  const k = p.palette.length - 1;
  p.fields.forEach((f) => {
    const field = f as TrianglePaintField;
    expect(Math.max(...field.states)).toBeLessThanOrEqual(k);
    for (const [t, str] of field.preserved) {
      expect(field.isPaintable(t)).toBe(true);
      for (const s of leafStates(str)) expect(s).toBeLessThanOrEqual(k);
    }
  });
  for (const base of p.baseColor.values()) {
    expect(base).toBeGreaterThanOrEqual(1);
    expect(base).toBeLessThanOrEqual(k);
  }
  for (const c of p.palette.slice(1)) expect(c.color).toMatch(/^#[0-9A-F]{6}$/);
}

describe("random operation sequences", () => {
  const runs = Math.round(40 * PARITY_SCALE);
  for (let run = 0; run < runs; run++) {
    it(`undo-all restores the start and redo-all the end (run ${run}, seed ${PARITY_SEED})`, () => {
      const rng = makeRng(PARITY_SEED + run, "doc-ops");
      const p = randomStartProject();
      const sim = new ViewerSim(p);
      const initial = toSnapshot(p);
      expectInvariants(p);

      const log: number[] = [];
      for (let i = 0; i < 60; i++) {
        const op = rng.int(0, OPS.length - 1);
        log.push(op);
        try {
          OPS[op](p, rng);
        } catch (e) {
          throw new Error(`op ${op} failed after [${log.join(",")}] (seed ${PARITY_SEED + run}): ${String(e)}`, { cause: e });
        }
        expect(p.strokeOpen).toBe(false);
        sim.expectInSync();
        expectInvariants(p);
      }

      while (p.redo()) { /* bring back anything the sequence left undone */ }
      const final = toSnapshot(p);
      const steps = p.undoCount;
      expect(steps).toBeLessThanOrEqual(p.undoLimit);

      let undone = 0;
      while (p.undo()) {
        undone++;
        sim.expectInSync();
        expectInvariants(p);
      }
      expect(undone).toBe(steps);
      expect(toSnapshot(p)).toEqual(initial);

      let redone = 0;
      while (p.redo()) {
        redone++;
        sim.expectInSync();
      }
      expect(redone).toBe(steps);
      expect(toSnapshot(p)).toEqual(final);
    });
  }
});
