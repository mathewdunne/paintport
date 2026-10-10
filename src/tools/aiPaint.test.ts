import { describe, expect, it } from "vitest";
import { gridBox, uvSphere } from "../../test/support/depthRaster";
import { makeModel } from "../../test/support/docFixtures";
import { captureFor, FakeSegmenter, settle, weldSoup } from "../../test/support/fakeSam";
import { createProject } from "../doc/project";
import { triangleFrames } from "../sam/lift";
import { AiPaintSession, type AiState, type AiView } from "./aiPaint";
import type { PickHit, SamCapture, ViewMark } from "./types";

const HALF = 32; // the fake captures are 64 px wide
const leftHalf = (x: number) => (x < HALF ? 4 : -4);
const topLeft = (x: number, y: number) => (x < HALF && y < HALF ? 4 : -4);
const everything = () => 4;

function setup(soup: number[], angle = 30) {
  const mesh = weldSoup(soup);
  const project = createProject(makeModel(mesh, { filaments: [{ color: "#FF0000" }] }));
  project.addColor("#00FF00"); // state 2
  project.addColor("#0000FF"); // state 3
  project.clearHistory();
  const segmenter = new FakeSegmenter([{ score: 0.9, logit: leftHalf }, { score: 0.5, logit: everything }, { score: 0.7, logit: topLeft }]);
  let capture: SamCapture = captureFor(mesh, [5, 0.5, 0.5]);
  let region: Uint32Array | null = null;
  const marks: (readonly ViewMark[])[] = [];
  const states: (AiState | null)[] = [];
  const errors: unknown[] = [];
  const view: AiView = {
    captureSam: () => capture,
    setMarks: (m) => { marks.push(m); },
    setRegionHighlight: (_object, r) => { region = r ? r.tris : null; },
  };
  const session = new AiPaintSession({
    project, view,
    fillSettings: () => ({ angle, scale: 0 }),
    paintState: () => 2,
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
  });
  session.setSegmenter(segmenter);
  const frames = triangleFrames(project.objects[0].mesh, null);
  const centroid = (t: number): [number, number, number] => [frames.centroids[t * 3], frames.centroids[t * 3 + 1], frames.centroids[t * 3 + 2]];
  const tris = (pred: (c: [number, number, number]) => boolean) =>
    Array.from({ length: project.objects[0].triCount }, (_, t) => t).filter((t) => pred(centroid(t)));
  /** A hit on the triangle nearest to `point`, as `pick` reports it. */
  const hitNear = (point: [number, number, number], normal: [number, number, number]): PickHit => {
    const all = tris(() => true);
    const tri = all.reduce((best, t) => (dist(centroid(t), point) < dist(centroid(best), point) ? t : best), all[0]);
    return { object: 0, tri, point, normal, distance: 4 };
  };
  const shownRegion = () => (region ? Array.from(region).sort((a, b) => a - b) : null);
  const painted = (state: number) => Array.from(project.fields[0].displayStates()).flatMap((s, t) => (s === state ? [t] : []));
  return { project, mesh, segmenter, session, marks, states, errors, centroid, tris, hitNear, shownRegion, painted, setCapture: (c: SamCapture) => { capture = c; } };
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const cubeSoup = () => gridBox([0, 0, 0], [1, 1, 1], 4);
const onPlusX = (c: number[]) => Math.abs(c[0] - 1) < 1e-9;

describe("AiPaintSession", () => {
  it("paints what the mask covers on the visible face, as one undo step", async () => {
    const s = setup(cubeSoup());
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    const expected = s.tris((c) => onPlusX(c) && c[1] < 0.5);
    expect(expected).toHaveLength(16);
    expect(s.shownRegion()).toEqual(expected);
    expect(s.states.at(-1)).toEqual({ status: "ready", positive: 1, negative: 0, tris: 16, canCycle: true });
    s.session.commit();
    expect(s.painted(2)).toEqual(expected);
    expect(s.project.undoCount).toBe(1);
    expect(s.shownRegion()).toBeNull();
    expect(s.states.at(-1)).toBeNull();
  });

  it("carries the region onto the hidden side along the geometry", async () => {
    const s = setup(uvSphere([0.5, 0.5, 0.5], 0.5, 12, 24), 60);
    s.session.mark(s.hitNear([1, 0.4, 0.5], [1, 0, 0]), true);
    await settle();
    const back = s.shownRegion()!.filter((t) => s.centroid(t)[0] < 0.3);
    expect(back.length).toBeGreaterThan(10);
    expect(back.filter((t) => s.centroid(t)[1] < 0.5).length / back.length).toBeGreaterThan(0.9);
    expect(back.every((t) => s.centroid(t)[1] < 0.6)).toBe(true);
  });

  it("keeps other colors out of the region", async () => {
    const s = setup(cubeSoup());
    s.project.paintTriangles(0, s.tris((c) => onPlusX(c) && c[1] < 0.25), 3);
    s.session.mark(s.hitNear([1, 0.4, 0.5], [1, 0, 0]), true);
    await settle();
    expect(s.shownRegion()).toEqual(s.tris((c) => onPlusX(c) && c[1] > 0.25 && c[1] < 0.5));
  });

  it("selects nothing from negative marks alone", async () => {
    const s = setup(cubeSoup());
    s.session.mark(s.hitNear([1, 0.4, 0.5], [1, 0, 0]), false);
    await settle();
    expect(s.segmenter.decodes).toHaveLength(0);
    expect(s.shownRegion()).toBeNull();
    expect(s.states.at(-1)).toMatchObject({ status: "ready", positive: 0, negative: 1, tris: 0 });
  });

  it("encodes a view once and prompts it with every click made there", async () => {
    const s = setup(cubeSoup());
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    s.session.mark(s.hitNear([1, 0.8, 0.5], [1, 0, 0]), false);
    await settle();
    expect(s.segmenter.encodes).toBe(1);
    expect(s.segmenter.decodes.at(-1)!.map((p) => p.positive)).toEqual([true, false]);
    expect(s.states.at(-1)).toMatchObject({ canCycle: false });
  });

  it("adds up the masks of different views", async () => {
    const s = setup(cubeSoup());
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    s.setCapture(captureFor(s.mesh, [0.5, -5, 0.5])); // now looking at the -y face; image left = small x
    s.session.mark(s.hitNear([0.2, 0, 0.5], [0, -1, 0]), true);
    await settle();
    expect(s.segmenter.encodes).toBe(2);
    expect(s.segmenter.decodes[1]).toHaveLength(1); // the first mark is on a face this view can't see
    const plusX = s.tris((c) => onPlusX(c) && c[1] < 0.5);
    const minusY = s.tris((c) => Math.abs(c[1]) < 1e-9 && c[0] < 0.5);
    expect(s.shownRegion()).toEqual([...plusX, ...minusY].sort((a, b) => a - b));
  });

  it("steps through SAM's candidates with Tab after a single click", async () => {
    const s = setup(cubeSoup());
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    s.session.cycle(); // ranked: left half (0.9), top-left quarter (0.7), everything (0.5)
    expect(s.shownRegion()).toEqual(s.tris((c) => onPlusX(c) && c[1] < 0.5 && c[2] > 0.5));
    s.session.cycle();
    expect(s.shownRegion()).toHaveLength(32);
    s.session.cycle();
    expect(s.shownRegion()).toHaveLength(16);
  });

  it("removes the last mark with Backspace and drops a view without marks", async () => {
    const s = setup(cubeSoup());
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    s.session.mark(s.hitNear([1, 0.8, 0.5], [1, 0, 0]), false);
    await settle();
    s.session.undoMark();
    await settle();
    expect(s.segmenter.decodes.at(-1)).toHaveLength(1);
    expect(s.states.at(-1)).toMatchObject({ positive: 1, negative: 0 });
    s.session.undoMark();
    await settle();
    expect(s.session.active).toBe(false);
    expect(s.shownRegion()).toBeNull();
    expect(s.marks.at(-1)).toEqual([]);
    expect(s.segmenter.disposedEmbeddings).toBe(1);
  });

  it("drops an answer that arrives after the marks were cleared", async () => {
    const s = setup(cubeSoup());
    s.segmenter.hold = true;
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    s.session.clear();
    s.segmenter.release();
    await settle();
    expect(s.shownRegion()).toBeNull();
    expect(s.states.at(-1)).toBeNull();
  });

  it("waits with Enter until the view is analyzed", async () => {
    const s = setup(cubeSoup());
    s.segmenter.hold = true;
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    expect(s.states.at(-1)).toMatchObject({ status: "analyzing" });
    s.session.commit();
    expect(s.painted(2)).toEqual([]);
    expect(s.session.active).toBe(true);
    s.segmenter.release();
    await settle();
    s.session.commit();
    expect(s.painted(2)).toHaveLength(16);
  });

  it("recomputes the region when the document changes", async () => {
    const s = setup(cubeSoup());
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    const [first] = s.shownRegion()!;
    s.project.paintTriangles(0, [first], 3);
    s.session.refresh();
    expect(s.shownRegion()).toHaveLength(15);
    expect(s.shownRegion()).not.toContain(first);
  });

  it("only says that the model is missing when there is none", () => {
    const s = setup(cubeSoup());
    s.session.setSegmenter(null);
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    expect(s.states.at(-1)).toMatchObject({ status: "noModel" });
    expect(s.session.active).toBe(false);
  });

  it("reports a failed decode", async () => {
    const s = setup(cubeSoup());
    s.segmenter.fail = true;
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    expect(s.errors).toHaveLength(1);
    expect(s.states.at(-1)).toMatchObject({ status: "failed" });
  });

  it("does not let a cancelled request keep a new selection busy", async () => {
    const s = setup(cubeSoup());
    s.segmenter.hold = true;
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    s.session.clear();
    s.segmenter.hold = false;
    s.session.mark(s.hitNear([1, 0.3, 0.5], [1, 0, 0]), true);
    await settle();
    expect(s.states.at(-1)).toMatchObject({ status: "ready" });
    s.session.commit();
    expect(s.painted(2)).toHaveLength(16);
    s.segmenter.release();
    await settle();
    expect(s.states.at(-1)).toBeNull();
  });

  it("lets the newest answer finish even if an older decode is still running", async () => {
    const s = setup(cubeSoup());
    s.segmenter.hold = true;
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    s.segmenter.hold = false;
    s.session.mark(s.hitNear([1, 0.8, 0.5], [1, 0, 0]), false);
    await settle();
    expect(s.states.at(-1)).toMatchObject({ status: "ready", positive: 1, negative: 1 });
    s.segmenter.release();
    await settle();
    expect(s.states.at(-1)).toMatchObject({ status: "ready" });
  });

  it("keeps an embedding alive until a cancelled decode has finished using it", async () => {
    const s = setup(cubeSoup());
    s.segmenter.hold = true;
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    s.session.clear();
    await settle();
    expect(s.segmenter.disposedEmbeddings).toBe(0);
    s.segmenter.release();
    await settle();
    expect(s.segmenter.disposedEmbeddings).toBe(1);
  });

  it("stops analyzing when the only positive mark is replaced by an exclusion", async () => {
    const s = setup(cubeSoup());
    const hit = s.hitNear([1, 0.2, 0.5], [1, 0, 0]);
    s.segmenter.hold = true;
    s.session.mark(hit, true);
    await settle();
    s.session.mark(hit, false);
    expect(s.states.at(-1)).toMatchObject({ status: "ready", positive: 0, negative: 1, tris: 0 });
    s.segmenter.release();
    await settle();
    expect(s.shownRegion()).toBeNull();
    expect(s.states.at(-1)).toMatchObject({ status: "ready", tris: 0 });
  });

  it("cannot commit the old mask after an exclusion click fails", async () => {
    const s = setup(cubeSoup());
    s.session.mark(s.hitNear([1, 0.2, 0.5], [1, 0, 0]), true);
    await settle();
    expect(s.shownRegion()).toHaveLength(16);
    s.segmenter.fail = true;
    s.session.mark(s.hitNear([1, 0.8, 0.5], [1, 0, 0]), false);
    await settle();
    expect(s.states.at(-1)).toMatchObject({ status: "failed", tris: 0, canCycle: false });
    s.session.commit();
    expect(s.painted(2)).toEqual([]);
    expect(s.session.active).toBe(true); // keep the marks so the user can retry or undo
  });
});
