# PaintPort+ — plan & spec

Status: **phases 1–3 done. Phase 4: guided fill and AI Paint (SAM, Q10) done; the rest of
phase 4 and phase 5 are next.** The decisions below came from question waves with the user (IDs like Q2.1 refer to section 7). Items marked
_default_ are my calls on things we didn't discuss; push back on any of them.

## 1. Goal

An all-in-one browser tool for painting multicolor 3D prints and mapping them to real
spools/ColorMix blends, exporting project files for PrusaSlicer, Bambu Studio and
Snapmaker Orca. It keeps PaintPort's mapping/export strengths and replaces the slicers'
painting UX, which has two specific pain points:

1. No palette: you paint with "extruder N", not with a color you can see and pick.
2. Poor region selection on character-style models (smart fill / edge detection).

Non-goals for now: sub-triangle painting precision (phase 5), touch/tablet painting,
textured-model import, arranging/transforming objects, multiple saved projects, i18n.

## 2. Platform & project

- Branch `paintportplus` of the fork. Not intended as an upstream PR: upstream is
  single-file and zero-dependency, which this deliberately isn't.
- Vite + TypeScript + React + shadcn/ui (Tailwind). Not Next.js: no server, no routing.
- three.js for rendering, three-mesh-bvh for brush/ray/shape queries.
- npm, Vitest for unit tests. _default_
- GitHub Pages deploys via a GitHub Actions workflow that runs the Vite build. Pages
  source must be set to **"GitHub Actions"** in repo settings, and `paintportplus` must
  be allowed under Settings → Environments → github-pages → Deployment branches (the
  default only allows `main`). Vite `base: "./"` so it works under `/paintport/`. (Q1.3)
- The original single-file tool stays reachable at **`/classic/`** (copied verbatim from
  `index.html`) until the new app reaches mapping parity. (Q1.2)
- UI is English only, with every user-facing string in one module so i18n can be added
  later. Code comments and test output in English; the German upstream convention is
  dropped on this branch. (Q1.4)
- Everything stays client-side and offline at runtime: no network requests, no
  analytics. Dependencies are bundled. _default, carried over from PaintPort_
  Relaxed for AI Paint (Q10.6): the rule came from upstream PaintPort, and the user doesn't
  need it on this branch. The SAM model weights are fetched from Hugging Face on first use,
  after the user agrees to the download, at a pinned revision, checked against SHA-256 and
  kept in the browser's Cache API so later sessions work offline. Everything else stays
  bundled (the ONNX Runtime `.wasm` included), and the app must load and work without the
  model.
- License stays AGPL-3.0. Formats are reimplemented, never copied from slicer sources.

## 3. Product behavior

### Inputs (Q1.1)
3MF (painted or not, all flavors PaintPort reads today), STL, OBJ. STL/OBJ import as one
object each with no paint, base color = first design color.

### Design palette vs. spools (Q2.1, Q3.1, Q3.3)
Two separate lists:

- **Design palette** (per project): free colors you paint with. Paint states index
  into it. Importing a painted 3MF turns the file's filament colors into the design
  palette.
- **Spools**: your printer's physical filaments. One persisted set per target extruder
  count, like PaintPort's `paintport_slots`. Used only at export.

At export a mapping assigns each design color to a spool or a ColorMix blend, reusing
PaintPort's `autoMap`/`bestOption` (a blend wins when its predicted ΔE beats the closest
spool). Several design colors may map to the same spool. The "Allow ColorMix" invariant
carries over: with it off, export must refuse rather than write blends.

Palette operations (Q5.3):
- **Edit color**: changes the swatch, so everything painted with it updates.
- **Delete / merge into**: delete a color by merging its surface into another color or
  into base.
- **Eyedropper**: Alt+click (or `I`) picks the design color under the cursor.

### Base color (Q3.4)
Each object/part has a base design color, taken from the file's default extruder.
Unpainted triangles show it, the eraser returns triangles to it, and changing it recolors
all unpainted surface of that object. Exports keep the slicer's base-extruder semantics
(unpainted triangles stay unpainted, the part's extruder carries the color).

### Tools — paint MVP (Q2.2, Q5.2)
- **Brush**: sphere brush with adjustable radius (`[` / `]`). Paints every triangle the
  sphere intersects. By default it hits only surface **visible from the camera** (front
  facing and not occluded), so it doesn't bleed onto the back of thin parts. A
  **"Paint through"** toggle hits everything in the sphere.
- **Object paint** (called shell fill until 2026-10-09; `shellFill` in code): paints the
  whole connected shell under the cursor (e.g. a separate eye or button piece).
- **Smart fill**: flood fill from the clicked triangle that stops at edges sharper than
  an angle threshold and at existing paint boundaries. The panel shows one **Edge
  sensitivity** slider (Q9.3; "Bigger regions" to "Finer details", 60° to 5°, the default
  20° in the middle, Q9.2). An **Advanced** section holds the raw **edge angle** and the
  **feature size** (Q9.1): the bend is measured on the surface smoothed over that size
  instead of edge by edge, so sculpt/scan texture neither stops the fill nor leaves specks,
  and a soft crease several triangles wide reads as one band (`src/doc/featureField.ts`).
  The fill then climbs into the band up to its middle and fills holes smaller than the
  feature size that it surrounds. Feature size defaults to **Auto**: 5 triangle spacings
  per mesh, or edge by edge when at least 10% of the mesh's edges join coplanar triangles
  (CAD exports: 15-50%, sculpts and scans: 0.2-1.2%). Dragging it sets a manual size in
  world mm (0 = Off); "Reset to defaults" restores 20° and Auto. The slider values and
  whether Advanced is open are remembered in localStorage (`paintportplus.paint`). On the
  user's Yoshi (500k triangles, 0.08 mm edges in file units, placed at 2.2x) Auto picks
  0.48 mm and fills the pupil cleanly where the edge-by-edge fill leaks into the whole
  model; the bend field costs ~0.35 s once per feature size.
- **Guided fill** (Q9.4, key `G`): smart fill steered by marks. Click marks the area to
  paint (inside), Shift+click marks where the fill must not go (outside); the pending
  region is highlighted and recomputed after each mark, with green "+" / red "-" badges on
  the marks and a viewport bar (size, Paint/Clear). Enter paints it with the active color
  as one undo step, Escape clears the marks, Backspace removes the last one; a mark on
  another object starts over. The two floods race along cheapest paths
  (`src/doc/guidedFill.ts`): a step costs its length times a weight that is 1 up to half the
  edge angle and rises quadratically to 50 at it, so they meet on the creases between the
  marks, or halfway where there is none. The inside flood moves like smart fill, so with only
  inside marks the region is the union of their smart fills; the outside flood crosses
  anything of its color. Existing paint stops both. It uses the smart fill settings. On
  Yoshi, one inside click on the eye dome (228k triangles, leaking into the head) plus one
  outside click on the head gives the dome alone (10k); ~0.1-0.15 s per mark at 500k
  triangles.
- **Eraser**: brush that paints state 0 (base). Also available as a modifier while
  brushing (_default: hold `Shift`_).
- **Undo/redo**: `Ctrl+Z` / `Ctrl+Shift+Z`, _default 200 steps_.

Deferred to phase 4: mirror painting, lasso/box select, select-by-color.

### AI Paint (Q10.1–Q10.11)
Measured on Yoshi (about 200k triangles, WebGPU, SlimSAM-77 fp32): encode 1.4 s for the first view (shader compile), 0.44 s after; decode about 1 s on the first click; lifting 46 ms; race about 0.7 s. One click on the eye dome selected it cleanly (about 3,400 triangles in the app).
A Segment Anything (SAM) model running in the browser picks regions by appearance, where
smart and guided fill only see local geometry. Guided fill still fails on Yoshi in three
ways: features shallower than the sculpt noise (the highlight in the pupil), regions with
no crease at all (where the eye dome blends into the head), and jagged staircase boundaries.
The third is phase 5's job and AI Paint doesn't fix it.

- **Scope (Q10.1)**: click-to-segment on the current view with a small model. SAMesh-style
  automatic whole-model segmentation (multi-view renders, automatic masks, merging into
  parts; arXiv 2408.13679) is a possible later phase on the same render → SAM → lift
  pipeline, decided after we see real masks. No text prompts: SAM 3 has them, but it is
  ~840M parameters (~3.4 GB) under Meta's custom SAM License with use restrictions.
- **Tool (Q10.2)**: a new rail tool **"AI Paint"** (key `A`) with guided fill's flow. Click
  marks build a pending region that is highlighted with badges and the viewport bar, `Enter`
  paints it with the active color as one undo step, `Esc` clears it, `Backspace` removes the
  last mark. A mark on another object starts over. While a view is analyzed, the cursor
  over the model is the busy cursor and the viewport bar shows a spinner. It is disabled in
  the Print view like every tool. Guided fill stays as it is.
- **Prompts (Q10.3)**: click = positive point, Shift+click = negative point (SAM's own
  prompt types). No boxes or scribbles.
- **Mask scale (Q10.8)**: for a single click SAM returns three candidates (e.g. pupil / eye
  / head). The highest-scored one is used, and `Tab` steps through the three. With 2+
  points in a view the points already pin down the scale, so the highest-scored mask is
  used and `Tab` does nothing.
- **What SAM sees**: an offscreen render of the current camera pose at SAM's input size
  (1024 px on the long side), drawn from the model layer only. Which look (the shaded
  design colors as on screen, view-space normals, a neutral "clay" shading, or a mix) is
  decided by the spike. The image is encoded once per camera pose, lazily on the first
  click after the camera settles, and reused for every click in that pose.
- **Mask → triangles**: a triangle belongs to a view's mask when its centroid is visible in
  that view (the depth test the visible-only brush uses, `src/view/visibility.ts`, so
  sub-pixel triangles on dense meshes aren't lost the way they would be with an ID buffer)
  and the mask covers the centroid's pixel. Only the parts of the mask that hold one of the
  view's positive marks count (SAM's masks come with stray islands). Triangles within 3 of
  SAM's 256 mask cells of the mask's edge, or seen at a grazing angle (cosine below 0.3),
  seed neither flood: there the mask is unsure, and trusting it walled the race off from the
  hidden side (Charizard's belly stopped at its lower silhouette). The race then puts the
  boundary on the crease. Whole triangles only, so the boundaries are as jagged as today's
  fills until phase 5.
- **Existing paint (Q10.9)**: only triangles that currently show the same color as the
  first click's triangle can join the region. Other colors are left alone, as with the fills.
- **Hidden surface (Q10.4)**: geometry carries the region on. The mask's triangles seed
  guided fill's inside flood and the visible triangles outside the mask seed its outside
  flood. The race (`src/doc/guidedFill.ts`, with the smart fill settings) then decides the
  surface no view has seen, so the region wraps round the back where the geometry agrees.
- **Orbiting (Q10.5)**: views add up. Marks are points on the surface. After the camera
  moves, a click prompts SAM in the new view with every mark visible there. Masks from
  earlier views are kept, and the region's inside seeds are the union of every view's mask.
  Its outside seeds are the triangles some view saw outside its mask that no mask covers.
  A Shift+click shapes only the mask of the view it was made in. `Backspace` removes the
  last mark and re-decodes its view.
- **Hardware (Q10.7)**: WebGPU only. Without it (or when the adapter or session fails),
  the tool is disabled with the reason and a pointer to guided fill. No WASM fallback:
  GitHub Pages can't send the COOP/COEP headers that threaded WASM needs, so it would run
  single-threaded.
- **Model and delivery (Q10.6, Q10.11)**: a small SAM-1-class model under Apache-2.0
  (SlimSAM-77, MobileSAM or EfficientSAM-Ti, chosen by the spike; EdgeSAM is excluded for
  its possibly non-commercial license, and SAM 2.1-tiny at ~150 MB isn't tried, Q10.10).
  The weights (~10–40 MB) are not in the repo. They are fetched from Hugging Face the first
  time AI Paint is chosen, after a prompt that states the size, with progress, from URLs
  pinned to a commit (`/resolve/<sha>/`). They're stored in the Cache API and checked against
  SHA-256 hashes in a bundled manifest. The onnxruntime-web WebGPU runtime (MIT, ~21 MB
  `.wasm`) is a same-origin build asset, cached the same way. onnxruntime-web must not
  fetch its `.wasm` from a CDN (its examples point at jsDelivr). The panel credits the model
  and its license.
- **Spike first (Q10.10)**: before any UI work, a dev-only harness runs the candidate
  models on renders of the user's Yoshi. Go only if, with ≤3 clicks each, SAM gets the eye
  dome where it blends into the head, the pupil highlight, the shell and the shell rim
  better than guided fill does, and a new view is encoded in ≤2 s on WebGPU. Otherwise the
  findings go into this section and AI Paint stops there.
- Defaults (_default_): pending marks and per-view masks are not autosaved; the encoding
  runs on the main thread unless the spike shows jank; the panel shows only availability,
  download and status, since geometry carry uses the smart fill settings.

### Viewport (Q3.2, Q4.3)
- Toggle **Design** (design colors) / **Print** (each design color replaced by its mapped
  spool or predicted blend color), overlaid on the viewport.
- Object arrangement is read-only: positions come from the file. The Objects tab can
  hide and isolate objects so occluded ones can be painted.
- Hover highlight shows the brush sphere / the region a fill would hit before clicking.
  _default_

### Layout (Q4.1)
```
+--+------------------------+-------------------+
|B |                        | Paint | Obj | Exp |
|F |                        |-------------------|
|S |       3D viewport      | o o o o +         |
|E |                        | size  ------o     |
|  |                        | angle ---o        |
|  |   [Design | Print]     |                   |
+--+------------------------+-------------------+
```
- Left: tool rail with an icon and a name per tool (Brush, Object paint, Smart fill,
  Guided fill, AI Paint, Eraser, Eyedropper). Smart fill, guided fill and AI Paint sit in
  one boxed group labeled "Fill tools", since each picks a region its own way and stands in for the others when
  one fails. Tooltips give a few-word description and the shortcut key.
- Right: one panel with tabs. **Paint** = palette and active tool settings.
  **Objects** = object list with visibility/isolate and base color. **Export** = target
  slicer, spools, mapping, ColorMix toggle, export button.
- Top-right of the window: import button, theme toggle, link to `/classic/`.
- Theme follows the OS, with a manual light/dark override. (Q4.4)

### Controls (Q4.2, Q2.3)
Desktop mouse/trackpad only; touch can view but painting isn't tuned for it.

| Input | Action |
|---|---|
| Left drag | Use the active tool |
| Right drag | Orbit |
| Middle drag, Shift+right drag | Pan |
| Wheel | Zoom |
| Alt+left drag | Orbit (trackpad) |
| `Shift` held while brushing | Erase _default_ |
| `B` `F` `S` `G` `E` `I` | Brush, Object paint, Smart fill, Guided fill, Eraser, Eyedropper _default_ |
| `[` `]` | Brush radius |
| Guided fill: click / Shift+click | Inside / outside mark |
| Guided fill: `Enter` / `Esc` / `Backspace` | Paint the region / clear the marks / remove the last mark |
| AI Paint: `A`; click / Shift+click; `Tab` | Tool; include / exclude point; next mask candidate. `Enter` / `Esc` / `Backspace` as guided fill |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

Note: Alt+click is also the eyedropper. To resolve the conflict, Alt+**click** without
movement = eyedropper, Alt+**drag** = orbit. _default_

### Export (Q5.1)
All three targets in v1: PrusaSlicer (Core One INDX), Bambu Studio, Snapmaker Orca, with
the per-target settings PaintPort has today (extruder count, ColorMix format, `bbsApp`
pin, Bambu's 16-filament cap).

### Saving (Q2.4, Q6.1)
- The current project autosaves to IndexedDB, so reloading or crashing loses nothing.
  One project at a time; a second tab runs without autosave (Web Lock) instead of
  overwriting the first. Importing over a project with edits asks for confirmation.
  A saved session from a newer version, or one that fails validation, is never deleted
  automatically; it's only replaced by an explicit import or "New".
- Every export embeds a **design sidecar** that slicers ignore (section 5.4).
  Re-importing a PaintPort+ export restores design colors exactly. If the file was
  re-saved by a slicer, the sidecar is probably gone and import falls back to the spool
  colors.

### Import fidelity (Q1.5)
Imported triangles with sub-triangle paint keep their **original paint tree** and export
it verbatim (states remapped). Only triangles you repaint get flattened to one color.
In v1 the viewer shows those preserved triangles in their dominant color.

## 4. Architecture

```
src/
  core/      ported from index.html's CORE block. No DOM, no React, no three.js.
             zip.ts  threemf/load.ts  threemf/build.ts  paint/codec.ts
             color.ts  mix.ts  errors.ts  version.ts
  formats/   stl.ts  obj.ts  sidecar.ts  (DOM-free)
  doc/       Project document, PaintField implementations, undo stack, autosave
  tools/     brush, shellFill, smartFill, eraser, eyedropper (talk to PaintField only)
  view/      three.js scene, BVH, color-buffer sync, camera controls, hover preview
  ui/        React + shadcn components
  strings.ts all user-facing text
public/classic/index.html   the original tool, moved from the repo root (served at /classic/)
test/        existing .mjs suites + Vitest specs
```

Rules:
- `core/`, `formats/` and `doc/` stay DOM-free and headless-testable in Node.
- `view/` reads the document and never owns state. The document notifies the view
  which triangles changed, so it updates only those ranges of the color buffer.
- Imported names reach the DOM only as React text (React escapes them, which replaces
  PaintPort's `esc(...)` rule). Colors still go through `normalizeHex`.

## 5. Data model

### 5.1 Project document

```ts
interface Project {
  palette: DesignColor[];            // index = paint state; [0] unused (0 = base)
  objects: ProjectObject[];          // mesh, parts (volume types, file extruders),
                                     // transform, name, printable flag
  fields: PaintFieldView[];          // read-only views; edit only through Project
  baseColor: Map<PartId, State>;     // ModelParts and ParameterModifiers
  source: SourceInfo;                // original file identity, dialect, filaments
  mapping: Map<State, MappingTarget>;// design color → spool | blend (phase 3)
}
type State = number; // design-palette index; 0 = unpainted / base
interface DesignColor { color: string; known: boolean; mix?: MixHint }
```

The source `ModelObject` is not retained after import: everything export needs is
copied into `ProjectObject`/`SourceInfo`, and paint lives only in the fields (in design
states). All edits go through `Project` methods, which record undo steps (count limit
200 plus a memory budget) and emit change events for incremental viewer updates.

### 5.2 PaintField: the seam for options 2 and 3

**Tools never touch storage directly.** They talk to a `PaintField` interface. v1 ships
a per-triangle implementation, and options 2 and 3 add new implementations behind the
same interface.

```ts
interface PaintField {
  // Geometry the field is defined over. Option 3 can replace this mesh (split
  // triangles), so tools must not cache triangle indices across edits.
  readonly mesh: EditableMesh;

  // Query: state at a surface point. v1 ignores bary.
  stateAt(tri: number, bary?: Vec3): State;

  // Edit primitives. Tools express intent as regions, not triangle lists, so a
  // finer-grained implementation can resolve them more precisely.
  paintSphere(center: Vec3, radius: number, state: State, opts: BrushOpts): EditRecord;
  paintTriangles(tris: Iterable<number>, state: State): EditRecord; // fills
  remap(map: (s: State) => State): EditRecord;                       // merge/delete

  // For the viewer: per-triangle display state (v1 exact; option 2 = dominant leaf
  // or a refined render mesh).
  displayStates(): Uint16Array;

  // For export: the TriangleSelector string per *output* triangle, in design states.
  // build3MF then remaps design states → output extruders through the mapping.
  // Read-only, so it lives on PaintFieldView (Project.fields).
  serialize(dialect: "prusa" | "bbs"): { mesh: EditableMesh; paint: (string | null)[] };
}
```

`BrushOpts.visibleOnly` carries the "paint through" toggle. Visibility is computed by
`view/`, since it depends on the camera, and passed in as a triangle filter, so
`PaintField` stays camera-agnostic.

### 5.3 v1: `TrianglePaintField`
- `states: Uint16Array`, one per triangle.
- `preserved: Map<tri, string>` (sparse): the original paint tree, rewritten into design
  states at import (internal dialect `bbs`, which is unbounded), for triangles that had
  sub-triangle detail. Export converts it to the target dialect. Painting a triangle sets
  its state and deletes its `preserved` entry. `remap` remaps leaves inside preserved
  trees with the existing codec.
- `paintSphere`: the view narrows candidates with a three-mesh-bvh shapecast and filters
  them for visibility; the field does the exact test (closest point on the triangle
  within the radius) on those candidates.
- `EditRecord` = `{ tris: Uint32Array, before: Uint16Array, after: Uint16Array | number,
  preservedBefore: Map<number, string> }` (a single `after` value for uniform fills). It's opaque to callers, so options 2/3 can
  store tree or topology snapshots instead.

How options 2 and 3 fit in later:
- **Option 2 (`TreePaintField`)**: per-triangle TriangleSelector trees. `paintSphere`
  subdivides and `serialize` emits trees. Needs the split geometry reverse-engineered
  and verified by PrusaSlicer/Bambu round-trips.
- **Option 3 (`SplitMeshPaintField`)**: `paintSphere` cuts real triangles, so `mesh`
  changes, and `serialize` emits flat strings over the new mesh. Undo snapshots
  topology.

### 5.4 Design sidecar (Q6.1)
Written into every export:

- `Metadata/PaintPortPlus.json`: format version, app version, design palette, base
  colors per part, mapping, and per object the triangle count plus a geometry hash.
- `Metadata/PaintPortPlus/object_<n>.bin` (n = 0-based object index): the object's design
  paint in a small binary layout (magic, version, triangle count, a u16 design state per
  triangle, then the preserved sub-triangle trees as length-prefixed ASCII). It carries the
  same information `serialize` produces, without a string per triangle. The layout is
  documented in `src/doc/sidecar.ts`; the ZIP compresses it.

On import, if the sidecar exists and every object's triangle count and hash match, the
document is restored from it. Otherwise the sidecar is ignored, with a notice. The hash is
position-based (triangle corner coordinates in triangle order), because the bbs export
re-indexes vertices. The JSON also stores the source name and the parts of each object
(range, type, name, base color), since export merges and splits volume ranges. The import
reads the sidecar from the same unzipping as the model (`load3MFFiles`).

## 6. Phases

Each phase ends green: `npm run build`, Vitest, and the ported regression suite.

1. **Scaffold + core port** ← checkpoint: stop for user review (Q5.4)
   - Vite/TS/React/shadcn app shell with the section 3 layout (tabs mostly empty).
   - Core ported to `src/core` TS modules. `test_regression.mjs` adapted to the
     modules and green.
   - `/classic/` serves the original tool.
   - Actions workflow deploying to Pages.
   - Import a 3MF/STL/OBJ and render it in three.js with its colors and orbit/pan/zoom.
     Light/dark theme.
2. **Paint MVP**, in three gated steps:
   - **2.0 PrusaSlicer project import.** `load3MF` also reads PrusaSlicer projects:
     physical colors from `Metadata/Slic3r_PE.config` (`extruder_colour`, falling back
     per slot to `filament_colour`), ColorMix virtual extruders from
     `Metadata/Prusa_Slicer_full_spectrum.json` (their stored color becomes the design
     color; the recipe is kept as a hint for phase 3 mapping), and object/volume base
     extruders from `Metadata/Slic3r_PE_model.config`. This is a deliberate extension
     beyond the classic tool. (Found with a real Core One INDX ColorMix project, Q7.0.)
   - **2.1 Document editing (DOM-free).** PaintField edit operations, undo stack,
     palette operations, base colors, mesh adjacency for shell/smart fill, autosave
     serialization.
   - **2.2 Tools and UI.** BVH picking, brush (visible-only and paint through), shell
     fill, smart fill, eraser, eyedropper, hover preview, undo/redo keys, palette UI,
     Objects tab (visibility/isolate, base color), autosave wiring, "New" action.
   Palette details (Q7.1–Q7.3): the design palette shows only colors that are painted
   or used as a base; unused file slots are dropped on import. Colors are edited with a
   popover picker (saturation/hue area plus hex input, react-colorful). Colors the file
   didn't define get distinct generated colors (no repeats) and an "unknown color"
   marker until edited. _default_ On reload, the last project auto-restores; a "New"
   action in the header discards it after confirmation.
3. **Mapping + export parity**: Export tab with spools, auto-map, ColorMix, all three
   targets, the design/print toggle, and the design sidecar. Before the Design/Print
   toggle, switch the viewer from per-vertex RGB to a per-triangle state attribute plus a
   palette texture lookup in the shader, so color edits and the toggle are a tiny texture
   upload instead of a full-mesh rewrite (today a color-picker drag costs ~14 ms per frame
   on 2.65M triangles). Also XML-unescape object names read from slicer configs (names
   like `&lt;b&gt;` currently show escaped). The imported ColorMix recipe
   hints (`mix` on palette entries, from phase 2.0) should pre-fill the mapping when the
   user's spools match the file's physical extruders. Once this phase is done,
   `/classic/` can be retired (user's call).

   Decisions (Q8.1–Q8.4) and design, in three gated steps:
   - **3.1 Viewer: state attribute + palette texture.** Each rendered vertex carries the
     triangle's *resolved* display state (paint state, or the part's base state when
     unpainted) as an integer attribute; the fragment color comes from a small palette
     data texture (sRGB bytes, linearized in the shader as today). Palette edits upload the
     texture only; base-color changes rewrite only that part's unpainted ranges. The view
     shows one of two color tables: Design (the palette) or Print (each state's mapped
     spool or predicted blend color; unmapped states keep the design color).
   - **3.2 Mapping, export and sidecar (DOM-free).**
     - *Spools* are app settings, not project data (persisted in `localStorage` like the
       classic `paintport_slots`): 16 slots `{color, on}` shared by all targets, plus an
       extruder count per target (defaults Prusa 8, Bambu 16, Snapmaker 4), the chosen
       target and "Allow ColorMix" (default on). Presets and slot reorder carry over
       from classic.
     - *Mapping* (Q8.1): every design color is **Auto** unless pinned. Auto resolves live
       with `bestOption` (nearest spool vs. best blend by ΔE; a tie keeps the spool), so it
       follows color and spool edits. A pin is a spool slot or a blend recipe
       (`slot×ratio` components) and sticks; a pin whose slot is off/out of range falls
       back to Auto. Pins live on the Project (`mapping`), are autosaved and written to
       the sidecar, emit a `mapping` event, and are **not** undo steps. Deleting/merging a
       color drops its pin; renumbering moves pins with their states.
     - *Recipe hints*: an Auto color with an imported `mix` hint resolves to that recipe
       when every component slot is an active spool whose color equals the file's physical
       extruder color (normalized hex). Q8.2: imported spools never overwrite the saved
       set automatically; the Export tab offers "Use this file's spools" when the file
       defined physical colors and they differ from the current spools.
     - *Export*: build a core `Model` from the project (internal `bbs` dialect, design
       states: whole triangles as one-leaf strings, untouched preserved trees verbatim;
       part extruders = design base states) and call `build3MF` with
       `stateMap` = design state → output extruder, exactly like classic `doExport`
       (slot n = extruder n; virtual ids above the printer count for Prusa, above the
       highest active slot for bbs; blends deduped by recipe). Only colors that are used
       (painted or a part base) get mapped. Every used state must map, otherwise export
       refuses. With "Allow ColorMix" off, export refuses if any used color resolves to a
       blend. Bambu's 16-filament cap is warned about live and enforced by `build3MF`.
       Warnings carry over: collisions (distinct design colors → near-identical result)
       and "a free slot would beat this poor blend". File name as classic:
       `<name><target suffix><_PRESET | _<n>T>.3mf`.
     - *Design sidecar* (section 5.4) in every export. The geometry hash for the sidecar
       is position-based (triangle count + corner coordinates in triangle order), because
       the bbs export re-indexes vertices per component. The sidecar stores the parts
       (`firstTri`, `triCount`, type, name, base design state) because export merges and
       splits volume ranges; on restore they replace the imported part list when they tile
       the triangles and agree with the imported volume types.
     - Object and part names are XML-unescaped once, in the document import (the core's
       `Model` keeps raw attribute text for classic parity, and `build3MF` escapes them on
       the way out).
   - **3.3 Export tab UI and Print toggle** (Q8.3, Q8.4): the Export tab stacks target
     slicer + extruder count, spools (on/off, color picker, presets, reorder, "Use this
     file's spools"), Allow ColorMix, one compact row per used design color (swatch →
     target dropdown: Auto, each active spool, the top blend candidates, each with ΔE),
     warnings, and the Export button. Print view is **view-only**: tools, hover preview and
     paint shortcuts are disabled while it is on, and so are undo/redo; left drag orbits
     (orbit/pan/zoom still work). Explicit edits in the Paint and Objects tabs stay
     available. The Export tab does not switch the view by itself.
4. **More selection tools**: mirror painting, lasso/box (with paint through),
   select-by-color, maybe texture bake. (Guided fill, Q9.4, came in ahead of these, and so
   does AI Paint, Q10: spike first, plan in `docs/plans/2026-10-09-ai-paint.md`.)
5. **Sub-triangle precision**: decide between option 2 and option 3, starting with a
   time-boxed spike on option 2's split geometry.

Performance target _default_: smooth brushing (60fps) on 1M-triangle models on a
mid-range desktop GPU, and import of a 1M-triangle 3MF in a few seconds.

## 7. Question log

| ID | Question | Answer |
|---|---|---|
| Q1.1 | Inputs | 3MF + STL + OBJ |
| Q1.2 | Original tool | Keep at `/classic/` |
| Q1.3 | Deployment | Actions workflow (recommendation, not asked) |
| Q1.4 | Language | English UI, English comments |
| Q1.5 | Import fidelity | Preserve untouched sub-triangle detail |
| Q2.1 | Palette semantics | Free design colors, mapped at export |
| Q2.2 | MVP tools | Brush, shell fill, smart fill |
| Q2.3 | Input devices | Desktop mouse/trackpad |
| Q2.4 | Saving | IndexedDB autosave + 3MF export |
| Q3.1 | Import palette | File's filament colors |
| Q3.2 | Viewport | Design / print toggle |
| Q3.3 | Spools | One persisted set |
| Q3.4 | Unpainted surface | Per-object base color |
| Q4.1 | Layout | Tool rail + tabbed side panel |
| Q4.2 | Controls | Left paints, right orbits |
| Q4.3 | Arrangement | Read-only + visibility/isolate |
| Q4.4 | Theme | System + toggle |
| Q5.1 | Export targets | All three |
| Q5.2 | Brush reach | Visible only + "paint through" toggle |
| Q5.3 | Palette ops | Edit = recolor all, delete/merge, eyedropper |
| Q5.4 | Checkpoint | After phase 1 |
| Q6.1 | Lossless saving | Design sidecar embedded in exports |
| Q7.0 | Prusa project colors | Real file showed fallback colors: importer must read PrusaSlicer project metadata (phase 2.0) |
| Q7.1 | Unused file slots | Design palette shows only used colors |
| Q7.2 | Color picker | Popover picker + hex |
| Q7.3 | Reopening | Auto-restore + "New" button |
| Q8.1 | Mapping behavior | Live Auto per color + sticky pins; saved with the project, not undoable |
| Q8.2 | File spools | Keep saved spools; offer "Use this file's spools" |
| Q8.3 | Print view | View-only (tools disabled); Export tab doesn't switch views |
| Q8.4 | Export layout | Everything stacked in the Export tab |
| Q9.1 | Smart fill on character models | Try the feature-size fill first ("option 1"); seeded segmentation (option 2) and in-browser SAM later if needed; no LLM API |
| Q9.2 | Smart fill defaults | Edge angle 20° (was 30° edge by edge); feature size 0.2 mm, later Auto (Q9.3) |
| Q9.3 | Smart fill controls | One "Edge sensitivity" slider; edge angle and feature size under a remembered Advanced section; feature size Auto per mesh; sliders remembered; Reset to defaults |
| Q9.4 | Click inside/outside fill | Separate "Guided fill" tool: marks build a pending region, Enter paints; cheapest-path race between inside and outside floods (not graph cut: no shrinking toward single clicks; not random walk: no big solve per click) |
| Q10.1 | SAM scope | Click-to-segment on the current view with a small model; SAMesh-style automatic part segmentation maybe later on the same pipeline (user first asked for SAMesh, then chose this once the cost was clear: many views, automatic masks, SDF, clustering, ~150 MB SAM2, WebGPU-only); no text prompts (SAM 3: ~3.4 GB, restrictive license) |
| Q10.2 | SAM tool | New "AI Paint" tool with guided fill's pending-region flow; guided fill unchanged |
| Q10.3 | SAM prompts | Click / Shift+click as positive / negative points |
| Q10.4 | Hidden surface | Geometry carries the region on: mask seeds the guided fill race (inside), visible non-mask seeds the outside |
| Q10.5 | Orbiting with marks | Views add up: union of per-view masks; marks re-used as prompts in the views that see them |
| Q10.6 | Weight delivery | Fetched from Hugging Face on first use (pinned revision, size prompt, progress, SHA-256 check), kept in the Cache API; not tracked in git. The no-network rule was upstream's: relaxed for the model only |
| Q10.7 | No WebGPU | Tool disabled with the reason; no WASM fallback |
| Q10.8 | Mask scale | Highest-scored of SAM's 3 candidates; `Tab` cycles (single-click views only) |
| Q10.9 | Existing paint | Keep other colors: only the first click's color can join the region |
| Q10.10 | Spike bar | Beats guided fill on Yoshi (eye dome blend, pupil highlight, shell, shell rim; ≤3 clicks each) and ≤2 s per view on WebGPU; small models only, no SAM 2.1-tiny reference |
| Q10.11 | Model | Small Apache-2.0 SAM-1-class model chosen by the spike (SlimSAM-77, MobileSAM, EfficientSAM-Ti) _default list_ |
