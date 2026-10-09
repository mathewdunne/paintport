// Dev-only server for the AI Paint spike (docs/plans/2026-10-09-ai-paint.md, Task 4) and for
// checking the app against real files. Serves the repo root, so the app is at / and the spike at
// /spike/sam/. Not built, not deployed.
// SPIKE_FILES_DIR: a folder of test models read in place through /@fs/ (e.g. D:/Downloads).
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const extra = process.env.SPIKE_FILES_DIR ? [process.env.SPIKE_FILES_DIR] : [];

export default defineConfig({
  root,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(root, "src") } },
  server: { port: 5180, strictPort: true, fs: { allow: [root, ...extra] } },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
