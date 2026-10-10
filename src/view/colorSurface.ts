import type { BufferAttribute } from "three";
import { ColorTable } from "./colorTable";
import { rebuildStates, updateTriangleStates, updateTriangleTrees, type ObjectGeometry } from "./objectGeometry";
import { leafIndexAt, parseTree } from "../doc/splitTree";
import { TreeAtlas } from "./treeAtlas";
import type { ViewScene } from "./viewScene";

/**
 * The viewer's color path, without WebGL: the drawn objects' geometries (their `state`
 * attributes) and the color table the shader reads. `ModelViewer` delegates every color
 * change here and renders afterwards; the methods that can do nothing return false so it
 * can skip the render. DOM- and React-free, so tests drive the real thing.
 */
export class ColorSurface {
  readonly table = new ColorTable();
  /** Every object's sub-triangle trees, flattened for the shader. */
  readonly atlas = new TreeAtlas();
  private data: ViewScene | null = null;
  /** Geometry per document object index. Objects with nothing to draw may be left out. */
  private readonly geos = new Map<number, ObjectGeometry>();
  /** The pieces of split triangles the fill preview highlights. */
  private litPieces: { object: number; pieces: ReadonlyMap<number, Uint32Array> } | null = null;

  /** Starts a new scene (null clears): forgets the geometries and installs the scene's palette as the Design colors. Print colors are kept. */
  setScene(data: ViewScene | null): void {
    this.geos.clear();
    this.atlas.clear();
    this.litPieces = null;
    this.data = data;
    if (data) this.table.setDesign(data.palette);
  }

  /** Registers the geometry built for document object `objectIndex` of the current scene. */
  add(objectIndex: number, geo: ObjectGeometry): void {
    this.geos.set(objectIndex, geo);
    const trees = this.data?.objects[objectIndex]?.trees;
    if (trees && trees.size > 0) this.updateTrees(objectIndex, Array.from(trees.keys()));
  }

  /** Rewrites the given triangles' state and tree attributes from the scene's (already updated) `states` and `trees`. */
  updateTriangleStates(objectIndex: number, triIndices: ArrayLike<number>): boolean {
    const geo = this.geos.get(objectIndex);
    if (!this.data || !geo) return false;
    updateTriangleStates(geo, this.data.objects[objectIndex].states, triIndices);
    this.updateTrees(objectIndex, triIndices);
    return true;
  }

  /** Rewrites every drawn object's whole state attribute from the scene's `states`, and re-flattens every tree. */
  refreshStates(): boolean {
    if (!this.data) return false;
    this.atlas.clear();
    for (const [index, geo] of this.geos) {
      if (geo.slotCount === 0) continue;
      rebuildStates(geo, this.data.objects[index].states);
      geo.treeRoots.fill(0);
      const trees = this.data.objects[index].trees;
      if (trees && trees.size > 0) this.updateTrees(index, Array.from(trees.keys()));
      const attr = geo.geometry.getAttribute("tree") as BufferAttribute;
      attr.clearUpdateRanges(); // the whole attribute uploads
      attr.needsUpdate = true;
    }
    return true;
  }

  /** Highlights pieces of split triangles (leaf indices per triangle, a fill preview); null clears. A texture range upload. */
  highlightPieces(objectIndex: number, pieces: ReadonlyMap<number, Uint32Array> | null): void {
    if (this.litPieces) for (const tri of this.litPieces.pieces.keys()) this.atlas.highlight(this.litPieces.object, tri, null);
    this.litPieces = null;
    if (!pieces || pieces.size === 0) return;
    for (const [tri, leaves] of pieces) this.atlas.highlight(objectIndex, tri, new Set(leaves));
    this.litPieces = { object: objectIndex, pieces };
  }

  /** Whether the piece of split triangle `tri` at `bary` is highlighted. */
  isPieceHighlighted(objectIndex: number, tri: number, bary?: readonly [number, number, number]): boolean {
    const leaves = this.litPieces?.object === objectIndex ? this.litPieces.pieces.get(tri) : undefined;
    const tree = this.data?.objects[objectIndex]?.trees?.get(tri);
    if (!leaves || !bary || tree === undefined) return false;
    const leaf = leafIndexAt(parseTree(tree), [bary[0], bary[1], bary[2]]);
    return leaves.includes(leaf);
  }

  /** Stores the triangles' trees (or drops them) in the atlas and writes their tree attribute. */
  private updateTrees(objectIndex: number, triIndices: ArrayLike<number>): void {
    const geo = this.geos.get(objectIndex);
    const trees = this.data?.objects[objectIndex].trees;
    if (!geo || !this.data || !trees) return;
    for (let i = 0; i < triIndices.length; i++) {
      const tri = triIndices[i];
      if (geo.slotOfTri[tri] >= 0) this.atlas.set(objectIndex, tri, trees.get(tri));
    }
    if (this.atlas.takeCompacted()) {
      // Every tree moved: rewrite every object's roots.
      for (const [index, g] of this.geos) {
        const t = this.data.objects[index].trees;
        if (t && t.size > 0) updateTriangleTrees(g, Array.from(t.keys()), (tri) => this.atlas.rootOf(index, tri));
      }
    }
    updateTriangleTrees(geo, triIndices, (tri) => this.atlas.rootOf(objectIndex, tri));
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
    this.atlas.dispose();
  }
}
