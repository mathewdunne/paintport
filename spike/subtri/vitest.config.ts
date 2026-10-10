import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Spike-only checks (opt-in, real files by path): `npx vitest run --config spike/subtri/vitest.config.ts`.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  test: { include: ["spike/subtri/**/*.spike.ts"], root: fileURLToPath(new URL("../..", import.meta.url)) },
});
