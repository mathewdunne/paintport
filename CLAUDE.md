# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**This is the `paintportplus` branch.** It turns PaintPort into PaintPort+, an all-in-one browser tool for painting multicolor 3D prints and mapping design colors to real spools/ColorMix blends, with export for PrusaSlicer (Core One INDX), Bambu Studio and Snapmaker Orca. Vite + TypeScript + React + shadcn/ui + three.js. Everything runs client-side and offline. GitHub Pages deploys this branch via `.github/workflows/pages.yml`.

**Read `docs/PLUS_SPEC.md` first.** It holds the agreed requirements, the data model (the `PaintField` seam that later allows sub-triangle painting), the phase plan, and the log of decisions made with the user. Don't contradict it silently; if something needs to change, ask and then update the spec.

The original single-file tool lives at `public/classic/index.html` (served at `/classic/`) and is kept byte-identical. This repo is a fork of [perspektive3D/paintport](https://github.com/perspektive3D/paintport) (remote `upstream`). This branch is not meant to be PR'd upstream; only the classic tool on `main` follows upstream conventions.

## Commands

```bash
npm run dev        # Vite dev server
npm test           # Vitest (src/**, test/**) + classic regression suite
npm run typecheck  # tsc -b (app, node and test projects)
npm run build      # typecheck + production build into dist/
```

- Parity suite knobs: `PARITY_SEED=<n> PARITY_SCALE=<x> npx vitest run src/core/parity.test.ts`
- 1M-triangle perf check: `PERF=1 npx vitest run test/perf.test.ts`
- Classic-only tests still work against the moved file, e.g. `node test/test_paintport.mjs public/classic/index.html <painted.3mf> <out.3mf> [mode] [target]`

## Architecture

- `src/core/`: TypeScript port of the classic tool's DOM-free core (ZIP, 3MF load/build, TriangleSelector paint codec with `prusa`/`bbs` dialects, color math, ColorMix). `src/core/parity.test.ts` evaluates the original core from `public/classic/index.html` in `node:vm` and requires identical outputs on seeded random inputs. Any intended behavior change must be handled there explicitly and narrowly (see the volume-type fix), never by weakening the comparison.
- `src/formats/`: STL/OBJ parsers and `importFile` dispatch, producing the core's `Model` shape.
- `src/doc/`: `Project` (design palette, per-part base colors), the `PaintField` interface and `TrianglePaintField` (v1, whole-triangle paint; split-tree paint from imports is preserved verbatim).
- `src/view/`: three.js viewer, React-free. Per-triangle flat colors in non-indexed geometry, range-based color updates, sRGB bytes converted to linear in a vertex-shader patch.
- `src/ui/`: React components. `src/strings.ts` holds every user-facing string.
- `test/support/`: parity harness, PRNG, synthetic 3MF generators, mesh fixtures.

`docs/FORMAT.md` holds the reverse-engineered format reference. Read it before changing import or export.

## Conventions and invariants

- `src/core/`, `src/formats/` and `src/doc/` stay free of DOM, React and three.js (`src/core/noDom.test.ts` guards the core).
- English only: UI strings live in `src/strings.ts`, and code comments and test names are in English.
- Imported object names reach the DOM only as React text, never via `dangerouslySetInnerHTML`. Colors go through `normalizeHex`.
- If "Allow ColorMix" is off, export must refuse instead of writing blends (carried over from classic; lands in phase 3).
- No runtime network requests: dependencies and fonts are bundled.
- License: AGPL-3.0. Formats are reimplemented, so don't copy code from PrusaSlicer, Primed3D or the slicer sources.
