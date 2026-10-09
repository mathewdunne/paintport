import { describe, expect, it } from "vitest";
import { captureFor, CAPTURE_SIZE, weldSoup } from "../../test/support/fakeSam";
import { gridBox } from "../../test/support/depthRaster";
import { combineViews, promptsFor, type AiMark } from "./selection";

const cube = weldSoup(gridBox([0, 0, 0], [1, 1, 1], 4));
const fromX = captureFor(cube, [5, 0.5, 0.5]); // sees the +x face
const mark = (point: [number, number, number], normal: [number, number, number], positive: boolean, view: number): AiMark =>
  ({ tri: 0, point, normal, positive, view, state: 1 });

describe("promptsFor", () => {
  it("projects the marks into the view's image", () => {
    const [p] = promptsFor([mark([1, 0.5, 0.5], [1, 0, 0], true, 1)], 1, fromX.camera, fromX.visibility);
    expect(p.positive).toBe(true);
    expect(p.x).toBeCloseTo(CAPTURE_SIZE / 2);
    expect(p.y).toBeCloseTo(CAPTURE_SIZE / 2);
  });

  it("takes positive marks from other views only where this view sees them", () => {
    const marks = [mark([1, 0.3, 0.5], [1, 0, 0], true, 7), mark([0.5, 0, 0.5], [0, -1, 0], true, 7)];
    expect(promptsFor(marks, 1, fromX.camera, fromX.visibility)).toHaveLength(1); // the -y face is not visible from +x
  });

  it("takes negative marks only from the view they were made in", () => {
    const marks = [mark([1, 0.3, 0.5], [1, 0, 0], true, 1), mark([1, 0.7, 0.5], [1, 0, 0], false, 2)];
    expect(promptsFor(marks, 1, fromX.camera, fromX.visibility).map((p) => p.positive)).toEqual([true]);
    expect(promptsFor(marks, 2, fromX.camera, fromX.visibility).map((p) => p.positive)).toEqual([true, false]);
  });
});

describe("combineViews", () => {
  const split = (inside: number[], outside: number[]) => ({ inside: Uint32Array.from(inside), outside: Uint32Array.from(outside) });

  it("unites the masks, and keeps out what some view saw outside its mask and no mask covers", () => {
    const states = new Uint16Array(8).fill(1);
    const seeds = combineViews([split([0, 1], [2, 3]), split([3, 4], [0, 5])], 8, states, 1);
    expect(seeds.inside).toEqual([0, 1, 3, 4]); // 3 is inside view 2's mask: masks win
    expect(seeds.outside).toEqual([2, 5]);
  });

  it("lets only triangles of the clicked color in", () => {
    const states = Uint16Array.of(1, 2, 1, 1);
    expect(combineViews([split([0, 1, 2], [3])], 4, states, 1)).toEqual({ inside: [0, 2], outside: [3] });
  });
});
