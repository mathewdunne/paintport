import { describe, expect, it } from "vitest";
import { fitLongSide, flipRows, toPixelValues } from "./image";

describe("fitLongSide", () => {
  it("keeps the aspect with the long side at the given size", () => {
    expect(fitLongSide(1600, 900, 1024)).toEqual({ width: 1024, height: 576 });
    expect(fitLongSide(900, 1600, 1024)).toEqual({ width: 576, height: 1024 });
    expect(fitLongSide(500, 500, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(fitLongSide(5000, 1, 1024)).toEqual({ width: 1024, height: 1 });
  });
});

describe("flipRows", () => {
  it("puts the bottom row (readPixels row 0) last", () => {
    // 2 x 2: bottom row pixels 1, 2; top row pixels 3, 4
    const data = Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
    const image = flipRows(data, 2, 2);
    expect(image).toMatchObject({ width: 2, height: 2 });
    expect(Array.from(image.data)).toEqual([3, 3, 3, 3, 4, 4, 4, 4, 1, 1, 1, 1, 2, 2, 2, 2]);
  });
});

describe("toPixelValues", () => {
  it("normalizes each channel into its own plane and pads with zeros", () => {
    // 2 x 1 image (red, green) in a 2 x 2 input: row 1 is padding
    const image = { width: 2, height: 1, data: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]) };
    const out = toPixelValues(image, 2, { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] });
    expect(Array.from(out)).toEqual([1, -1, 0, 0, -1, 1, 0, 0, -1, -1, 0, 0]);
  });

  it("uses the ImageNet statistics by default", () => {
    const out = toPixelValues({ width: 1, height: 1, data: Uint8Array.from([0, 0, 0, 255]) }, 1);
    expect(out[0]).toBeCloseTo(-0.485 / 0.229);
    expect(out[2]).toBeCloseTo(-0.406 / 0.225);
  });

  it("rejects an image whose long side is not the input size", () => {
    expect(() => toPixelValues({ width: 3, height: 2, data: new Uint8Array(24) }, 4)).toThrow(/long side of 4/);
  });
});
