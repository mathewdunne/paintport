import { describe, expect, it } from "vitest";
import { applyTransform, parseTransform } from "../core";
import { objectSpaceSphere } from "./transform";

describe("objectSpaceSphere", () => {
  it("leaves the sphere alone without a transform", () => {
    expect(objectSpaceSphere(null, [1, 2, 3], 4)).toEqual({ center: [1, 2, 3], radius: 4 });
  });

  it("undoes a translation", () => {
    const r = objectSpaceSphere("1 0 0 0 1 0 0 0 1 10 20 30", [11, 22, 33], 2);
    expect(r.center).toEqual([1, 2, 3]);
    expect(r.radius).toBe(2);
  });

  it("inverts a rotation with scale and translation: world -> object lands where the forward transform came from", () => {
    // 90 degrees about z, scale 2, then translate: row-vector convention, as in 3MF.
    const t = "0 2 0 -2 0 0 0 0 2 5 6 7";
    const local: [number, number, number] = [1, 2, 3];
    const world = applyTransform(parseTransform(t), ...local);
    const r = objectSpaceSphere(t, world, 4);
    r.center.forEach((v, i) => expect(v).toBeCloseTo(local[i], 12));
    expect(r.radius).toBeCloseTo(2, 12);
  });

  it("ignores a singular transform", () => {
    expect(objectSpaceSphere("1 0 0 0 0 0 0 0 0 0 0 0", [1, 2, 3], 4)).toEqual({ center: [1, 2, 3], radius: 4 });
  });
});
