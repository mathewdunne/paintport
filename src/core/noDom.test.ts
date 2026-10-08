// Guard: src/core must run headless in Node and in browsers, so no DOM/browser globals,
// React, or three.js, and no imports that reach outside src/core. Test files are exempt
// (they are not part of the shipped core).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreDir = resolve(fileURLToPath(new URL(".", import.meta.url)));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

/** Removes comments so prose such as "the window of ..." cannot trigger the guard. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN: [string, RegExp][] = [
  ["document", /\bdocument\b/],
  ["window", /\bwindow\b/],
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["indexedDB", /\bindexedDB\b/],
  ["navigator", /\bnavigator\b/],
  ["self.", /\bself\./],
  ["fetch(", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["HTMLElement", /\bHTMLElement\b/],
  ["react import", /from\s+["']react(?:\/[^"']*)?["']/],
  ["react-dom import", /from\s+["']react-dom(?:\/[^"']*)?["']/],
  ["three import", /from\s+["']three(?:\/[^"']*)?["']/],
  ["three-mesh-bvh import", /from\s+["']three-mesh-bvh["']/],
  ["globalThis assignment", /globalThis\.\w+\s*=[^=]/],
];

describe("src/core stays DOM-free", () => {
  const files = sourceFiles(coreDir);

  it("finds the core sources", () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it.each(FORBIDDEN)("no %s", (_name, re) => {
    const offenders = files.filter((f) => re.test(stripComments(readFileSync(f, "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("every relative import resolves to a file inside src/core", () => {
    const importRe = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g;
    const escaped: string[] = [];
    const unresolved: string[] = [];
    for (const f of files) {
      for (const m of stripComments(readFileSync(f, "utf8")).matchAll(importRe)) {
        const target = resolve(dirname(f), m[1]);
        const rel = relative(coreDir, target);
        if (rel.startsWith("..") || rel.split(sep)[0] === "..") { escaped.push(`${relative(coreDir, f)} -> ${m[1]}`); continue; }
        if (!existsSync(target + ".ts") && !existsSync(join(target, "index.ts"))) unresolved.push(`${relative(coreDir, f)} -> ${m[1]}`);
      }
    }
    expect(escaped).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});
