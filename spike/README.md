# AI Paint spike (dev only)

    set SPIKE_FILES_DIR=D:/Downloads
    npx vite --config spike/vite.config.ts

Open http://localhost:5180/spike/sam/?file=/@fs/D:/Downloads/yoshi.3mf. The page fetches the
SlimSAM weights from Hugging Face in the browser (see docs/plans/2026-10-09-ai-paint.md, Task 4).
The same server serves the app at http://localhost:5180/ for checks against real files.
