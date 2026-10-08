/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base "./" keeps asset URLs relative so the build works under the GitHub Pages
// sub-path (/paintport/) as well as at the site root.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  build: {
    chunkSizeWarningLimit: 600, // the three chunk alone is ~550 kB
    rolldownOptions: {
      output: {
        // three.js is ~550 kB and changes rarely: keep it out of the app chunk (it is still
        // loaded up front, not lazily).
        codeSplitting: { groups: [{ name: "three", test: /node_modules[\\/]three[\\/]/ }] },
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "test/**/*.test.ts"],
  },
});
