# Sub-triangle painting (phase 5, option 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The brush and eraser paint below triangle resolution by growing PrusaSlicer/Bambu
TriangleSelector trees ("Split triangles", on by default). The viewer draws the pieces
exactly, hover/eyedropper read the piece under the cursor, and every fill floods piece by
piece so it stops exactly at a brushed line.

**Architecture:** Trees stay where imported trees already live: `TrianglePaintField.preserved`
(design states, "bbs" dialect, undo/export/autosave/sidecar unchanged). A new DOM-free
`splitTree.ts` holds the verified geometry and tree edits. Fills run on a lazy `PieceGraph`:
triangles are nodes, and a split triangle is replaced by its leaves, which are linked inside
the triangle and across its edges by the leaf intervals that touch each edge. The viewer
flattens all trees into one `R32UI` texture and walks them in the fragment shader (spike:
exact, no measurable cost).

**Tech Stack:** TypeScript, Vitest, three.js 0.186 (WebGL2, `onBeforeCompile` patches),
React + shadcn for the checkbox.

**Spec:** `docs/PLUS_SPEC.md` section 3 ("Split triangles"), Q12.0–Q12.7; geometry in
`docs/FORMAT.md` 2a; spike report `docs/plans/2026-10-09-subtriangle-spike.md` (prototype
code in `spike/subtri/`: `splitGeometry.ts`, `brush.ts`, `flatten.ts`, `view.ts`).

## Global Constraints

- `src/core/`, `src/formats/`, `src/doc/` stay free of DOM, React and three.js.
- UI strings live in `src/strings.ts`; English only.
- Export of untouched projects stays byte-identical (`src/doc/exportParity.test.ts`).
- The sidecar rejects trees longer than 65,536 characters (`MAX_TREE_CHARS`): a tree the
  brush grows must stay below it (leaf budget, Task 1).
- Paint settings persist in `paintportplus.paint` (localStorage); new keys need defaults so
  old stored values still load.
- The Print view is view-only (no change needed: the brush is already off there).
- No runtime network requests; nothing new is fetched.
- Don't copy slicer code (AGPL-3.0 reimplementation; the geometry came from a prose
  description).
- The user commits; the executor doesn't (Q12.6: built straight through, one check-in).

## File structure

| File | Responsibility |
|---|---|
| `src/doc/splitTree.ts` (new) | Child-order trees: parse/emit, verified child geometry, leaves, state at a point, sphere paint with leaf budget, paint selected leaves, dominant and leaf states |
| `src/doc/pieces.ts` (new) | Per-tree piece data (leaf adjacency, edge contacts) and the lazy `PieceGraph` the fills walk; `Region` type |
| `src/doc/trianglePaintField.ts` | Split brush, `paintRegion`, `treeOf`, bary `stateAt`, leaf-state cache |
| `src/doc/paintField.ts` | Interface additions (`split` brush option, `treeOf`, `paintRegion`, `leafStates`) |
| `src/doc/project.ts`, `display.ts` | Region API, bary-aware `stateShownAt`, `colorUsage` counts leaves, view states |
| `src/doc/fill.ts`, `guidedFill.ts`, `featureField.ts` | Algorithms walk `PieceGraph` nodes instead of triangles |
| `src/view/treeAtlas.ts` (new) | Flattened node buffer for all objects, partial uploads, leaf highlight bits |
| `src/view/material.ts`, `objectGeometry.ts`, `colorSurface.ts`, `projectSync.ts`, `projectScene.ts`, `viewScene.ts`, `picking.ts`, `ModelViewer.ts` | Tree attribute, fragment walk, sync, bary picking, piece highlight |
| `src/tools/types.ts`, `PaintController.ts`, `aiPaint.ts` | `splitTriangles` setting, split limit, seeds with bary, regions |
| `src/persist/paintSettings.ts`, `src/ui/SidePanel.tsx`, `src/strings.ts` | The checkbox |

---

### Task 1: `splitTree.ts`, the tree model

**Files:**
- Create: `src/doc/splitTree.ts`, `src/doc/splitTree.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Bary = [number, number, number];
  export type BaryTri = [Bary, Bary, Bary];
  export type TreeNode = { state: number } | { splitSides: 1 | 2 | 3; special: 0 | 1 | 2; children: TreeNode[] }; // CHILD order
  export const MAX_TREE_LEAVES = 16384;
  export function parseTree(str: string): TreeNode;            // internal dialect, reverses children
  export function emitTree(node: TreeNode): string;            // internal dialect
  export function childCorners(v: BaryTri, sides: number, special: number): BaryTri[];
  export function treeLeaves(root: TreeNode): { tri: BaryTri; state: number }[]; // DFS, child order = leaf index
  export function leafIndexAt(root: TreeNode, p: Bary): number;
  export function stateAtBary(root: TreeNode, p: Bary): number;
  export function paintSphereTree(root: TreeNode, corners: readonly [Vec3, Vec3, Vec3], center: Vec3, radius: number, state: number, limit: number): TreeNode;
  export function paintTreeLeaves(root: TreeNode, leaves: ReadonlySet<number>, state: number): TreeNode;
  export function treeDominant(root: TreeNode): number;        // leaf count, ties to the higher state (remapTree's rule)
  export function addLeafStates(root: TreeNode, into: Set<number>): void; // states > 0
  export const isLeaf: (n: TreeNode) => n is { state: number };
  ```

- [ ] **Step 1: Tests first** (`splitTree.test.ts`):
  - Geometry matches FORMAT.md 2a: `childCorners(ROOT, 1, 0)` gives `[[A,B,M_BC],[M_BC,C,A]]`; `(2, 1)` rotates to start at B; `(3, 0)` four children with the centre last.
  - PrusaSlicer ground truth: the spike's slab tree (child order)
    `split(3,0,[leaf2, split(1,1,[leaf1,leaf2]), split(2,2,[leaf2,leaf1,split(1,0,[leaf2,leaf1])]), leaf1])`
    emits `"848584841A43"` in the prusa dialect (states ≤ 2, so bbs is the same) and
    `stateAtBary` gives 2 at the centroid of child 0 (`[2/3,1/6,1/6]`) and 1 at child 3's
    centroid (`[1/6, 1/6, 2/3]` lies in child 2 → check against `treeLeaves`): assert
    `stateAtBary(t, centroid(l.tri)) === l.state` for every leaf.
  - `parseTree(emitTree(t))` round-trips; `emitTree(parseTree(s)) === s` for real-file style
    strings (`"848584841A43"`).
  - `paintSphereTree` on a leaf: a sphere containing all corners returns `{state}`; a sphere
    missing the triangle returns the input unchanged (same object); a crossing sphere
    returns a split tree whose every leaf with centroid inside has the state and with the
    longest side ≤ limit for leaves crossing the sphere surface.
  - Erasing with a slightly larger sphere merges back to `{ state: 0 }` (spike test).
  - Budget: painting a 100 mm triangle with `limit = 0.001` stops growing: `treeLeaves(t).length <= MAX_TREE_LEAVES` and `emitTree(t).length < 65536`.
  - `paintTreeLeaves` sets the chosen leaves and merges equal siblings; painting every leaf
    gives a single leaf.
  - `treeDominant` of `split(3,0,[1,1,2,2])` is 2 (tie to the higher state).
- [ ] **Step 2:** Run `npx vitest run src/doc/splitTree.test.ts`: fails (module missing).
- [ ] **Step 3: Implement.** Geometry and walk as in `spike/subtri/splitGeometry.ts` (rule
  `PRUSA`, child order, so no `reversed` flag). `paintSphereTree` as in `spike/subtri/brush.ts`
  plus:
  - a running leaf count: when the tree already has `MAX_TREE_LEAVES` leaves, a crossing
    leaf is not split further but decided by its centroid;
  - return the input node object unchanged when nothing changed (callers compare by identity
    to skip the triangle);
  - merge equal leaf siblings bottom-up.
  `parseTree`/`emitTree` wrap the codec (`parsePaintTree(str, INTERNAL_DIALECT)` +
  recursive child reversal). `leafIndexAt` walks like `stateAtBary` and counts the leaves of
  skipped children (subtree leaf counts computed on the way).
- [ ] **Step 4:** Tests pass; `npm run typecheck`.

### Task 2: the field paints trees

**Files:**
- Modify: `src/doc/paintField.ts`, `src/doc/trianglePaintField.ts`
- Test: `src/doc/splitPaint.test.ts` (new)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  // paintField.ts
  export interface BrushOpts { candidates?; candidatesExact?; /** Grow trees instead of painting crossed triangles whole: pieces down to `limit` (object units). */ split?: { limit: number } }
  export interface Region { tris: Uint32Array; /** split triangle -> leaf indices (child-order DFS) to paint */ pieces: ReadonlyMap<number, Uint32Array> }
  PaintFieldView.stateAt(tri, bary?)      // walks the tree when there is one (leaf 0 = unpainted)
  PaintFieldView.treeOf(tri): string | undefined
  PaintFieldView.leafStates(tri): ReadonlySet<number> | undefined // states > 0 in the tree, cached per tree string
  PaintField.paintRegion(region: Region, state: State): EditRecord
  ```
- [ ] **Step 1: Tests** (`splitPaint.test.ts`, on `TrianglePaintField` over a 2-triangle
  10×10 mm quad and `cubeMesh()`):
  - `paintSphere(center, r, 2, { split: { limit: 0.5 } })` on a quad corner: the touched
    triangle gets a tree (`treeOf` defined), `states[t]` is its dominant, `stateAt(t, bary)`
    is 2 inside the sphere and 0 outside.
  - Without `split`: same call paints whole triangles and drops trees (old behaviour, the
    existing `paintSphere` tests still pass unchanged).
  - A triangle whose 3 corners are inside the sphere is painted whole with `split` too (no tree).
  - Undo/redo restore the tree strings exactly; `mergeEdits` across 3 dabs undoes as one.
  - A stroke whose result is uniform collapses: no tree left.
  - `paintRegion({ tris: [1], pieces: new Map([[0, leafIdx]]) }, 3)` paints triangle 1 whole and
    only those leaves of triangle 0.
  - `leafStates` reflects the current tree and updates after an edit; `remap` keeps working
    (existing tests).
- [ ] **Step 2:** fails.
- [ ] **Step 3: Implement** in `TrianglePaintField`:
  - `paintSphere`: per candidate `t` (paintable): if `split` is absent, or all 3 corners
    are within `radius` of `center` → collect for `paintTriangles` (as now). Otherwise
    `before = tree ?? {state: states[t]}`, `after = paintSphereTree(before, corners, …)`.
    Skip if `after === before`. Record it.
  - A shared private `applyTreeEdits(entries: {t, state, tree?}[])` builds one `DiffEdit`
    (per-triangle `after` array, `preservedBefore/After`), sets `states[t]` to the leaf state
    or the tree's dominant, and sets/deletes `preserved`. `paintSphere` returns
    `mergeEdits([whole, trees])` when both are non-empty.
  - `paintRegion`: whole triangles through `paintTriangles`; piece entries through
    `paintTreeLeaves` + `applyTreeEdits`; merged.
  - `leafStates`: `Map<tri, { tree: string; states: Set<number> }>` cache, checked by string
    equality.
  - Update the class comment: `preserved` now holds every tree, imported or painted.
- [ ] **Step 4:** Tests pass, plus `npx vitest run src/doc`.

### Task 3: project API, usage, display states

**Files:**
- Modify: `src/doc/project.ts`, `src/doc/display.ts`
- Test: `src/doc/project.test.ts`, `src/doc/display.test.ts` (new, small)

**Interfaces:**
- Produces:
  ```ts
  Project.paintSphere(object, center, radius, state, opts?: BrushOpts)   // opts.split passes through
  Project.paintRegion(object, region: Region, state): number
  Project.stateShownAt(object, tri, bary?): State    // leaf 0 -> part base
  resolveTriangleState(project, object, tri, bary?)
  /** What the viewer's state attribute holds: the shown state, or for a split triangle its part's base (the shader draws the pieces and uses this for unpainted leaves). */
  resolveViewState(project, object, tri): State
  resolveViewStates(project, object): Uint16Array
  ```
- [ ] **Step 1: Tests:**
  - `colorUsage()` counts a color used only inside a tree (dominant is something else) as
    painted (≥ 1).
  - `stateShownAt(0, t, bary)` returns the leaf's state, and the part base for a leaf 0.
  - `resolveViewState` is the base for a split triangle and `resolveTriangleState` otherwise.
  - `paintRegion` emits one `paint` event with the touched triangles and is one undo step.
- [ ] **Step 2:** fails. **Step 3:** implement. `colorUsage`: for a triangle with a tree,
  add 1 to `painted` for every state in `leafStates(t)` and to `base` if the tree has a 0
  leaf. **Step 4:** pass; `npx vitest run src/doc`.

### Task 4: the "Split triangles" setting and the brush

**Files:**
- Modify: `src/tools/types.ts`, `src/tools/PaintController.ts`, `src/persist/paintSettings.ts`,
  `src/ui/usePaintSettings.ts` (if it lists keys), `src/ui/SidePanel.tsx`, `src/strings.ts`
- Test: `src/tools/PaintController.test.ts`, `src/persist/paintSettings.test.ts`

**Interfaces:**
- Produces: `PaintSettings.splitTriangles: boolean` (default `true`);
  `export function splitLimit(radiusWorld: number): number` = `Math.max(radiusWorld / 8, 0.1)` (world mm, in `PaintController.ts` next to the dab).
- [ ] **Step 1: Tests:**
  - Brush dab with `splitTriangles: true` on a big quad (10 mm, radius 1) leaves a tree on the
    hit triangle; `false` paints it whole.
  - The dab passes `split.limit` in object units: under transform scale 2, limit = `max(r/8, 0.1)/2`
    (spy on `project.paintSphere` like the existing smart-fill scale tests).
  - Eraser and Shift-erase use the same setting.
  - `paintSettings` round-trips `splitTriangles` and defaults it to `true` for stored values without it.
- [ ] **Step 2:** fails. **Step 3:** implement: in `dab`, add
  `split: settings.splitTriangles ? { limit: sphereFor(splitLimit(radius)).radius } : undefined`
  (object-space conversion via `objectSpaceSphere`). Checkbox (`Checkbox` from
  `@/components/ui/checkbox` if present, else the existing `Switch`, labelled like PrusaSlicer)
  directly under the Brush size slider: label `strings.panel.splitTriangles = "Split triangles"`,
  hint `"Paint finer than the model's triangles at the brush edge, as PrusaSlicer does."`.
- [ ] **Step 4:** pass.

### Task 5: viewer draws trees

**Files:**
- Create: `src/view/treeAtlas.ts`, `src/view/treeAtlas.test.ts`
- Modify: `src/view/viewScene.ts`, `projectScene.ts`, `projectSync.ts`, `objectGeometry.ts`,
  `colorSurface.ts`, `material.ts`, `ModelViewer.ts`
- Test: `src/view/colorSurface.test.ts`, `src/view/projectSync.test.ts`, `src/view/material` (string patch test exists? extend `colorTable.test.ts` or add `material.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  // viewScene.ts
  ViewObject.trees: ReadonlyMap<number, string>   // live: the field's trees (design states, internal dialect)
  // treeAtlas.ts (DOM-free data + a three DataTexture)
  export const SPLIT_BIT = 0x80000000, HIGHLIGHT_BIT = 0x40000000;
  export class TreeAtlas {
    readonly texture: DataTexture;                  // R32UI, width 4096
    /** Flattens (or removes, tree undefined) a triangle's tree; returns its root index + 1, or 0. */
    set(object: number, tri: number, tree: string | undefined): number;
    /** Sets/clears the highlight bit on the given leaves (null = none) of a stored tree. */
    highlight(object: number, tri: number, leaves: ReadonlySet<number> | null): void;
    /** True when garbage was compacted: every root index changed and the caller must rewrite all tree attributes (`rootOf`). */
    readonly compacted: boolean;
    rootOf(object: number, tri: number): number;    // root + 1, 0 = none
    clear(): void;
  }
  // objectGeometry.ts
  ObjectGeometry.treeRoots: Float32Array          // the `tree` attribute (0 = none, else root + 1)
  export function updateTriangleTrees(g, tris: ArrayLike<number>, rootOf: (tri: number) => number): void
  ```
- [ ] **Step 1: Tests:**
  - `TreeAtlas`: a CPU walk over `atlas` data (copy of the spike's `walk`) answers like
    `stateAtBary` on random points for real-style trees; `set(…, undefined)` frees; leaf
    order of `highlight` matches `treeLeaves` indices; growth past one texture row keeps
    earlier roots valid; compaction keeps every tree answerable through the new roots.
  - `ColorSurface`: after a scene with a tree triangle, its `tree` attribute is non-zero on
    all 3 vertices and its `state` attribute holds the part base; a paint update that drops
    the tree zeroes the attribute.
  - `projectSync`: a split brush dab updates `states` (base for the split triangle) and the
    tree attribute; a base color change rewrites the split triangle's `state` too; a palette
    renumbering rebuilds the atlas.
  - `patchVertexShader`/new `patchFragmentShader` contain the walk and throw if three's
    chunks are missing (like the existing guard).
- [ ] **Step 2:** fails. **Step 3: Implement:**
  - Shader (from `spike/subtri/view.ts`): vertex adds `attribute float tree;`,
    `flat varying highp uint vPpTree, vPpBase; varying vec3 vPpBary;`, `vPpBary` from
    `gl_VertexID % 3`. Fragment, after `#include <color_fragment>`: when `vPpTree > 0u` walk
    from `vPpTree - 1u`; `state = leaf & 0xFFFF`, `0` → `vPpBase`; color =
    `ppSrgbToLinear(texelFetch(ppColorTable, …))`, highlight from `HIGHLIGHT_BIT` with the
    same mix as the vertex path (respecting the `highlight` option); write `diffuseColor.rgb`.
    Uniform `ppTreeNodes` (`usampler2D`). Cache key bumps.
  - `ColorSurface` owns the `TreeAtlas`; `add`/`updateTriangleStates` call
    `atlas.set` for each triangle from `scene.objects[i].trees.get(tri)` and write
    `treeRoots`; on `compacted` rewrite all objects' tree attributes. Partial texture upload:
    `texture.addUpdateRange(firstWord, count)` + `needsUpdate`; a reallocation (more rows)
    replaces `texture.image` and uploads whole.
  - `projectScene`: `states: resolveViewStates`, `trees: field.preserved` (through a new
    `PaintFieldView.trees(): ReadonlyMap<number,string>` accessor, not a cast).
  - `projectSync`: `paint` uses `resolveViewState`; `base` rewrites triangles with no paint
    **or a tree**; `palette` renumber → `viewer.refreshStates()` re-flattens all trees.
- [ ] **Step 4:** pass; `npm run typecheck`.

### Task 6: picking returns the barycentric point; hover and eyedropper read pieces

**Files:**
- Modify: `src/view/picking.ts`, `src/view/ModelViewer.ts`, `src/tools/types.ts`,
  `src/tools/PaintController.ts`, `src/tools/aiPaint.ts`
- Test: `src/view/picking.test.ts`, `src/tools/PaintController.test.ts`

**Interfaces:**
- Produces: `SurfaceHit.bary` and `PickHit.bary: [number, number, number]` (in the document
  triangle's corner order, from the world-space slot corners: slot vertex k = document corner k).
- [ ] **Step 1: Tests:** picking a known point returns its bary (sums to 1, matches); the
  eyedropper on a split triangle picks the leaf's state on either side of a brushed edge;
  the "no preview where a fill changes nothing" rule uses the piece's state.
- [ ] **Step 2:** fails. **Step 3:** implement; every `resolveTriangleState(project, o, tri)`
  call in tools passes `hit.bary`; the FakeView in tests returns a bary.
- [ ] **Step 4:** pass.

### Task 7: `PieceGraph`

**Files:**
- Create: `src/doc/pieces.ts`, `src/doc/pieces.test.ts`

**Interfaces:**
- Consumes: Task 1, `MeshTopology` (`neighbors`, `nonManifoldLinks`, `duplicateOf`,
  `faceNormals()`), `DisplayView`.
- Produces:
  ```ts
  export interface Seed { tri: number; bary?: Bary }       // no bary: the triangle's centroid
  export class PieceGraph {
    constructor(topology: MeshTopology, display: DisplayView, trees: { treeOf(tri: number): string | undefined });
    readonly triCount: number;                     // node ids < triCount are triangles
    nodeCount(): number;                           // grows as split triangles are expanded
    nodeOf(seed: Seed): number;                    // -1 if not paintable
    triOf(node: number): number;
    stateOf(node: number): number;                 // leaf 0 / unpainted -> part base
    area(node: number): number;                    // object units²
    centroid(node: number, out: Float64Array, at: number): void;
    /** Writes neighbour nodes and their crossing codes (topology neighbour code, or -1 inside one triangle) into the buffers; returns the count. Split neighbours expand into the leaves touching the shared edge with positive overlap. Non-manifold edges choose the face as `edgeNeighbors` does. */
    neighbors(node: number, out: NodeBuffer): number;
    isTriangleNode(node: number): boolean;         // false for leaves and for a split triangle itself (never a node)
    toRegion(nodes: ArrayLike<number>): Region;
  }
  export class NodeBuffer { nodes: Int32Array; codes: Int32Array; ensure(n: number): void }
  ```
  Per-tree data (cached in a module `WeakMap<MeshTopology, Map<number, {tree: string, data}>>`):
  leaves' bary triangles, states, area fraction, CSR adjacency between leaves (sharing a
  segment of positive length), and per root edge `k` the sorted contacts `(s0, s1, leaf)`
  with `s` measured from corner `k` toward corner `k+1`.
- [ ] **Step 1: Tests:**
  - A tree split once (3 sides): the centre leaf is adjacent to the 3 corner leaves; corner
    leaves aren't adjacent to each other; edge 0 contacts are leaves 0 and 1 on `[0,.5]`, `[.5,1]`.
  - T-junction: a corner leaf split again is adjacent to the centre through two of its children.
  - 1- and 2-side splits produce the adjacency the geometry implies (check by brute force:
    two leaves are adjacent iff they share a segment, computed by sampling 64 points on
    each leaf edge and testing the other leaf's edges).
  - Across triangles: on a 2-triangle quad with a tree on one side, the unsplit neighbour's
    neighbours are exactly the leaves touching the shared edge, and a leaf's cross-edge
    neighbours respect the mapped interval (reversed edge direction).
  - `toRegion` splits nodes into whole triangles and pieces.
  - With no trees at all, `neighbors(t)` equals `edgeNeighbors(topology, normals, t)` for
    every triangle of a fixture mesh (no behaviour change).
- [ ] **Step 2:** fails. **Step 3: Implement.** Segment matching inside a tree: scale bary
  coordinates by `2^depth` (exact integers in a double), key each leaf edge by its reduced
  integer line `(dx, dy, c)` and compare intervals of the projection `dx*x + dy*y`. Edge `k`
  of the root is where coordinate `(k+2)%3` is 0, with `s = b[(k+1)%3]`. The neighbour's
  edge `k'` and direction come from matching corner positions in `mesh.vertices`
  (exact equality, as the welder).
- [ ] **Step 4:** pass.

### Task 8: fills walk pieces

**Files:**
- Modify: `src/doc/fill.ts`, `src/doc/guidedFill.ts`, `src/doc/featureField.ts` (only if
  `edgeNeighbors` needs exporting changes), `src/doc/project.ts`
- Test: `src/doc/fill.test.ts`, `src/doc/guidedFill.test.ts` (whatever exists), new cases in `src/doc/pieceFill.test.ts`

**Interfaces:**
- Produces (Project):
  ```ts
  shellFillRegion(object, seedTri): Region                    // whole triangles, as now
  smartFillRegion(object, seed: Seed | number, angleDeg, scale = 0): Region
  guidedFillRegion(object, inside: readonly Seed[], outside: readonly Seed[], angleDeg, scale = 0): Region
  ```
  (A bare number seed keeps old call sites and tests readable.) Algorithms take a
  `PieceGraph` instead of `(topology, display)`.
- [ ] **Step 1: Tests** (`pieceFill.test.ts` on a 4×4 grid of quads, 32 triangles, flat):
  - Brush a line across the middle with `split` so it cuts through triangles; smart fill
    from one side paints exactly the leaves and triangles on that side: no leaf on the other
    side changes, and every leaf of the seed colour on this side is painted (no gap).
  - Replace color (angle 180) the same.
  - Guided fill with an inside mark on one side and outside mark on the other.
  - Feature-size fill on the same fixture behaves like smart fill (flat plate) and fills a
    small same-coloured hole made of leaves.
  - All existing fill/guided tests pass unchanged except for the `Region` wrapping
    (`.tris`), and give identical triangle sets when no trees exist.
- [ ] **Step 2:** fails. **Step 3: Implement:** replace triangle ids by node ids in
  `smartFill`, `featureFill`, `fillSmallHoles`, `guidedFill`, `unionOfFills`:
  - scratch arrays grow to `graph.nodeCount()`;
  - angle tests use the triangles' normals (`triOf`), with code `-1` meaning 0°;
  - bend per node is `bend[triOf(node)]`;
  - step length uses `graph.centroid`;
  - area uses `graph.area`;
  - duplicate groups stay for unsplit triangles only.
  `shellFill` is unchanged (it ignores colour and drops trees by painting whole triangles).
- [ ] **Step 4:** pass; run the opt-in perf tests that cover fills
  (`PERF=1 npx vitest run test/perf.test.ts`) and compare with `main`'s numbers: no
  regression beyond noise on tree-free meshes.

### Task 9: tools use regions; the viewer highlights pieces

**Files:**
- Modify: `src/tools/types.ts` (`PaintView.setRegionHighlight(object, region: Region | null)`),
  `src/tools/PaintController.ts`, `src/tools/aiPaint.ts`, `src/view/ModelViewer.ts`,
  `src/view/colorSurface.ts`
- Test: `src/tools/PaintController.test.ts`, `src/tools/aiPaint.test.ts`

- [ ] **Step 1: Tests:** fills paint `Region`s (one undo step); the preview highlights pieces
  (FakeView records the region); guided marks and AI Paint seeds carry bary; the guided
  pending size counts nodes; Replace color on a split triangle repaints only the clicked
  piece's patch.
- [ ] **Step 2:** fails. **Step 3:** implement. `fillAt` → `project.paintRegion`; preview
  keys unchanged; `ModelViewer.setRegionHighlight` sets triangle highlights for
  `region.tris` and `atlas.highlight` for each `region.pieces` entry (clearing the previous
  region's), requesting a texture range upload. AI Paint: mask triangles become seeds at
  their centroid; marks use `hit.bary`.
- [ ] **Step 4:** pass; `npm test`; `npm run typecheck`.

### Task 10: verify in the app, docs

- [ ] Dev server: import the spike slab (`spike/subtri` builds it) or a coarse STL, brush
  across a big triangle with Split triangles on/off, eyedropper on both sides, smart fill up
  to the stroke, Replace color, guided fill, undo/redo, export to Prusa and re-import (trees
  survive), then the PrusaSlicer CLI round trip of that export with
  `spike/subtri/prusaSlice.spike.ts`'s helpers.
- [ ] Real file: open goldfish in the app, check frame rate and that its imported trees draw
  as in the spike page.
- [ ] Docs: spec 5.3 (the field now edits trees; option 2 is the implementation), CLAUDE.md
  architecture (`splitTree.ts`, `pieces.ts`, `treeAtlas.ts`), `docs/FORMAT.md` unchanged.
- [ ] `npm test`, `npm run build`.

## Self-review notes

- Spec coverage: resolution (Task 4), tools that cut (Tasks 2/4), fills follow pieces
  (Tasks 7–9), checkbox (Task 4), hover/eyedropper (Task 6), visibility per triangle (no
  change: the view's candidates are per triangle), toggle off = whole triangles (Task 2),
  no size warning (nothing to build).
- Risks: fill performance on files with many trees (goldfish: 77k): pieces expand lazily,
  only where a flood reaches; texture uploads per dab are ranges, not the whole atlas.
