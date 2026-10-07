# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PaintPort is a single-file browser tool (`index.html`, ~180 KB, no build step, no dependencies) that converts multicolor-painted 3MF files (Bambu Studio / MakerWorld / OrcaSlicer) into project files for PrusaSlicer (Core One INDX), Bambu Studio, or Snapmaker Orca. It remaps painting states to the user's spool slots and can recreate missing colors as ColorMix blends in each slicer's native format. Everything runs client-side and offline. Open `index.html` directly in a browser to run it.

This repo is a fork of the community project [perspektive3D/paintport](https://github.com/perspektive3D/paintport) (git remote `upstream`). Upstream releases arrive as `Release vX.Y.Z` commits with a `PaintPort-Sync: true` trailer. Changes made here may be PR'd upstream, so keep them consistent with upstream conventions (see below). There is no fixture 3MF in this repo.

## Commands

All tests run headless on Node ≥ 18 and need no `npm install`.

```bash
# Regression suite (synthetic in-memory 3MFs, no fixture needed). Pass index.html explicitly:
# the default path is paintport.html, upstream's internal filename.
node test/test_regression.mjs index.html

# End-to-end on a real painted 3MF (bring your own). Modes: identity | swap12 | virtual
# Targets: prusa | bambu | snapmaker. Optional 7th arg: bbs Application string.
node test/test_paintport.mjs index.html <painted.3mf> <out.3mf> [mode] [target] [bbsApp]

# WebGL preview + mapping-UI smoke test in headless Chrome.
# The Chrome path is hardcoded to macOS (and uses --use-angle=metal), so edit CHROME to run it elsewhere.
node test/test_preview_smoke.mjs index.html [out.html]
```

To validate a Prusa export fully, round-trip it through PrusaSlicer and compare the `mmu_segmentation` histogram against the "expected leaf statistics" that `test_paintport.mjs` prints (see CONTRIBUTING.md).

## Architecture

`index.html` contains, in order: CSS (with base64-embedded Poppins / Roboto Mono subsets), markup, and two `<script>` blocks.

**Core (`/*CORE-START*/ … /*CORE-END*/`)** is DOM-free and must stay that way. The tests extract the text between these markers and `eval` it in Node, so the core cannot touch `document` or `window`. It exposes `globalThis.PaintPortCore` (`load3MF`, `build3MF`, `parsePaintTree`/`emitPaintTree`, `remapPaintString`, `deltaE`, `bestMix`/`topMixes`, `predictMix`, `zipAll`/`unzipAll`, …). Key pieces:
- A hand-written ZIP reader and writer built on the browser/Node `CompressionStream`, with CRC32.
- The TriangleSelector paint-string codec. A hex string read right-to-left, nibble by nibble, recursive split trees. It has **two dialects** that only differ for states ≥ 17: `"prusa"` (`slic3rpe:mmu_segmentation`, 8-bit escape) and `"bbs"` (`paint_color`, unary `F` extension). `load3MF` sets `model.paintDialect` from the source attribute. `build3MF` emits the dialect of the target. Remapping has to walk the leaves inside split trees, not just top-level strings.
- `load3MF(bytes)` → model `{objects[{vertices, tris, paints, triState, parts, defaultExtruder, …}], filaments[], paintDialect, sourceIdentity, …}`. It resolves external object files (Bambu production extension), transforms, volume types, and `printable`. It rejects non-millimetre units.
- `build3MF(model, plan)` with `plan = {target: "prusa"|"bambu", stateMap, physical, virtuals, mixFormat, bbsApp, …}`. There are only two flavors. The UI's "snapmaker" target is `target: "bambu"` + `mixFormat: "snapmaker"`, and Bambu Studio is `mixFormat: "bambu"`. The ColorMix output differs per target: Prusa writes `Metadata/Prusa_Slicer_full_spectrum.json` (virtual IDs must start above the physical extruder count). Snapmaker writes the `mixed_filament_definitions` string. Bambu writes per-slot `filament_is_mixed`/`_components`/`_ratios` arrays and is capped at 16 filaments in total.
- Color math: sRGB → Lab, ΔE, and predicted mixes for blend candidates.
- Core errors carry a stable `err.code` (`CORE_ERRORS`). The UI translates them through I18N keys `err.<code>`.

**UI (second script)**: global state (`MODEL`, `PV`, …), the `I18N` dictionary (`de` + `en`), the `TARGETS` table (per-target suffix, default extruder count, `bbsApp` pinned to the target slicer's version, `mixFormat`), slot presets, persisted slot colors (`saveSlots`/`loadSlots`) with ▲▼ reordering (`moveSlot`; mapping selections follow the moved color via `swapSlotRef`), auto-mapping (`autoMap`/`bestOption`: a blend wins whenever its predicted ΔE beats the closest spool), `doExport`, and a raw-WebGL2 3D preview (`pv*` functions).

`docs/FORMAT.md` holds the reverse-engineered format reference: the paint encoding, the Prusa full-spectrum JSON, the project-vs-geometry load trap, the minimal bbs `project_settings.config`, and both bbs ColorMix schemas. Read it before you change anything in export or import.

## Conventions and invariants

- `PAINTPORT_VERSION` in the core is the only version source (UI badge and `Generator` metadata). Releases also update `CHANGELOG.md` (Keep a Changelog) and both READMEs where relevant.
- Every user-facing string goes in `I18N` in **both** `de` and `en`. The release gate checks key parity.
- Code comments and test output are in German. Match that when editing.
- Object names from imported files must reach the DOM only through `esc(...)`, and filament colors only through `normalizeHex`. `test_regression.mjs` statically asserts this (for example, no raw `${o.name}` in the HTML).
- If "Allow ColorMix" is off, the export must throw instead of writing blends. The regression suite checks this invariant with a regex on the source.
- Keep it a single file with no external requests: no CDN, no network, and the only storage is the localStorage keys for language, theme, welcome-seen and slot colors (`paintport_slots`). The Reset button reloads the page but keeps all of these.
- License: AGPL-3.0. The formats were reimplemented for interoperability, so don't copy code from PrusaSlicer, Primed3D or the slicer sources.
