# PaintPort+ — plan & spec

Status: **requirements agreed, phase 1 not started.** The decisions below came from five
question waves with the user (IDs like Q2.1 refer to section 7). Items marked
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
- **Shell fill**: bucket-fills the whole connected shell under the cursor (e.g. a
  separate eye or button piece).
- **Smart fill**: flood fill from the clicked triangle that stops at edges sharper than
  an angle threshold (slider, _default 30°_) and at existing paint boundaries.
- **Eraser**: brush that paints state 0 (base). Also available as a modifier while
  brushing (_default: hold `Shift`_).
- **Undo/redo**: `Ctrl+Z` / `Ctrl+Shift+Z`, _default 200 steps_.

Deferred to phase 4: mirror painting, lasso/box select, select-by-color.

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
- Left: thin tool rail (Brush, Shell fill, Smart fill, Eraser, Eyedropper).
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
| `B` `F` `S` `E` `I` | Brush, Shell fill, Smart fill, Eraser, Eyedropper _default_ |
| `[` `]` | Brush radius |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

Note: Alt+click is also the eyedropper. To resolve the conflict, Alt+**click** without
movement = eyedropper, Alt+**drag** = orbit. _default_

### Export (Q5.1)
All three targets in v1: PrusaSlicer (Core One INDX), Bambu Studio, Snapmaker Orca, with
the per-target settings PaintPort has today (extruder count, ColorMix format, `bbsApp`
pin, Bambu's 16-filament cap).

### Saving (Q2.4, Q6.1)
- The current project autosaves to IndexedDB, so reloading or crashing loses nothing.
  One project at a time.
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
  objects: ProjectObject[];          // geometry, parts, transforms from import
  fields: PaintField[];              // one per object
  baseColor: Map<PartId, State>;     // per part
  source: SourceInfo;                // original file identity, dialect, filaments
  mapping: Map<State, MappingTarget>;// design color → spool | blend (export only)
}
type State = number; // design-palette index; 0 = unpainted / base
```

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
  serialize(dialect: "prusa" | "bbs"): { mesh: Mesh; paint: (string | null)[] };
}
```

`BrushOpts.visibleOnly` carries the "paint through" toggle. Visibility is computed by
`view/`, since it depends on the camera, and passed in as a triangle filter, so
`PaintField` stays camera-agnostic.

### 5.3 v1: `TrianglePaintField`
- `states: Uint16Array`, one per triangle.
- `preserved: (string | null)[]`: the original paint tree, rewritten into design states
  at import, for triangles that had sub-triangle detail. `serialize` emits it verbatim.
  Painting a triangle sets its state and clears its `preserved` entry. `remap` remaps
  leaves inside preserved trees with the existing codec.
- `paintSphere`: triangles the sphere intersects (closest point on the triangle within
  the radius), found with a three-mesh-bvh shapecast.
- `EditRecord` = `{ tris: Uint32Array, before: Uint16Array, after: Uint16Array,
  preservedBefore: Map<number, string> }`. It's opaque to callers, so options 2/3 can
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
- `Metadata/PaintPortPlus/object_<n>.bin`: the object's design paint. It's the same
  string-per-triangle data `serialize` produces, in design states, length-prefixed. The
  ZIP compresses it.

On import, if the sidecar exists and every object's triangle count and hash match, the
document is restored from it. Otherwise the sidecar is ignored, with a notice.

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
   targets, the design/print toggle, and the design sidecar. Known gap to close here:
   `load3MF` ignores PrusaSlicer's per-object/volume `extruder` in
   `Metadata/Slic3r_PE_model.config` (classic behavior), so imported Prusa projects
   currently get filament 1 as every base color. Once this phase is done,
   `/classic/` can be retired (user's call).
4. **More selection tools**: mirror painting, lasso/box (with paint through),
   select-by-color, maybe texture bake.
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
