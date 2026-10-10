// Reads extrusion moves out of slicer G-code, for checks that slice with the PrusaSlicer CLI.

export type Point2 = [number, number];

export interface Extrusion {
  tool: number;
  z: number;
  /** The `;TYPE:` comment in effect (e.g. "Solid infill", "Top solid infill"). */
  type: string;
  a: Point2;
  b: Point2;
}

/** Every move that extrudes, with its tool, layer height and feature type. Handles absolute and relative E. */
export function extrusions(gcode: string): Extrusion[] {
  const out: Extrusion[] = [];
  let tool = 0, z = 0, x = 0, y = 0, e = 0, relative = false, type = "";
  for (const raw of gcode.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(";TYPE:")) { type = line.slice(6); continue; }
    const code = line.split(";")[0].trim();
    if (!code) continue;
    const words = code.split(/\s+/);
    if (/^T\d+$/.test(words[0])) { tool = Number(words[0].slice(1)); continue; }
    if (words[0] === "M83") { relative = true; continue; }
    if (words[0] === "M82") { relative = false; continue; }
    if (words[0] === "G92") { for (const w of words) if (w[0] === "E") e = Number(w.slice(1)); continue; }
    if (words[0] !== "G1" && words[0] !== "G0") continue;
    let nx = x, ny = y, de = 0;
    for (const w of words.slice(1)) {
      const v = Number(w.slice(1));
      if (w[0] === "X") nx = v;
      else if (w[0] === "Y") ny = v;
      else if (w[0] === "Z") z = v;
      else if (w[0] === "E") { de = relative ? v : v - e; e = relative ? e + v : v; }
    }
    if (de > 0 && (nx !== x || ny !== y)) out.push({ tool, z, type, a: [x, y], b: [nx, ny] });
    x = nx; y = ny;
  }
  return out;
}
