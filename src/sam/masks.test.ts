import { describe, expect, it } from "vitest";
import { cropToImage, fieldAt, maskCovers, maskField, maskLogit, rankCandidates } from "./masks";

describe("rankCandidates", () => {
  it("orders by score, best first, ties in the model's order", () => {
    const m = (score: number, id: number) => ({ width: 1, height: 1, logits: Float32Array.of(id), score });
    expect(rankCandidates([m(0.5, 0), m(0.9, 1), m(0.5, 2)]).map((x) => x.logits[0])).toEqual([1, 0, 2]);
  });
});

describe("cropToImage", () => {
  const logits = Float32Array.from({ length: 16 }, (_, i) => i); // 4 x 4 cells over a 16 px square input

  it("keeps the rows over a wide image", () => {
    const mask = cropToImage(logits, 4, 16, { width: 16, height: 8 }, 0.8);
    expect(mask).toMatchObject({ width: 4, height: 2, score: 0.8 });
    expect(Array.from(mask.logits)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the columns over a tall image", () => {
    const mask = cropToImage(logits, 4, 16, { width: 8, height: 16 }, 0.8);
    expect(mask).toMatchObject({ width: 2, height: 4 });
    expect(Array.from(mask.logits)).toEqual([0, 1, 4, 5, 8, 9, 12, 13]);
  });
});

describe("maskLogit and maskCovers", () => {
  const mask = { width: 2, height: 1, logits: Float32Array.of(-1, 3), score: 1 };
  const image = { width: 4, height: 2 };

  it("is the cell value at cell centers, blends between them and clamps at the border", () => {
    expect(maskLogit(mask, image, 1, 1)).toBeCloseTo(-1);
    expect(maskLogit(mask, image, 3, 1)).toBeCloseTo(3);
    expect(maskLogit(mask, image, 2, 1)).toBeCloseTo(1);
    expect(maskLogit(mask, image, 0, 0)).toBeCloseTo(-1);
  });

  it("covers where the blended logit is positive, and never outside the image", () => {
    expect(maskCovers(mask, image, 1.5, 1)).toBe(false); // logit exactly 0
    expect(maskCovers(mask, image, 2.5, 1)).toBe(true);
    expect(maskCovers(mask, image, 4, 1)).toBe(false);
    expect(maskCovers(mask, image, -0.1, 1)).toBe(false);
  });
});

describe("maskField", () => {
  // 8 cells of 1 px in a row: two parts, cells 1-2 and 5-7.
  const mask = { width: 8, height: 1, logits: Float32Array.of(-1, 1, 1, -1, -1, 1, 1, 1), score: 1 };
  const image = { width: 8, height: 1 };
  const row = (field: { distance: Float32Array }) => Array.from(field.distance, (d) => Math.round(d * 10) / 10);

  it("gives the signed distance to the edge, not counting the image border as an edge", () => {
    expect(row(maskField(mask, image, []))).toEqual([-1, 1, 1, -1, -1, 1, 2, 3]);
  });

  it("keeps only the parts that hold a point", () => {
    const field = maskField(mask, image, [{ x: 1.5, y: 0.5 }]);
    expect(row(field)).toEqual([-1, 1, 1, -1, -2, -3, -4, -5]);
    expect(field.depth).toBe(1);
  });

  it("keeps the whole mask when no part holds a point", () => {
    expect(row(maskField(mask, image, [{ x: 3.5, y: 0.5 }]))).toEqual([-1, 1, 1, -1, -1, 1, 2, 3]);
  });

  it("reads the pixel under a position and is -Infinity outside the image", () => {
    const field = maskField(mask, image, []);
    expect(fieldAt(field, 6.9, 0.2)).toBe(2);
    expect(fieldAt(field, 8, 0)).toBe(-Infinity);
  });
});
