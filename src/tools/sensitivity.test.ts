import { describe, expect, it } from "vitest";
import { angleToSensitivity, clampSmartScale, DEFAULT_SMART_ANGLE, sensitivityToAngle, sensitivityToScale } from "./sensitivity";

describe("edge sensitivity", () => {
  it("puts the default angle in the middle, loose angles low and strict ones high", () => {
    expect(sensitivityToAngle(0.5)).toBe(DEFAULT_SMART_ANGLE);
    expect(sensitivityToAngle(0)).toBe(60);
    expect(sensitivityToAngle(1)).toBe(5);
    expect(angleToSensitivity(DEFAULT_SMART_ANGLE)).toBe(0.5);
  });

  it("lowers the angle steadily as the sensitivity rises", () => {
    let previous = Infinity;
    for (let i = 0; i <= 100; i++) {
      const angle = sensitivityToAngle(i / 100);
      expect(angle).toBeLessThan(previous);
      previous = angle;
    }
  });

  it("round-trips slider positions", () => {
    for (let i = 0; i <= 100; i++) expect(Math.round(angleToSensitivity(sensitivityToAngle(i / 100)) * 100)).toBe(i);
  });

  it("pins angles outside its range to its ends, and survives bad input", () => {
    expect(angleToSensitivity(90)).toBe(0);
    expect(angleToSensitivity(0)).toBe(1);
    expect(angleToSensitivity(Number.NaN)).toBe(0.5);
    expect(sensitivityToAngle(Number.NaN)).toBe(DEFAULT_SMART_ANGLE);
    expect(sensitivityToAngle(2)).toBe(5);
  });

  it("keeps a manual feature size on the slider and anything else automatic", () => {
    expect(clampSmartScale(0.35)).toBe(0.35);
    expect(clampSmartScale(5)).toBe(1);
    expect(clampSmartScale(-1)).toBe(0);
    expect(clampSmartScale(null)).toBeNull();
    expect(clampSmartScale(Number.NaN)).toBeNull();
  });

  it("keeps the automatic feature size in the middle and adjusts it continuously at the extremes", () => {
    for (const auto of [0, 0.2, 0.74, 1.5]) {
      for (const position of [0.25, 0.5, 0.75]) expect(sensitivityToScale(position, auto)).toBe(auto);
      expect(sensitivityToScale(0, auto)).toBe(Math.max(1, auto));
      expect(sensitivityToScale(1, auto)).toBe(0);
      expect(sensitivityToScale(0.125, auto)).toBeCloseTo((auto + Math.max(1, auto)) / 2);
      expect(sensitivityToScale(0.875, auto)).toBeCloseTo(auto / 2);
      let previous = Infinity;
      for (let i = 0; i <= 100; i++) {
        const scale = sensitivityToScale(i / 100, auto);
        expect(scale).toBeLessThanOrEqual(previous);
        previous = scale;
      }
      expect(sensitivityToScale(0.25 - 1e-8, auto)).toBeCloseTo(auto);
      expect(sensitivityToScale(0.75 + 1e-8, auto)).toBeCloseTo(auto);
    }
  });

  it("clamps feature size sensitivity and treats invalid positions as the default", () => {
    expect(sensitivityToScale(-1, 0.2)).toBe(1);
    expect(sensitivityToScale(2, 0.2)).toBe(0);
    expect(sensitivityToScale(Number.NaN, 0.2)).toBe(0.2);
  });
});
