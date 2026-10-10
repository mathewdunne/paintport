// Phase 5 spike: helpers to slice a painted slab with the PrusaSlicer CLI and read the G-code back.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipAll } from "../../src/core";
import type { PaintNode } from "../../src/core/paint/codec";
import type { Bary } from "./splitGeometry";

const te = new TextEncoder();

export type P = [number, number];
/** A tree in PrusaSlicer's child order, converted to the string's (reversed) order. */
export const leaf = (state: number): PaintNode => ({ state });
export const split = (splitSides: number, special: number, children: PaintNode[]): PaintNode => ({ splitSides, special, children });
export const toStringOrder = (n: PaintNode): PaintNode =>
  "children" in n ? { ...n, children: [...n.children].reverse().map(toStringOrder) } : n;

export function slab3MF(top: [P, P, P], height: number, paint: string): Promise<Uint8Array> {
  const v: number[][] = [...top.map(([x, y]) => [x, y, 0]), ...top.map(([x, y]) => [x, y, height])];
  // Bottom faces down, top faces up (top corners counter-clockwise from above), sides outward.
  const t: [number, number, number, string?][] = [[0, 2, 1], [3, 4, 5, paint], [0, 1, 4], [0, 4, 3], [1, 2, 5], [1, 5, 4], [2, 0, 3], [2, 3, 5]];
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <metadata name="slic3rpe:Version3mf">1</metadata>
 <metadata name="slic3rpe:MmPaintingVersion">1</metadata>
 <resources><object id="1" type="model"><mesh>
  <vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("")}</vertices>
  <triangles>${t.map(([a, b, c, p]) => `<triangle v1="${a}" v2="${b}" v3="${c}"${p ? ` slic3rpe:mmu_segmentation="${p}"` : ""}/>`).join("")}</triangles>
 </mesh></object></resources>
 <build><item objectid="1"/></build>
</model>`;
  return zipAll([
    { name: "[Content_Types].xml", data: te.encode(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`) },
    { name: "_rels/.rels", data: te.encode(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/3dmodel"/></Relationships>`) },
    { name: "3D/3dmodel.model", data: te.encode(model) },
  ]);
}

export interface Segment { tool: number; z: number; type: string; a: P; b: P }

/** Extrusion moves of a G-code file with their tool, layer and feature type. */
export function extrusions(gcode: string): Segment[] {
  const out: Segment[] = [];
  let tool = 0, z = 0, x = 0, y = 0, e = 0, relative = false, type = "";
  for (const raw of gcode.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(";TYPE:")) { type = line.slice(6); continue; }
    const code = line.split(";")[0].trim();
    if (!code) continue;
    const word = code.split(/\s+/);
    if (/^T\d+$/.test(word[0])) { tool = Number(word[0].slice(1)); continue; }
    if (word[0] === "M83") { relative = true; continue; }
    if (word[0] === "M82") { relative = false; continue; }
    if (word[0] === "G92") { for (const w of word) if (w[0] === "E") e = Number(w.slice(1)); continue; }
    if (word[0] !== "G1" && word[0] !== "G0") continue;
    let nx = x, ny = y, de = 0;
    for (const w of word.slice(1)) {
      const val = Number(w.slice(1));
      if (w[0] === "X") nx = val;
      else if (w[0] === "Y") ny = val;
      else if (w[0] === "Z") z = val;
      else if (w[0] === "E") { de = relative ? val : val - e; e = relative ? e + val : val; }
    }
    if (de > 0 && (nx !== x || ny !== y)) out.push({ tool, z, type, a: [x, y], b: [nx, ny] });
    x = nx; y = ny;
  }
  return out;
}

export function baryIn(p: P, [a, b, c]: [P, P, P]): Bary {
  const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  const l0 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / den;
  const l1 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / den;
  return [l0, l1, 1 - l0 - l1];
}


/** Slices a slab whose top face (corners counter-clockwise, model mm) carries `paint`; returns the top layer's infill, in model coordinates. */
export async function sliceTopInfill(cli: string, top: [P, P, P], height: number, paint: string): Promise<Segment[]> {
  const dir = mkdtempSync(join(process.env.SPIKE_OUT ?? tmpdir(), "subtri-"));
  const file = join(dir, "slab.3mf"), gcodePath = join(dir, "slab.gcode");
  writeFileSync(file, await slab3MF(top, height, paint));
  execFileSync(cli, [
    "--export-gcode", "--output", gcodePath, "--center", "100,100",
    "--nozzle-diameter", "0.4,0.4", "--temperature", "215,215", "--first-layer-temperature", "215,215",
    "--filament-diameter", "1.75,1.75", "--extruder-offset", "0x0,0x0", "--retract-length", "0,0",
    "--layer-height", "0.2", "--first-layer-height", "0.2", "--top-solid-layers", "3", "--bottom-solid-layers", "3",
    "--perimeters", "1", "--no-wipe-tower", "--gcode-comments", file,
  ], { stdio: "pipe" });
  const segs = extrusions(readFileSync(gcodePath, "utf8"));
  const topZ = Math.max(...segs.map((s) => s.z));
  // The CLI centers the object's bounding box on 100,100.
  const xs = top.map((q) => q[0]), ys = top.map((q) => q[1]);
  const off: P = [100 - (Math.min(...xs) + Math.max(...xs)) / 2, 100 - (Math.min(...ys) + Math.max(...ys)) / 2];
  const back = (q: P): P => [q[0] - off[0], q[1] - off[1]];
  return segs.filter((s) => Math.abs(s.z - topZ) < 1e-6 && /infill/i.test(s.type)).map((s) => ({ ...s, a: back(s.a), b: back(s.b) }));
}

/** Points along each segment (at 1/4, 1/2, 3/4) with the tool that printed them. */
export function samples(segs: Segment[]): { p: P; tool: number }[] {
  return segs.flatMap((s) => [0.25, 0.5, 0.75].map((f) => ({ p: [s.a[0] + (s.b[0] - s.a[0]) * f, s.a[1] + (s.b[1] - s.a[1]) * f] as P, tool: s.tool })));
}
