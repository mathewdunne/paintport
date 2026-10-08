import { parseTransform } from "../core";
import type { Vec3 } from "./paintField";

/**
 * Brush sphere from world space to the object's mesh space, which is where
 * `PaintField.paintSphere` works. `transform` is the object's build-item transform
 * (`ProjectObject.transform`; the viewer applies it to the vertices). The radius is divided
 * by the transform's mean scale, so a non-uniform scale gives an approximation. A missing
 * or singular transform leaves the sphere unchanged.
 */
export function objectSpaceSphere(transform: string | null, center: Vec3, radius: number): { center: Vec3; radius: number } {
  const t = parseTransform(transform);
  if (!t) return { center, radius };
  // Row-vector convention: world = local * M + T, so local = (world - T) * M^-1.
  const [a, b, c, d, e, f, g, h, i] = t;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return { center, radius };
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const x = center[0] - t[9], y = center[1] - t[10], z = center[2] - t[11];
  return {
    center: [
      x * inv[0] + y * inv[3] + z * inv[6],
      x * inv[1] + y * inv[4] + z * inv[7],
      x * inv[2] + y * inv[5] + z * inv[8],
    ],
    radius: radius / Math.cbrt(Math.abs(det)),
  };
}
