import { describe, expect, it } from "vitest";
import { cubeMesh, makeModel } from "../../../test/support/docFixtures";
import { createProject, type Project } from "@/doc/project";
import { ColorEditSession, type FrameEnv } from "./colorSession";

function project(): Project {
  const p = createProject(makeModel(cubeMesh(), { filaments: [{ color: "#FF0000" }] }));
  p.addColor("#00FF00");
  p.clearHistory();
  return p;
}

/** Frames run only when the test says so. */
function manualFrames(): FrameEnv & { run(): void; pending(): number } {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    raf: (cb) => {
      queue.set(next, cb);
      return next++;
    },
    cancelRaf: (id) => {
      queue.delete(id);
    },
    run() {
      const all = [...queue.values()];
      queue.clear();
      all.forEach((cb) => cb());
    },
    pending: () => queue.size,
  };
}

describe("ColorEditSession", () => {
  it("is one undo step however many times the color changes", () => {
    const p = project();
    const frames = manualFrames();
    const s = new ColorEditSession(p, frames);
    const original = p.palette[1].color;
    s.begin(1);
    for (const c of ["#111111", "#222222", "#333333"]) {
      s.set(c);
      frames.run();
    }
    expect(p.palette[1].color).toBe("#333333");
    expect(p.strokeOpen).toBe(true);
    s.end();
    expect(p.strokeOpen).toBe(false);
    expect(p.undoCount).toBe(1);
    p.undo();
    expect(p.palette[1].color).toBe(original);
    p.redo();
    expect(p.palette[1].color).toBe("#333333");
  });

  it("applies only the latest value, once per frame", () => {
    const p = project();
    const frames = manualFrames();
    let palettes = 0;
    p.subscribe((e) => {
      if (e.kind === "palette") palettes++;
    });
    const s = new ColorEditSession(p, frames);
    s.begin(1);
    for (let i = 0; i < 50; i++) s.set(`#0000${(i + 16).toString(16).toUpperCase()}`);
    expect(frames.pending()).toBe(1);
    expect(palettes).toBe(0);
    frames.run();
    expect(palettes).toBe(1);
    expect(p.palette[1].color).toBe("#000041"); // i = 49 -> 0x41
    s.end();
  });

  it("end applies a value that has not had its frame yet", () => {
    const p = project();
    const frames = manualFrames();
    const s = new ColorEditSession(p, frames);
    s.begin(1);
    s.set("#ABCDEF");
    s.end();
    expect(p.palette[1].color).toBe("#ABCDEF");
    expect(frames.pending()).toBe(0);
    expect(p.undoCount).toBe(1);
  });

  it("leaves no undo step when the color ends where it began, or was never changed", () => {
    const p = project();
    const frames = manualFrames();
    const original = p.palette[1].color;
    const s = new ColorEditSession(p, frames);
    s.begin(1);
    s.end();
    expect(p.undoCount).toBe(0);
    s.begin(1);
    s.set("#123456");
    frames.run();
    s.set(original);
    s.end();
    expect(p.palette[1].color).toBe(original);
    expect(p.undoCount).toBe(0);
  });

  it("end is safe to call repeatedly and when never begun", () => {
    const p = project();
    const s = new ColorEditSession(p, manualFrames());
    s.end();
    s.begin(1);
    s.set("#010101");
    s.end();
    s.end();
    expect(p.strokeOpen).toBe(false);
    expect(p.undoCount).toBe(1);
  });

  it("ignores set outside a session", () => {
    const p = project();
    const frames = manualFrames();
    const s = new ColorEditSession(p, frames);
    s.set("#FFFFFF");
    expect(frames.pending()).toBe(0);
    s.begin(1);
    s.end();
    s.set("#FFFFFF");
    expect(frames.pending()).toBe(0);
  });

  it("does not leave a stroke open when another stroke already ended everything", () => {
    const p = project();
    const s = new ColorEditSession(p, manualFrames());
    s.begin(1);
    p.endAllStrokes(); // e.g. a brush stroke finished while the picker was open
    s.end();
    expect(p.strokeOpen).toBe(false);
  });

  it("does not close a stroke it does not own", () => {
    const p = project();
    const frames = manualFrames();
    const s = new ColorEditSession(p, frames);
    s.begin(1);
    p.endAllStrokes(); // the picker's stroke is gone ...
    p.beginStroke(); // ... and a brush stroke begins
    p.paintTriangles(0, [1], 2);
    s.set("#111111"); // late preview events must not leak into that stroke either
    frames.run();
    s.end(); // the picker closes now
    expect(p.strokeOpen).toBe(true); // the brush stroke is untouched
    expect(p.palette[1].color).not.toBe("#111111");
    p.endStroke();
    expect(p.undoCount).toBe(1);
  });

  it("stops listening once closed", () => {
    const p = project();
    const s = new ColorEditSession(p, manualFrames());
    s.begin(1);
    s.end();
    p.beginStroke(); // would look like "someone closed our stroke" to a session still listening
    p.endAllStrokes();
    s.begin(1);
    expect(p.strokeOpen).toBe(true);
    s.end();
    expect(p.strokeOpen).toBe(false);
  });

  it("beginning a second session closes the first", () => {
    const p = project();
    const frames = manualFrames();
    const s = new ColorEditSession(p, frames);
    s.begin(1);
    s.set("#111111");
    s.begin(2);
    expect(p.palette[1].color).toBe("#111111");
    s.set("#222222");
    s.end();
    expect(p.undoCount).toBe(2);
    expect(p.strokeOpen).toBe(false);
  });

  it("survives a color that no longer exists", () => {
    const p = project();
    const s = new ColorEditSession(p, manualFrames());
    s.begin(2);
    p.deleteColor(2, 1);
    s.set("#111111");
    expect(() => s.end()).not.toThrow();
    expect(p.strokeOpen).toBe(false);
  });
});
