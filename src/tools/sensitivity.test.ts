import { describe, expect, it } from "vitest";
import { angleToSensitivity, clampSmartScale, DEFAULT_SMART_ANGLE, sensitivityToAngle } from "./sensitivity";

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
});
