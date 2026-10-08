import { ColorTable } from "./colorTable";
import { rebuildStates, updateTriangleStates, type ObjectGeometry } from "./objectGeometry";
import type { ViewScene } from "./viewScene";

/**
 * The viewer's color path, without WebGL: the drawn objects' geometries (their `state`
 * attributes) and the color table the shader reads. `ModelViewer` delegates every color
 * change here and renders afterwards; the methods that can do nothing return false so it
 * can skip the render. DOM- and React-free, so tests drive the real thing.
 */
export class ColorSurface {
  readonly table = new ColorTable();
  private data: ViewScene | null = null;
  /** Geometry per document object index. Objects with nothing to draw may be left out. */
  private readonly geos = new Map<number, ObjectGeometry>();

  /** Starts a new scene (null clears): forgets the geometries and installs the scene's palette as the Design colors. Print colors are kept. */
  setScene(data: ViewScene | null): void {
    this.geos.clear();
    this.data = data;
    if (data) this.table.setDesign(data.palette);
  }

  /** Registers the geometry built for document object `objectIndex` of the current scene. */
  add(objectIndex: number, geo: ObjectGeometry): void {
    this.geos.set(objectIndex, geo);
  }

  /** Rewrites the given triangles' state attribute from the scene's (already updated) `states`. */
  updateTriangleStates(objectIndex: number, triIndices: ArrayLike<number>): boolean {
    const geo = this.geos.get(objectIndex);
    if (!this.data || !geo) return false;
    updateTriangleStates(geo, this.data.objects[objectIndex].states, triIndices);
    return true;
  }

  /** Rewrites every drawn object's whole state attribute from the scene's `states`. */
  refreshStates(): boolean {
    if (!this.data) return false;
    for (const [index, geo] of this.geos) {
      if (geo.slotCount > 0) rebuildStates(geo, this.data.objects[index].states);
    }
    return true;
  }

  /** Installs the Design colors: a texture upload, never an attribute write. */
  setPalette(palette: string[]): boolean {
    if (!this.data) return false;
    this.data.palette = palette;
    this.table.setDesign(palette);
    return true;
  }

  /** Shows the Print colors, or the Design colors for null. A texture upload. */
  setPrintColors(colors: readonly (string | undefined)[] | null): void {
    this.table.setPrint(colors);
  }

  dispose(): void {
    this.table.dispose();
  }
}
