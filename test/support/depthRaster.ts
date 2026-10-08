// Software stand-ins for the GPU: a depth rasterizer that produces the same image the
// viewer's depth pass does (view/depthPass.ts), and small triangle-soup meshes with
// outward counter-clockwise winding. Lets the visible-only brush logic run in Node.
import { PerspectiveCamera, Vector3 } from "three";
import { ALPHA_BACK, ALPHA_FRONT, encodeDepth, type DepthFrame, type DepthView } from "../../src/view/visibility";

/** Triangle soup: 9 numbers per triangle. */
export type Soup = number[];

/** Axis-aligned box with each face split into n x n quads (2 n^2 triangles per face), outward CCW. */
export function gridBox(min: [number, number, number], max: [number, number, number], n = 1): Soup {
  const out: Soup = [];
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  // Each face: origin, u axis, v axis, with u x v pointing outward.
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const faces: [number[], number[], number[]][] = [
    [[x1, y0, z0], [0, dy, 0], [0, 0, dz]], // +x
    [[x0, y1, z0], [0, -dy, 0], [0, 0, dz]], // -x
    [[x0, y1, z0], [0, 0, dz], [dx, 0, 0]], // +y
    [[x0, y0, z0], [dx, 0, 0], [0, 0, dz]], // -y
    [[x0, y0, z1], [dx, 0, 0], [0, dy, 0]], // +z
    [[x0, y0, z0], [0, dy, 0], [dx, 0, 0]], // -z
  ];
  for (const [o, u, v] of faces) {
    const at = (i: number, j: number) => [o[0] + (u[0] * i + v[0] * j) / n, o[1] + (u[1] * i + v[1] * j) / n, o[2] + (u[2] * i + v[2] * j) / n];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  }
  return out;
}

/** UV sphere with outward CCW winding. */
export function uvSphere(center: [number, number, number], radius: number, rings: number, segments: number): Soup {
  const pt = (r: number, s: number) => {
    const phi = (Math.PI * r) / rings, theta = (2 * Math.PI * (s % segments)) / segments;
    return [
      center[0] + radius * Math.sin(phi) * Math.cos(theta),
      center[1] + radius * Math.sin(phi) * Math.sin(theta),
      center[2] + radius * Math.cos(phi),
    ];
  };
  const out: Soup = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = pt(r, s), b = pt(r, s + 1), c = pt(r + 1, s), d = pt(r + 1, s + 1);
      if (r > 0) out.push(...a, ...c, ...b); // theta grows counter-clockwise seen from +z; phi grows downward
      if (r < rings - 1) out.push(...b, ...c, ...d);
    }
  }
  return out;
}

export function lookAtCamera(eye: [number, number, number], target: [number, number, number], aspect: number, up: [number, number, number] = [0, 0, 1]): PerspectiveCamera {
  const camera = new PerspectiveCamera(45, aspect, 1, 2000);
  camera.up.set(...up);
  camera.position.set(...eye);
  camera.lookAt(new Vector3(...target));
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

export function depthViewOf(camera: PerspectiveCamera): DepthView {
  return {
    view: Array.from(camera.matrixWorldInverse.elements),
    proj: Array.from(camera.projectionMatrix.elements),
    eye: [camera.position.x, camera.position.y, camera.position.z],
  };
}

/** What the depth pass draws, computed on the CPU. Triangles must be entirely in front of the near plane. */
export function rasterizeDepth(soup: ArrayLike<number>, camera: PerspectiveCamera, width: number, height: number): DepthFrame {
  const data = new Uint8Array(width * height * 4);
  const best = new Float64Array(width * height).fill(Infinity);
  const v = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
  const { near, far } = camera;
  const sx = new Float64Array(3), sy = new Float64Array(3), sd = new Float64Array(3);
  for (let t = 0; t < soup.length; t += 9) {
    let behind = false;
    for (let k = 0; k < 3; k++) {
      const x = soup[t + k * 3], y = soup[t + k * 3 + 1], z = soup[t + k * 3 + 2];
      const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
      const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
      const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
      const d = -vz;
      if (d <= near) behind = true;
      sx[k] = ((p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / d * 0.5 + 0.5) * width;
      sy[k] = ((p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / d * 0.5 + 0.5) * height;
      sd[k] = d;
    }
    if (behind) continue;
    const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
    if (area === 0) continue;
    const alpha = area > 0 ? ALPHA_FRONT : ALPHA_BACK;
    const minX = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
    const minY = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const qx = px + 0.5, qy = py + 0.5;
        const l0 = ((sx[1] - qx) * (sy[2] - qy) - (sx[2] - qx) * (sy[1] - qy)) / area;
        const l1 = ((sx[2] - qx) * (sy[0] - qy) - (sx[0] - qx) * (sy[2] - qy)) / area;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const d = 1 / (l0 / sd[0] + l1 / sd[1] + l2 / sd[2]); // perspective-correct linear depth
        const i = py * width + px;
        if (d >= best[i]) continue;
        best[i] = d;
        const [r, g, b] = encodeDepth((d - near) / (far - near));
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = alpha;
      }
    }
  }
  return { width, height, data, near, far };
}
