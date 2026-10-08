import { describe, expect, it } from "vitest";
import { cubeMesh, joinMeshes, makeModel } from "../../test/support/docFixtures";
import { applyTransform, parseTransform } from "../core";
import { createProject, type Project } from "../doc/project";
import { sqDistPointTriangle } from "../doc/triangleMath";
import { PaintController, type ControllerEnv } from "./PaintController";
import type { BrushTarget, PaintSettings, PaintView, PickHit } from "./types";

/** Minimal element: events, pointer capture bookkeeping. */
class FakeElement extends EventTarget {
  captured = new Set<number>();
  setPointerCapture(id: number) { this.captured.add(id); }
  releasePointerCapture(id: number) {
    if (this.captured.delete(id)) this.dispatchEvent(Object.assign(new Event("lostpointercapture"), { pointerId: id }));
  }
}

class FakeView implements PaintView {
  readonly element = new FakeElement() as unknown as HTMLElement;
  pickFn: (x: number, y: number) => PickHit | null = (x) => ({ object: 0, tri: 4, point: [x / 100, 0, 0.5], normal: [0, -1, 0], distance: 10 });
  candidateCalls: { radius: number; visibleOnly: boolean }[] = [];
  cursor: { erase: boolean; radius: number } | null = null;
  cursorShown = 0;
  regionCalls: (number | null)[] = [];
  region: { object: number; tris: Uint32Array } | null = null;
  cssCursor = "";
  private viewListeners = new Set<() => void>();

  pick(x: number, y: number) { return this.pickFn(x, y); }
  /** What the real view does: the triangles that touch the world-space sphere. Replaced by `setup`. */
  candidateFn: (hit: PickHit, radius: number) => BrushTarget[] = () => [];
  brushCandidates(hit: PickHit, radius: number, visibleOnly: boolean): BrushTarget[] {
    this.candidateCalls.push({ radius, visibleOnly });
    return this.candidateFn(hit, radius);
  }
  pixelSizeAt() { return 0.01; } // 1 px = 0.01 world units
  showBrushCursor(_hit: PickHit, radius: number, erase: boolean) { this.cursor = { erase, radius }; this.cursorShown++; }
  hideBrushCursor() { this.cursor = null; }
  setRegionHighlight(_object: number, tris: Uint32Array | null) {
    this.region = tris ? { object: _object, tris } : null;
    this.regionCalls.push(tris ? tris.length : null);
  }
  isRegionHighlighted(object: number, tri: number) { return !!this.region && this.region.object === object && this.region.tris.includes(tri); }
  onViewChange(listener: () => void) { this.viewListeners.add(listener); return () => { this.viewListeners.delete(listener); }; }
  setCursor(cursor: string) { this.cssCursor = cursor; }
  changeView() { for (const l of this.viewListeners) l(); }
}

class FakeEnv implements ControllerEnv {
  win = new EventTarget();
  time = 0;
  private frames: (() => void)[] = [];
  private timers = new Map<number, { cb: () => void; at: number }>();
  private nextId = 1;
  /** How much the clock advances per `now()` call, to simulate slow work. */
  tick = 0;
  raf(cb: () => void) { this.frames.push(cb); return this.frames.length; }
  cancelRaf() { this.frames = []; }
  setTimer(cb: () => void, ms: number) { const id = this.nextId++; this.timers.set(id, { cb, at: this.time + ms }); return id; }
  clearTimer(id: number) { this.timers.delete(id); }
  now() { this.time += this.tick; return this.time; }
  frame() { const f = this.frames; this.frames = []; f.forEach((cb) => cb()); }
  advance(ms: number) {
    this.time += ms;
    for (const [id, t] of [...this.timers]) if (t.at <= this.time) { this.timers.delete(id); t.cb(); }
  }
}

/** Like the viewer: object 0's triangles whose closest point to the hit is within the radius, in world space. */
function worldCandidates(project: Project): FakeView["candidateFn"] {
  const object = project.objects[0], { vertices, tris } = object.mesh;
  const t = parseTransform(object.transform);
  const world = new Float64Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) world.set(applyTransform(t, vertices[i], vertices[i + 1], vertices[i + 2]), i);
  return (hit, radius) => {
    const found: number[] = [];
    for (let tri = 0; tri < object.triCount; tri++) {
      if (tri === hit.tri || sqDistPointTriangle(world, tris, tri, hit.point[0], hit.point[1], hit.point[2]) <= radius * radius) found.push(tri);
    }
    return [{ object: 0, tris: Uint32Array.from(found) }];
  };
}

const base: PaintSettings = { tool: "brush", activeState: 2, radius: 0.3, paintThrough: false, smartAngle: 30 };

function setup(settings: Partial<PaintSettings> = {}, mesh = cubeMesh(), transform: string | null = null) {
  const model = makeModel(mesh, { filaments: [{ color: "#FF0000" }] });
  model.objects[0].transform = transform;
  const project = createProject(model);
  project.addColor("#00FF00"); // state 2
  project.addColor("#0000FF"); // state 3
  project.clearHistory();
  const view = new FakeView();
  view.candidateFn = worldCandidates(project);
  const env = new FakeEnv();
  const picked: number[] = [];
  const swatches: ({ x: number; y: number; color: string } | null)[] = [];
  const controller = new PaintController(project, view, { onPickState: (s) => picked.push(s), onSwatch: (s) => swatches.push(s) }, { ...base, ...settings }, env);
  const el = view.element as unknown as FakeElement;
  const fire = (target: EventTarget, type: string, init: Record<string, unknown> = {}) =>
    target.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, pointerType: "mouse", button: 0, buttons: 0, clientX: 50, clientY: 50, shiftKey: false, altKey: false }, init));
  const down = (init: Record<string, unknown> = {}) => fire(el, "pointerdown", { buttons: 1, ...init });
  const move = (x: number, init: Record<string, unknown> = {}) => fire(el, "pointermove", { clientX: x, buttons: 1, ...init });
  const hover = (x: number, init: Record<string, unknown> = {}) => fire(el, "pointermove", { clientX: x, buttons: 0, ...init });
  const up = (init: Record<string, unknown> = {}) => fire(el, "pointerup", init);
  return { project, view, env, controller, el, picked, swatches, down, move, hover, up, fire };
}

const painted = (p: Project) => Array.from(p.fields[0].displayStates()).map((s, t) => (s ? t : -1)).filter((t) => t >= 0);

describe("brush strokes", () => {
  it("paints on press, follows the pointer once per frame, and is one undo step", () => {
    const { project, view, env, down, move, up, el } = setup();
    down({ clientX: 50 });
    expect(project.strokeOpen).toBe(true);
    expect((el as unknown as FakeElement).captured.has(1)).toBe(true);
    expect(painted(project)).toEqual(expect.arrayContaining([4, 5]));
    const calls = view.candidateCalls.length;
    move(60); move(70); move(80);
    expect(view.candidateCalls.length).toBe(calls); // nothing until the frame
    env.frame();
    expect(view.candidateCalls.length).toBeGreaterThan(calls);
    up({ clientX: 80 });
    expect(project.strokeOpen).toBe(false);
    expect(el.captured.size).toBe(0);
    expect(project.undoCount).toBe(1);
    project.undo();
    expect(painted(project)).toEqual([]);
  });

  it("spaces dabs about a third of the radius apart along a fast drag", () => {
    // radius 0.3 at 0.01 per pixel = 30 px, so a dab every 10 px
    const { view, env, down, move, up } = setup();
    down({ clientX: 0 });
    const initial = view.candidateCalls.length;
    move(300);
    env.frame();
    up({ clientX: 300 });
    const dabs = view.candidateCalls.length - initial;
    expect(dabs).toBeGreaterThanOrEqual(29);
    expect(dabs).toBeLessThanOrEqual(31);
  });

  it("passes the paint-through setting to the visibility filter", () => {
    const a = setup({ paintThrough: false });
    a.down();
    a.up();
    expect(a.view.candidateCalls.every((c) => c.visibleOnly)).toBe(true);
    const b = setup({ paintThrough: true });
    b.down();
    b.up();
    expect(b.view.candidateCalls.length).toBeGreaterThan(0);
    expect(b.view.candidateCalls.every((c) => !c.visibleOnly)).toBe(true);
  });

  it("does not paint where the ray misses the model, and leaves no empty undo step", () => {
    const { project, view, down, up } = setup();
    view.pickFn = () => null;
    down();
    up();
    expect(painted(project)).toEqual([]);
    expect(project.undoCount).toBe(0);
    expect(project.strokeOpen).toBe(false);
  });

  it("closes the stroke when the pointer is cancelled", () => {
    const { project, down, fire, el } = setup();
    down();
    fire(el, "pointercancel");
    expect(project.strokeOpen).toBe(false);
    expect(project.undoCount).toBe(1);
  });

  it("closes the stroke when pointer capture is lost", () => {
    const { project, down, fire, el } = setup();
    down();
    fire(el, "lostpointercapture");
    expect(project.strokeOpen).toBe(false);
    expect(project.undoCount).toBe(1);
  });

  it("closes the stroke on window blur", () => {
    const { project, env, down, fire } = setup();
    down();
    fire(env.win, "blur");
    expect(project.strokeOpen).toBe(false);
    expect(project.undoCount).toBe(1);
  });

  it("closes the stroke when the tool changes", () => {
    const { project, controller, down } = setup();
    down();
    controller.setSettings({ ...base, tool: "smartFill" });
    expect(project.strokeOpen).toBe(false);
    expect(project.undoCount).toBe(1);
  });

  it("closes the stroke when the button is released while another one is still held", () => {
    const { project, env, down, move } = setup();
    down();
    move(60, { buttons: 2 }); // left released, right still down: no pointerup yet
    env.frame();
    expect(project.strokeOpen).toBe(false);
    expect(project.undoCount).toBe(1);
  });

  it("closes the stroke on dispose and stops listening", () => {
    const { project, controller, down, view } = setup();
    down();
    controller.dispose();
    expect(project.strokeOpen).toBe(false);
    const calls = view.candidateCalls.length;
    down();
    expect(view.candidateCalls.length).toBe(calls);
    expect(project.strokeOpen).toBe(false);
  });

  it("paints nothing when the active color is not in the palette", () => {
    const { project, down, up } = setup({ activeState: 9 });
    down();
    up();
    expect(painted(project)).toEqual([]);
    expect(project.undoCount).toBe(0);
  });

  it("ignores touch input", () => {
    const { project, down } = setup();
    down({ pointerType: "touch" });
    expect(project.strokeOpen).toBe(false);
  });
});

describe("brush in world space", () => {
  it("converts the brush sphere into the object's own space through its build transform", () => {
    // The cube sits 10 units along x in the world. A dab at world x = 10.5 is at x = 0.5 on the cube.
    const { project, view, down, up } = setup({}, cubeMesh(), "1 0 0 0 1 0 0 0 1 10 0 0");
    view.pickFn = () => ({ object: 0, tri: 4, point: [10.5, 0, 0.5], normal: [0, -1, 0], distance: 10 });
    down(); up();
    expect(painted(project)).toEqual(expect.arrayContaining([4, 5]));
    expect(painted(project).length).toBeLessThanOrEqual(4); // not the whole cube: the sphere was moved, not just scaled
  });

  it("scales the radius with the transform", () => {
    // 0.2 from the cube's x = 1 face: a 0.3 brush reaches it; scaled up 2x in the world it is only 0.15 in the cube's space.
    const plain = setup({ radius: 0.3 });
    plain.view.pickFn = () => ({ object: 0, tri: 4, point: [0.8, 0, 0.5], normal: [0, -1, 0], distance: 10 });
    plain.down(); plain.up();
    expect(painted(plain.project)).toEqual(expect.arrayContaining([4, 5, 7]));

    const scaled = setup({ radius: 0.3 }, cubeMesh(), "2 0 0 0 2 0 0 0 2 0 0 0");
    scaled.view.pickFn = () => ({ object: 0, tri: 4, point: [1.6, 0, 1], normal: [0, -1, 0], distance: 10 });
    scaled.down(); scaled.up();
    expect(painted(scaled.project)).toEqual([4]); // the diagonal to triangle 5 is 0.21 away
  });

  it("paints exactly what the world-space ring covers under a non-uniform scale", () => {
    // Stretched 2x along x only. The brush is a true sphere in the world (radius 0.3); in the cube's own space it
    // is an ellipsoid, and a sphere of the mean scale (radius 0.3 / 1.26 = 0.238) would stop short of the top face
    // (0.25 away along the unscaled z axis) that the ring reaches.
    const { project, view, down, up } = setup({ radius: 0.3 }, cubeMesh(), "2 0 0 0 1 0 0 0 1 0 0 0");
    view.pickFn = () => ({ object: 0, tri: 4, point: [1, 0, 0.75], normal: [0, -1, 0], distance: 10 });
    down(); up();
    expect(painted(project)).toEqual(expect.arrayContaining([2, 4, 5])); // 2 = the top face triangle at distance 0.25
    const asked = view.candidateFn(view.pickFn(0, 0)!, 0.3)[0].tris;
    expect(painted(project)).toEqual(Array.from(asked).sort((a, b) => a - b)); // all and only the world-space candidates
  });
});

describe("buttons during a stroke", () => {
  it("a right press mid-stroke starts no orbit (the viewer never sees it) and a right release does not end the stroke", () => {
    const { project, view, el, down, move, up, env } = setup();
    let viewerSaw = 0;
    el.addEventListener("pointerdown", () => viewerSaw++); // stands in for the orbit controls on the same element
    down();
    expect(viewerSaw).toBe(1);
    down({ button: 2, buttons: 3, pointerId: 2 });
    expect(viewerSaw).toBe(1);
    expect(view.cssCursor).not.toBe("grabbing");
    up({ button: 2, buttons: 1 });
    expect(project.strokeOpen).toBe(true);
    move(80); env.frame();
    up({ button: 0 });
    expect(project.strokeOpen).toBe(false);
    expect(project.undoCount).toBe(1);
  });

  it("only the left button's release ends the stroke", () => {
    const { project, down, up } = setup();
    down();
    up({ button: 1, buttons: 0 });
    expect(project.strokeOpen).toBe(true);
    up({ button: 0 });
    expect(project.strokeOpen).toBe(false);
  });
});

describe("the project changing under a stroke", () => {
  it("closes the stroke and lets go of the pointer when the project is replaced (import)", () => {
    const first = setup();
    first.down();
    expect(first.project.strokeOpen).toBe(true);
    first.controller.dispose(); // what ModelCanvas does when a new project arrives
    expect(first.project.strokeOpen).toBe(false);
    expect(first.project.undoCount).toBe(1);
    expect(first.el.captured.size).toBe(0);
    expect(first.view.cursor).toBeNull();
    // Late events of the old gesture do nothing, and a new controller on the new project starts clean.
    first.move(90); first.up();
    first.env.frame();
    expect(first.project.undoCount).toBe(1);
    const second = setup();
    second.down(); second.up();
    expect(second.project.undoCount).toBe(1);
  });

  it("refuses undo and redo while the stroke is open and keeps painting; one undo reverts the whole stroke", () => {
    const { project, down, move, up, env } = setup();
    down({ clientX: 50 });
    const afterFirstDab = painted(project).length;
    expect(project.undo()).toBe(false); // what Ctrl+Z and the header button call
    expect(project.canUndo).toBe(false);
    move(70); env.frame();
    expect(project.strokeOpen).toBe(true);
    expect(painted(project).length).toBeGreaterThanOrEqual(afterFirstDab);
    up({ clientX: 70 });
    expect(project.undoCount).toBe(1);
    expect(project.undo()).toBe(true);
    expect(painted(project)).toEqual([]);
    expect(project.redo()).toBe(true);
    expect(painted(project).length).toBeGreaterThan(0);
  });

  it("an undo of an earlier edit from outside during a drag does not corrupt the stroke", () => {
    const { project, down, move, up, env } = setup();
    project.paintTriangles(0, [8], 3); // an earlier step
    down();
    project.undo(); // refused
    move(70); env.frame();
    up({ clientX: 70 });
    expect(project.undoCount).toBe(2);
    project.undo();
    expect(painted(project)).toEqual([8]);
  });
});

describe("robustness", () => {
  it("closes the stroke on release even if the last dab fails", () => {
    const { project, view, controller, down } = setup();
    down();
    view.pickFn = () => { throw new Error("context lost"); };
    // Called directly: an exception inside an event listener is reported by the runtime, not thrown to the caller.
    expect(() => (controller as unknown as { release(): void }).release()).toThrow("context lost");
    expect(project.strokeOpen).toBe(false);
    expect(project.undoCount).toBe(1);
  });

  it("limits the dabs per frame when they are slow, so a fast drag gets wider spacing instead of a stall", () => {
    const fast = setup();
    fast.down({ clientX: 0 });
    const fastBefore = fast.view.candidateCalls.length;
    fast.move(300); fast.env.frame();
    const fastDabs = fast.view.candidateCalls.length - fastBefore;

    const slow = setup();
    slow.env.tick = 4; // every dab looks like it took 4 ms
    slow.down({ clientX: 0 });
    slow.move(100); slow.env.frame(); // lets the controller learn the cost
    const slowBefore = slow.view.candidateCalls.length;
    slow.move(400); slow.env.frame();
    const slowDabs = slow.view.candidateCalls.length - slowBefore;

    expect(fastDabs).toBeGreaterThan(25);
    expect(slowDabs).toBeLessThan(fastDabs / 2);
    expect(slowDabs).toBeGreaterThanOrEqual(4);
  });

  it("builds the fill adjacency when a fill tool is chosen, not at the first hover", () => {
    const { project, controller, env } = setup();
    let built = 0;
    const topology = project.topology.bind(project);
    project.topology = (i: number) => { built++; return topology(i); };
    controller.setSettings({ ...base, tool: "smartFill" });
    expect(built).toBe(0);
    env.advance(0);
    expect(built).toBe(1);
    controller.setSettings({ ...base, tool: "brush" });
    env.advance(10);
    expect(built).toBe(1);
  });
});

describe("erasing", () => {
  it("the eraser tool paints state 0", () => {
    const { project, down, up, controller } = setup();
    down(); up();
    expect(painted(project).length).toBeGreaterThan(0);
    controller.setSettings({ ...base, tool: "eraser" });
    down(); up();
    expect(painted(project)).toEqual([]);
    expect(project.undoCount).toBe(2);
  });

  it("holding Shift while brushing erases", () => {
    const { project, down, up } = setup();
    down(); up();
    expect(painted(project).length).toBeGreaterThan(0);
    down({ shiftKey: true }); up({ shiftKey: true });
    expect(painted(project)).toEqual([]);
  });

  it("Shift+right is not a stroke (it pans)", () => {
    const { project, down, move, env } = setup();
    down({ button: 2, buttons: 2, shiftKey: true });
    move(80, { buttons: 2, shiftKey: true });
    env.frame();
    expect(project.strokeOpen).toBe(false);
    expect(painted(project)).toEqual([]);
  });

  it("shows a dashed (erase) ring while Shift is held over the model", () => {
    const { view, env, hover, fire } = setup();
    hover(50);
    env.frame();
    expect(view.cursor?.erase).toBe(false);
    fire(env.win, "keydown", { key: "Shift", shiftKey: true });
    env.frame();
    expect(view.cursor?.erase).toBe(true);
  });
});

describe("Alt: eyedropper on click, orbit on drag", () => {
  it("Alt+click without movement picks the color under the cursor from any tool, and paints nothing", () => {
    const { project, picked, down, up } = setup();
    project.paintTriangles(0, [4], 3);
    project.clearHistory();
    down({ altKey: true });
    expect(project.strokeOpen).toBe(false);
    up({ altKey: true });
    expect(picked).toEqual([3]);
    expect(project.undoCount).toBe(0);
  });

  it("Alt+drag is an orbit: no pick, no paint", () => {
    const { project, picked, down, move, up } = setup();
    down({ altKey: true, clientX: 50 });
    move(80, { altKey: true });
    up({ altKey: true, clientX: 80 });
    expect(picked).toEqual([]);
    expect(painted(project)).toEqual([]);
  });

  it("a slight wobble within the threshold is still a click", () => {
    const { project, picked, down, move, up } = setup();
    project.paintTriangles(0, [4], 3);
    down({ altKey: true, clientX: 50 });
    move(52, { altKey: true });
    up({ altKey: true, clientX: 52 });
    expect(picked).toEqual([3]);
  });

  it("picks the base color of an unpainted triangle", () => {
    const { picked, down, up } = setup();
    down({ altKey: true }); up({ altKey: true });
    expect(picked).toEqual([1]);
  });

  it("right and middle drags are the viewer's: the controller just stays out", () => {
    const { project, view, down, move, up, env } = setup();
    for (const button of [1, 2]) {
      down({ button, buttons: 1 << button });
      move(90, { button, buttons: 1 << button });
      env.frame();
      expect(view.cursor).toBeNull();
      expect(view.cssCursor).toBe("grabbing");
      up({ button });
    }
    expect(painted(project)).toEqual([]);
  });
});

describe("eyedropper tool", () => {
  it("a plain click picks the shown color", () => {
    const { project, picked, down, up, controller } = setup();
    project.paintTriangles(0, [4], 2);
    controller.setSettings({ ...base, tool: "eyedropper" });
    down(); up();
    expect(picked).toEqual([2]);
    expect(project.strokeOpen).toBe(false);
  });

  it("shows the color under the cursor as a chip, and hides it when the pointer leaves", () => {
    const { project, swatches, hover, env, controller, fire, el } = setup();
    project.paintTriangles(0, [4], 3);
    controller.setSettings({ ...base, tool: "eyedropper" });
    hover(70);
    env.frame();
    expect(swatches.at(-1)).toEqual({ x: 70, y: 50, color: project.palette[3].color });
    fire(el, "pointerleave");
    expect(swatches.at(-1)).toBeNull();
  });
});

describe("fills", () => {
  it("shell fill paints the whole shell with the active color as one undo step", () => {
    const { project, down, up } = setup({ tool: "shellFill" });
    down(); up();
    expect(painted(project)).toHaveLength(12);
    expect(project.undoCount).toBe(1);
    project.undo();
    expect(painted(project)).toEqual([]);
  });

  it("smart fill stops at edges sharper than the angle", () => {
    const { project, down, up } = setup({ tool: "smartFill", smartAngle: 30 });
    down(); up();
    expect(painted(project)).toHaveLength(2); // one face of the cube
    expect(project.undoCount).toBe(1);
  });

  it("smart fill with a wide angle crosses the cube's 90 degree edges", () => {
    const { project, down, up } = setup({ tool: "smartFill", smartAngle: 90 });
    down(); up();
    expect(painted(project)).toHaveLength(12);
  });

  it("previews the region on hover without painting, and clears it when the pointer leaves", () => {
    const { project, view, env, hover, fire, el } = setup({ tool: "smartFill" });
    hover(50);
    env.frame();
    expect(view.region?.tris).toHaveLength(2);
    expect(painted(project)).toEqual([]);
    expect(project.undoCount).toBe(0);
    fire(el, "pointerleave");
    expect(view.region).toBeNull();
  });

  it("recomputes the preview only when the seed leaves the region, the angle changes or the document changes", () => {
    const { project, view, env, hover, controller } = setup({ tool: "smartFill" });
    hover(50); env.frame();
    expect(view.regionCalls).toEqual([2]);
    const other = Array.from(view.region!.tris).find((t) => t !== 4)!; // another triangle of the same face
    view.pickFn = (x) => ({ object: 0, tri: other, point: [x / 100, 0, 0.5], normal: [0, -1, 0], distance: 10 });
    hover(60); env.frame();
    hover(70); env.frame();
    expect(view.regionCalls).toEqual([2]); // moving inside the region costs nothing
    controller.setSettings({ ...base, tool: "smartFill", smartAngle: 90 });
    env.frame();
    expect(view.regionCalls).toEqual([2, 12]);
    project.paintTriangles(0, [0], 2); // the document changed under the cursor
    env.frame();
    expect(view.regionCalls).toHaveLength(3);
  });

  it("waits for the pointer to rest before recomputing a slow preview", () => {
    const { view, env, hover } = setup({ tool: "shellFill" }, joinMeshes(cubeMesh(), cubeMesh([5, 0, 0])));
    env.tick = 20; // every clock read costs 20 ms: the first computation looks slow
    hover(50); env.frame();
    expect(view.regionCalls).toEqual([12]);
    // A seed on the other cube is outside the highlighted shell: it is not computed at once.
    view.pickFn = (x) => ({ object: 0, tri: 12, point: [x / 100, 0, 0.5], normal: [0, -1, 0], distance: 10 });
    hover(60); env.frame();
    hover(70); env.frame();
    expect(view.regionCalls).toEqual([12]);
    env.advance(100);
    env.frame();
    expect(view.regionCalls).toEqual([12, 12]);
    expect(view.region?.tris.includes(12)).toBe(true);
  });

  it("shows no brush ring for fills, and a crosshair cursor over the model", () => {
    const { view, env, hover } = setup({ tool: "shellFill" });
    hover(50); env.frame();
    expect(view.cursor).toBeNull();
    expect(view.cssCursor).toBe("crosshair");
  });
});

describe("hover feedback", () => {
  it("shows the ring at the hit with the brush radius and hides the cursor (the ring is the cursor)", () => {
    const { view, env, hover } = setup({ radius: 1.5 });
    hover(50); env.frame();
    expect(view.cursor).toEqual({ erase: false, radius: 1.5 });
    expect(view.cssCursor).toBe("none");
  });

  it("uses the default cursor, and no ring, where the ray misses", () => {
    const { view, env, hover } = setup();
    view.pickFn = () => null;
    hover(50); env.frame();
    expect(view.cursor).toBeNull();
    expect(view.cssCursor).toBe("default");
  });

  it("hides the ring when the pointer leaves, during orbiting, and brings it back afterwards", () => {
    const { view, env, hover, down, up, fire, el } = setup();
    hover(50); env.frame();
    expect(view.cursor).not.toBeNull();
    down({ button: 2, buttons: 2 });
    expect(view.cursor).toBeNull();
    up({ button: 2 });
    env.frame();
    expect(view.cursor).not.toBeNull();
    fire(el, "pointerleave");
    expect(view.cursor).toBeNull();
  });

  it("follows radius changes and camera moves", () => {
    const { view, env, hover, controller } = setup();
    hover(50); env.frame();
    const shown = view.cursorShown;
    controller.setSettings({ ...base, radius: 2 });
    env.frame();
    expect(view.cursor?.radius).toBe(2);
    view.changeView();
    env.frame();
    expect(view.cursorShown).toBeGreaterThan(shown + 1);
  });

  it("moves the ring with the pointer during a stroke", () => {
    const { view, env, down, move } = setup();
    down();
    const shown = view.cursorShown;
    move(90); env.frame();
    expect(view.cursorShown).toBeGreaterThan(shown);
  });
});
