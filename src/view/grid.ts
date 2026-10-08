import { Box3, Color, GridHelper, LineBasicMaterial } from "three";

/** 1-2-5 step so that roughly 8 cells span `extent`. */
export function niceStep(extent: number): number {
  const raw = Math.max(extent, 1e-6) / 8;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
}

const LIGHT_LINE = new Color(0x000000);
const DARK_LINE = new Color(0xffffff);

export function gridLineColor(dark: boolean): Color {
  return dark ? DARK_LINE : LIGHT_LINE;
}

/**
 * Subtle ground grid in the XY plane (Z is up), aligned to the world origin and sized
 * to the model. It sits at z = 0, or below the model if the model reaches under z = 0.
 */
export function createGrid(bounds: Box3, dark: boolean): GridHelper {
  const extent = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y);
  const step = niceStep(extent);
  const half = Math.min(100, Math.max(5, Math.ceil((extent * 1.2) / step / 2) + 1)); // cells per side
  const grid = new GridHelper(half * 2 * step, half * 2, 0xffffff, 0xffffff);
  grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; we want XY
  grid.position.set(
    Math.round((bounds.min.x + bounds.max.x) / 2 / step) * step,
    Math.round((bounds.min.y + bounds.max.y) / 2 / step) * step,
    Math.min(0, bounds.min.z),
  );
  const material = grid.material as LineBasicMaterial;
  material.transparent = true;
  material.opacity = 0.14;
  material.depthWrite = false;
  material.color.copy(gridLineColor(dark));
  return grid;
}

export function setGridTheme(grid: GridHelper, dark: boolean): void {
  (grid.material as LineBasicMaterial).color.copy(gridLineColor(dark));
}
