# AI Paint spike (dev only)

    set SPIKE_FILES_DIR=D:/Downloads
    npx vite --config spike/vite.config.ts

Open http://localhost:5180/spike/sam/?file=/@fs/D:/Downloads/yoshi.3mf. The page fetches the
SlimSAM weights from Hugging Face in the browser (see docs/plans/2026-10-09-ai-paint.md, Task 4).
The same server serves the app at http://localhost:5180/ for checks against real files.

# Sub-triangle spike (dev only)

Phase 5, report in docs/plans/2026-10-09-subtriangle-spike.md. Opt-in checks (real files by path):

    SPIKE_FILES="D:/Downloads/charizar.3mf;D:/Downloads/goldfish_colormix_4t.3mf" npx vitest run --config spike/subtri/vitest.config.ts --disableConsoleIntercept edgeCheck flatten
    PRUSA_CLI="C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe" npx vitest run --config spike/subtri/vitest.config.ts --disableConsoleIntercept prusaSlice brush

Fill cost on a file with many trees (after the build): `fillPerf` and `piecesPerf` with `SPIKE_FILES` set as above.

Render comparison: start the server above, then open
http://localhost:5180/spike/subtri/?file=/@fs/D:/Downloads/goldfish_colormix_4t.3mf&leaves=1
(`window.spike.focus(rank, distance)`, `compare("tree", "leaves")`, `bench()` in the console).
