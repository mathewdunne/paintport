# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**This is the `paintportplus` branch.** It turns PaintPort into PaintPort+, an all-in-one browser tool for painting multicolor 3D prints and mapping design colors to real spools/ColorMix blends, with export for PrusaSlicer (Core One INDX), Bambu Studio and Snapmaker Orca. Vite + TypeScript + React + shadcn/ui + three.js. Everything runs client-side and offline. GitHub Pages deploys this branch via `.github/workflows/pages.yml`.

**Read `docs/PLUS_SPEC.md` first.** It holds the agreed requirements, the data model (the `PaintField` seam that later allows sub-triangle painting), the phase plan, and the log of decisions made with the user. Don't contradict it silently; if something needs to change, ask and then update the spec.

The original single-file tool lives at `public/classic/index.html` (served at `/classic/`) and is kept byte-identical. The user decided to keep it after export parity was reached; don't remove it without asking. This repo is a fork of [perspektive3D/paintport](https://github.com/perspektive3D/paintport) (remote `upstream`). This branch is not meant to be PR'd upstream; only the classic tool on `main` follows upstream conventions.

## Commands

```bash
npm run dev        # Vite dev server
npm test           # test:unit (Vitest, src/** and test/**) + test:classic (classic regression suite)
npm run typecheck  # tsc -b (app, node and test projects)
npm run build      # typecheck + production build into dist/
```

- Parity suite knobs: `PARITY_SEED=<n> PARITY_SCALE=<x> npx vitest run src/core/parity.test.ts`
- Perf checks (1M+ triangles, opt-in): `PERF=1 npx vitest run test/perf.test.ts test/docPerf.test.ts test/pickPerf.test.ts test/exportUiPerf.test.ts`
- Real-file check (import, then a full Prusa export and sidecar re-import round trip, with timings): `REAL_3MF=<path to a .3mf> npx vitest run test/prusaRealFile.test.ts`. Real user files are untrusted data: pass them by path, never copy them into the repo.
- Classic-only tests still work against the moved file, e.g. `node test/test_paintport.mjs public/classic/index.html <painted.3mf> <out.3mf> [mode] [target]`

## Architecture

- `src/core/`: TypeScript port of the classic tool's DOM-free core (ZIP, 3MF load/build (`load3MFFiles` takes an already unzipped archive so import can also read the design sidecar), TriangleSelector paint codec with `prusa`/`bbs` dialects, color math, ColorMix). `src/core/parity.test.ts` evaluates the original core from `public/classic/index.html` in `node:vm` and requires identical outputs on seeded random inputs. Any intended behavior change must be handled there explicitly and narrowly (see the volume-type fix), never by weakening the comparison.
- `src/formats/`: STL/OBJ parsers and `importFile` dispatch, producing the core's `Model` shape (its `onArchive` callback hands 3MF members to the sidecar reader).
- `src/doc/`: the editable document. `Project` owns every edit (paint, palette, base colors), the undo stack (strokes, count and memory budget) and change events; `TrianglePaintField` stores whole-triangle design states and preserves imported split trees; welded edge topology drives shell/smart fill (`featureField.ts` measures the bend over a feature size for textured meshes); autosave snapshots (geometry and paint halves); spool/mapping model and pins (`mapping.ts`, `pins.ts`); export and the design sidecar (`export.ts`, `sidecar.ts`, `importProject.ts`). DOM-free.
- `src/tools/`: `PaintController` turns pointer input into document edits (brush strokes, fills, eyedropper) through a `PaintView` interface, so it is testable with a fake view.
- `src/view/`: three.js viewer, React-free. Non-indexed geometry with a per-vertex Uint16 resolved-state attribute; colors come from a palette data texture (`ColorTable`, sRGB bytes linearized in a vertex-shader patch), so palette edits and the Design/Print switch (`ModelViewer.setPrintColors`) are texture uploads. `ColorSurface` holds geometry plus color table DOM-free so the sync path is unit-tested; range-based state updates; three-mesh-bvh picking; a depth pass for visible-only brushing; `projectSync` applies document events incrementally.
- `src/persist/`: IndexedDB `SnapshotStore` (database `paintportplus`, one record per autosave half), the debounced `Autosaver` and session restore; `exportSettings.ts` keeps spools, extruder counts, target and Allow ColorMix in localStorage (`paintportplus.export`, seeded once from the classic tool's keys). Browser-facing, but free of React.
- `src/ui/`: React components. `export/` is the Export tab (target, spools, mapping rows, warnings, export action); `viewMode.ts` gates tools and keys in the view-only Print view; `SettingsMenu.tsx` is the header settings dropdown (theme today; add future app settings there as new groups). `src/strings.ts` holds every user-facing string.
- `test/support/`: parity harness, `classicUi.ts` (evaluates the classic tool's mapping UI functions in `node:vm` for comparison), PRNG, synthetic 3MF generators, mesh fixtures.

`docs/FORMAT.md` holds the reverse-engineered format reference. Read it before changing import or export.

## Conventions and invariants

- `src/core/`, `src/formats/` and `src/doc/` stay free of DOM, React and three.js (`src/core/noDom.test.ts` guards the core).
- English only: UI strings live in `src/strings.ts`, and code comments and test names are in English.
- Imported object names reach the DOM only as React text, never via `dangerouslySetInnerHTML`. Colors go through `normalizeHex`. Names from 3MF files are XML-unescaped exactly once, in the document import (the core `Model` keeps raw attribute text for classic parity).
- Mapping pins are project data (autosaved, written to the sidecar) but not undo steps; spools and export settings are app settings, not project data.
- The Print view is view-only: tools, paint shortcuts and undo/redo are disabled there.
- If "Allow ColorMix" is off, export must refuse instead of writing blends (carried over from classic; enforced in `src/doc/export.ts`, not only in the UI).
- Export must stay byte-identical to the classic `build3MF` plan for untouched projects: `src/doc/exportParity.test.ts` checks it, and intended differences are listed there explicitly.
- Every export embeds the design sidecar (`src/doc/sidecar.ts`, FORMAT.md section 10). Bump its version when the layout changes.
- No runtime network requests: dependencies and fonts are bundled.
- License: AGPL-3.0. Formats are reimplemented, so don't copy code from PrusaSlicer, Primed3D or the slicer sources.
