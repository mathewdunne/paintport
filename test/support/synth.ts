// Random input generators for the parity suite: paint trees, odd color strings, ZIP
// entries, synthetic 3MF archives (Prusa-, Bambu-, production-extension-style) and
// export plans. Everything is driven by a seeded Rng.
import type { PaintDialect, PaintNode } from "../../src/core/paint/codec";
import type { Build3MFPlan, Model } from "../../src/core/types";
import type { CoreApi } from "./classic";
import type { Rng } from "./prng";

const te = new TextEncoder();

// ---------- paint trees ----------
export function genState(rng: Rng, maxState: number): number {
  const r = rng.next();
  if (r < 0.2) return 0;
  if (r < 0.6) return rng.int(1, Math.min(4, maxState));
  if (r < 0.8) return rng.int(Math.min(5, maxState), Math.min(16, maxState));
  return rng.int(Math.min(17, maxState), maxState);
}

export function genTree(rng: Rng, maxState: number, maxDepth = 5, depth = 0): PaintNode {
  const leafP = depth === 0 ? 0.3 : 0.5 + depth * 0.1;
  if (depth >= maxDepth || rng.bool(leafP)) return { state: genState(rng, maxState) };
  const splitSides = rng.int(1, 3);
  const special = rng.int(0, 3);
  const children: PaintNode[] = [];
  for (let c = 0; c <= splitSides; c++) children.push(genTree(rng, maxState, maxDepth, depth + 1));
  return { splitSides, special, children };
}

/** Largest state each dialect can encode; prusa's escape field is 8 bits (17 + 255). */
export const MAX_STATE: Record<PaintDialect, number> = { prusa: 272, bbs: 300 };

// ---------- strings of all kinds ----------
export function genHex(rng: Rng, n: number, upper = rng.bool()): string {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[rng.int(0, 15)];
  return upper ? s.toUpperCase() : s;
}

/** Inputs for normalizeHex/hexToRgb: valid colors in every spelling plus garbage. */
export function genColorInput(rng: Rng): unknown {
  switch (rng.int(0, 17)) {
    case 0: return "#" + genHex(rng, 6);
    case 1: return genHex(rng, 6);
    case 2: return "#" + genHex(rng, 3);
    case 3: return genHex(rng, 3);
    case 4: return "#" + genHex(rng, 8);
    case 5: return `  #${genHex(rng, 6)}\t`;
    case 6: return "#" + genHex(rng, rng.int(1, 2));
    case 7: return "#" + genHex(rng, 4);
    case 8: return "#" + genHex(rng, 5);
    case 9: return "#" + genHex(rng, 7);
    case 10: return rng.pick(["", "#", "zz", "#GGGGGG", "red", '"><b>x', "#12 34", "0x123456", "##123456"]);
    case 11: return rng.pick([null, undefined, 0, false, NaN]);
    case 12: return rng.pick([123456, 255, 1e21, 0.5, -1, true]);
    case 13: return "#" + genHex(rng, 6, true).replace(/./, "G");
    default: return "#" + genHex(rng, 6);
  }
}

export function genValidHex(rng: Rng): string {
  return "#" + genHex(rng, 6, true);
}

export function genNumberStr(rng: Rng): string {
  switch (rng.int(0, 5)) {
    case 0: return String(rng.int(-50, 50));
    case 1: return rng.pick(["1e-3", "5e2", "-2.5e1", "0.5", ".25", "-0"]);
    default: return String(Math.round((rng.next() * 200 - 100) * 10 ** rng.int(0, 6)) / 10 ** rng.int(0, 6));
  }
}

// ---------- ZIP ----------
export function genZipEntries(rng: Rng): { name: string; data: Uint8Array }[] {
  const n = rng.int(0, 6);
  const out: { name: string; data: Uint8Array }[] = [];
  for (let i = 0; i < n; i++) {
    const kind = rng.int(0, 6);
    let name = rng.pick(["a.txt", "3D/3dmodel.model", "Metadata/x.config", "dir/", "ünï/cödé.bin", "deep/er/path/file.xml", "[Content_Types].xml"]);
    if (rng.bool(0.4)) name += i; // keep most names distinct; duplicates are covered by the other 60%
    let data: Uint8Array;
    if (kind === 0) data = new Uint8Array(0);
    else if (kind === 1) data = rng.bytes(rng.int(1, 40));
    else if (kind === 2) data = rng.bytes(rng.int(100, 3000), true);
    else if (kind === 3) data = rng.bytes(rng.int(100, 3000));
    else if (kind === 4) data = te.encode("<a>".repeat(rng.int(1, 400)));
    else if (kind === 5) data = rng.bytes(rng.int(20000, 80000), true);
    else data = rng.bytes(rng.int(20000, 40000));
    out.push({ name, data });
  }
  return out;
}

// ---------- 3MF archives ----------
const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
const NAMES = ["Figure", "Fig<ure>", "A&B", "Ünï cödé", "Obj 1", "Base plate", "x'y", "", "Part (2)"];
const SUBTYPES = ["normal_part", "normal_part", "negative_part", "modifier_part", "support_blocker", "support_enforcer", "mystery", "constructor", "toString", "__proto__", undefined];

type MeshDialect = "prusa" | "bbs" | "mixed" | "none";

interface MeshOpts {
  dialect: MeshDialect;
  paintRate: number;
  maxState: number;
}

function genVertexXml(rng: Rng, n: number): string {
  const style = rng.pick(["fast", "fast", "spaced", "reordered", "withid", "mixed"] as const);
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = genNumberStr(rng), y = genNumberStr(rng), z = genNumberStr(rng);
    const st = style === "mixed" ? rng.pick(["fast", "reordered", "spaced"] as const) : style;
    if (st === "fast") lines.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
    else if (st === "spaced") lines.push(`<vertex x="${x}" y="${y}" z="${z}" />`);
    else if (st === "reordered") lines.push(`<vertex z="${z}" x="${x}" y="${y}"/>`);
    else lines.push(`<vertex id="${i}" x="${x}" y="${y}" z="${z}"/>`);
  }
  return lines.join(rng.bool() ? "\n" : "");
}

function genTriangleXml(rng: Rng, core: CoreApi, nVerts: number, nTris: number, o: MeshOpts): string {
  const lines: string[] = [];
  for (let i = 0; i < nTris; i++) {
    const attrs = [`v1="${rng.int(0, nVerts - 1)}"`, `v2="${rng.int(0, nVerts - 1)}"`, `v3="${rng.int(0, nVerts - 1)}"`];
    if (o.dialect !== "none" && rng.bool(o.paintRate)) {
      const d: PaintDialect = o.dialect === "mixed" ? rng.pick(["prusa", "bbs"] as const) : o.dialect;
      const tree = genTree(rng, Math.min(o.maxState, MAX_STATE[d]), 3);
      const str = core.emitPaintTree(tree, d);
      attrs.push(d === "prusa" ? `slic3rpe:mmu_segmentation="${str}"` : `paint_color="${str}"`);
      if (rng.bool(0.03)) attrs.push(`paint_color="${core.emitPaintTree({ state: 1 }, "bbs")}"`); // both attributes: prusa wins
    } else if (rng.bool(0.05)) {
      attrs.push(rng.pick(['paint_color=""', 'slic3rpe:mmu_segmentation=""', 'paint_color="0"', 'paint_color="4"']));
    }
    if (rng.bool(0.2)) rng.shuffle(attrs);
    lines.push(`<triangle ${attrs.join(" ")}/>`);
  }
  return lines.join(rng.bool() ? "\n" : "");
}

interface GenMesh {
  xml: string;
  nTris: number;
}
function genMeshXml(rng: Rng, core: CoreApi, o: MeshOpts): GenMesh {
  const empty = rng.bool(0.03);
  const nVerts = empty ? 0 : rng.int(3, 12);
  const nTris = empty ? 0 : rng.int(1, 14);
  const verts = genVertexXml(rng, nVerts);
  const tris = genTriangleXml(rng, core, nVerts, nTris, o);
  return { xml: `<mesh><vertices>${verts}</vertices><triangles>${tris}</triangles></mesh>`, nTris };
}

function genTransform(rng: Rng): string {
  if (rng.bool(0.2)) return rng.pick(["1 0 0", "abc", "1 0 0 0 1 0 0 0 1 0 0 0 5", " "]);
  const m = [1, 0, 0, 0, 1, 0, 0, 0, 1].map((v) => (rng.bool(0.3) ? Math.round(rng.next() * 200 - 100) / 100 : v));
  const t = [rng.int(-100, 100), rng.int(-100, 100), rng.int(0, 50)];
  return [...m, ...t].join(rng.bool() ? " " : "  ");
}

function modelXml(rng: Rng, unit: string | null, objects: string[], items: string[]): string {
  const unitAttr = unit === null ? "" : `unit="${unit}" `;
  const meta = rng.bool(0.5) ? ' <metadata name="Application">BambuStudio-02.04.00.70</metadata>\n' : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<model ${unitAttr}xml:lang="en-US" ${NS}>\n${meta} <resources>\n${objects.join("\n")}\n </resources>\n <build>\n${items.join("\n")}\n </build>\n</model>\n`;
}

function projectSettings(rng: Rng): string {
  if (rng.bool(0.06)) return rng.pick(["{not json", "null", "[]", '{"filament_colour":"notarray"}', "", '{"filament_colour":[null,5,"#ff0000"]}', "5"]);
  const j: Record<string, unknown> = {};
  const nCol = rng.int(1, 9);
  j.filament_colour = Array.from({ length: nCol }, () => genColorInput(rng)).map((c) => (typeof c === "string" || c == null ? c : String(c)));
  if (rng.bool(0.6)) {
    if (rng.bool(0.8)) j.printer_settings_id = rng.pick(["Bambu Lab X1 Carbon 0.4 nozzle", "Snapmaker U1 (0.4 nozzle)", ""]);
    if (rng.bool(0.8)) j.printer_model = rng.pick(["Bambu Lab X1 Carbon", "Snapmaker U1"]);
    if (rng.bool(0.5)) j.printer_variant = rng.pick(["0.4", "0.6", 0.4]);
    if (rng.bool(0.6)) j.nozzle_diameter = rng.pick([["0.4"], ["0.4", "0.4", "0.4", "0.4"], 0.4, null]);
    if (rng.bool(0.8)) j.print_settings_id = "0.20mm Standard @BBL X1C";
    if (rng.bool(0.7)) j.filament_settings_id = rng.pick([["Bambu PLA Basic @BBL X1C", "Generic PETG"], [], "single", ["X"]]);
    if (rng.bool(0.7)) j.filament_type = rng.pick([["PLA", "PETG"], ["PETG"], [], "PLA"]);
  }
  return JSON.stringify(j);
}

export interface Scenario {
  label: string;
  files: { name: string; data: Uint8Array }[];
}

/**
 * One random 3MF archive: flat, production-extension, or inline-component layout, with
 * Prusa or Bambu paint attributes, optional config files, and occasionally an error
 * condition (missing model, wrong unit, missing reference, no objects, broken paint).
 */
export function genScenario(rng: Rng, core: CoreApi): Scenario {
  const dialect = rng.pick<MeshDialect>(["prusa", "prusa", "bbs", "bbs", "bbs", "none", "mixed"]);
  const mo: MeshOpts = { dialect, paintRate: rng.pick([0, 0.3, 0.8, 1]), maxState: rng.pick([4, 8, 16, 40, 120, 300]) };
  const layout = rng.pick(["flat", "flat", "production", "production", "inline"] as const);
  const files: { name: string; data: Uint8Array }[] = [];
  const objects: string[] = [];
  const items: string[] = [];
  const settings: string[] = []; // <object> blocks of model_settings.config
  const itemAttrs = (id: string): string => {
    const a = [`objectid="${id}"`];
    if (rng.bool(0.35)) a.push(`transform="${genTransform(rng)}"`);
    if (rng.bool(0.2)) a.push(`printable="${rng.pick(["0", "1"])}"`);
    return `  <item ${a.join(" ")}/>`;
  };
  const objAttrs = (id: string): string => `id="${id}" type="model"${rng.bool(0.5) ? ` name="${rng.pick(NAMES)}"` : ""}`;
  const metaBlock = (id: string, parts: string): string => {
    const lines: string[] = [];
    if (rng.bool(0.7)) lines.push(`  <metadata key="name" value="${rng.pick(NAMES)}"/>`);
    if (rng.bool(0.7)) lines.push(`  <metadata key="extruder" value="${rng.pick(["1", "2", "3", "4", "0", "x", "7", "12"])}"/>`);
    return ` <object id="${id}">\n${lines.join("\n")}\n${parts} </object>`;
  };
  const partBlock = (id: string, extra = ""): string => {
    const sub = rng.pick(SUBTYPES);
    const lines: string[] = [];
    if (rng.bool(0.6)) lines.push(`   <metadata key="name" value="${rng.pick(NAMES)}"/>`);
    if (rng.bool(0.6)) lines.push(`   <metadata key="extruder" value="${rng.pick(["1", "2", "3", "5", "0", "z"])}"/>`);
    return `  <part id="${id}"${sub ? ` subtype="${sub}"` : ""}${extra}>\n${lines.join("\n")}\n  </part>\n`;
  };

  if (layout === "flat") {
    const n = rng.int(1, 3);
    for (let k = 1; k <= n; k++) {
      const id = String(k);
      const mesh = genMeshXml(rng, core, mo);
      objects.push(`  <object ${objAttrs(id)}>${mesh.xml}</object>`);
      items.push(itemAttrs(id));
      if (rng.bool(0.55)) {
        let parts = "";
        if (rng.bool(0.5) && mesh.nTris > 0) {
          // range parts: mostly ascending and contiguous, sometimes broken on purpose
          let cursor = 0;
          const k2 = rng.int(1, 4);
          for (let r = 0; r < k2; r++) {
            let first = cursor + (rng.bool(0.3) ? rng.int(1, 3) : 0);
            let last = first + rng.int(0, 5);
            if (rng.bool(0.1)) [first, last] = [last, first];
            if (rng.bool(0.1)) first = Math.max(0, first - rng.int(1, 4));
            parts += partBlock(String(10 + r), ` firstid="${first}" lastid="${last}"`);
            cursor = last + 1;
          }
          if (rng.bool(0.3)) parts += partBlock("20", ' firstid="x" lastid="3"');
        }
        settings.push(metaBlock(id, parts));
      }
    }
    if (rng.bool(0.1)) items.push(itemAttrs("99")); // reference to a missing object: skipped
    files.push({ name: "3D/3dmodel.model", data: te.encode(modelXml(rng, "millimeter", objects, items)) });
  } else {
    // production / inline: assemblies with components
    const nAsm = rng.int(1, 3);
    const mainObjects: string[] = [];
    let nextMain = 1;
    const inlineMeshIds: string[] = [];
    if (layout === "inline") {
      const nm = rng.int(1, 4);
      for (let k = 0; k < nm; k++) {
        const id = String(nextMain++);
        mainObjects.push(`  <object ${objAttrs(id)}>${genMeshXml(rng, core, mo).xml}</object>`);
        inlineMeshIds.push(id);
      }
    }
    for (let a = 0; a < nAsm; a++) {
      const asmId = String(nextMain++);
      const nComp = rng.int(1, 4);
      const extPath = `3D/Objects/object_${asmId}.model`;
      const extObjs: string[] = [];
      const comps: string[] = [];
      const partBlocks: string[] = [];
      for (let c = 1; c <= nComp; c++) {
        let target: string;
        let compPathAttr = "";
        if (layout === "production") {
          target = String(c);
          extObjs.push(`  <object ${objAttrs(target)}>${genMeshXml(rng, core, mo).xml}</object>`);
          const p = rng.bool(0.7) ? "/" + extPath : extPath;
          compPathAttr = ` p:path="${p}"`;
          if (c === nComp && rng.bool(0.2)) {
            // nested group inside the external file, one level deeper
            const gid = String(50 + c);
            const innerPath = rng.bool(0.5) ? ` p:path="/${extPath}"` : "";
            extObjs.push(`  <object id="${gid}" type="model"><components><component objectid="${target}"${innerPath}${rng.bool(0.5) ? ` transform="${genTransform(rng)}"` : ""}/></components></object>`);
            target = gid;
          }
        } else {
          target = rng.pick(inlineMeshIds);
          if (c === nComp && rng.bool(0.2) && nAsm > 1) {
            // reference another inline object that is itself an assembly (nested), if any exists
            target = rng.pick([...inlineMeshIds, "999"]);
          }
        }
        if (rng.bool(0.08)) target = "404"; // dangling component: skipped
        comps.push(`   <component${compPathAttr} objectid="${target}"${rng.bool(0.5) ? ` transform="${genTransform(rng)}"` : ""}/>`);
        if (rng.bool(0.6)) partBlocks.push(partBlock(target));
      }
      if (layout === "production") {
        files.push({ name: extPath, data: te.encode(modelXml(rng, "millimeter", extObjs, [])) });
      }
      const inlineMesh = rng.bool(0.1) ? genMeshXml(rng, core, mo).xml : "";
      mainObjects.push(`  <object ${objAttrs(asmId)}>${inlineMesh}<components>\n${comps.join("\n")}\n  </components></object>`);
      items.push(itemAttrs(asmId));
      if (rng.bool(0.7)) settings.push(metaBlock(asmId, partBlocks.join("")));
    }
    // nested assembly in main (inline layout): an assembly that references a previous assembly
    if (layout === "inline" && rng.bool(0.3)) {
      const gid = String(nextMain++);
      mainObjects.push(`  <object id="${gid}" type="model"><components><component objectid="${nextMain - 2}"/></components></object>`);
      items.push(itemAttrs(gid));
    }
    if (rng.bool(0.1)) items.push(itemAttrs(inlineMeshIds[0] ?? "1")); // item pointing at a mesh object / duplicate
    files.push({ name: "3D/3dmodel.model", data: te.encode(modelXml(rng, "millimeter", mainObjects, items)) });
  }

  if (settings.length) {
    files.push({ name: "Metadata/model_settings.config", data: te.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${settings.join("\n")}\n</config>\n`) });
  }
  if (rng.bool(0.6)) files.push({ name: "Metadata/project_settings.config", data: te.encode(projectSettings(rng)) });
  if (rng.bool(0.3)) files.push({ name: "Metadata/Slic3r_PE_model.config", data: te.encode("<config/>") });

  // error injection
  let label = `${layout}/${dialect}`;
  if (rng.bool(0.12)) {
    const err = rng.pick(["noModel", "inch", "noUnit", "badUnit", "missingRef", "noObjects", "badPaint", "emptyModel"] as const);
    label += `/!${err}`;
    const mi = files.findIndex((f) => f.name === "3D/3dmodel.model");
    const dec = new TextDecoder();
    const xml = dec.decode(files[mi].data);
    switch (err) {
      case "noModel": files.splice(mi, 1); break;
      case "inch": files[mi].data = te.encode(xml.replace('unit="millimeter"', 'unit="inch"')); break;
      case "noUnit": files[mi].data = te.encode(xml.replace('unit="millimeter" ', "")); break;
      case "badUnit": files[mi].data = te.encode(xml.replace('unit="millimeter"', 'unit="micron"')); break;
      case "missingRef":
        files[mi].data = te.encode(xml.replace("<components>", '<components><component p:path="/3D/Objects/gone.model" objectid="1"/>').replace(/<object (id="1"[^>]*)>(<mesh>)/, '<object $1><components><component p:path="/3D/Objects/gone.model" objectid="1"/></components>$2'));
        break;
      case "noObjects": files[mi].data = te.encode(xml.replace(/<item [^>]*\/>/g, "")); break;
      case "badPaint":
        files[mi].data = te.encode(xml.replace(/<triangle v1="(\d+)"/, `<triangle paint_color="${rng.pick(["ZZ", "4G", "", "FF", "C", "1234567", "E"])}x" v1="$1"`));
        break;
      case "emptyModel": files[mi].data = te.encode("<model></model>"); break;
    }
  }
  return { label, files };
}

// ---------- export plans ----------
export interface PlanSpec {
  label: string;
  /** Fresh plan each call, so the two implementations never share mutable state. */
  make: () => Build3MFPlan;
}

export function genPlan(rng: Rng, model: Model): PlanSpec {
  const kind = rng.pick(["prusa", "prusa", "bambuBambu", "bambuBambu", "bambuSnap", "bambuSnap", "bambuNoMix", "default"] as const);
  const target = kind === "prusa" ? "prusa" : kind === "default" ? undefined : "bambu";
  const mixFormat = kind === "bambuBambu" ? "bambu" : kind === "bambuSnap" ? "snapmaker" : undefined;
  const P = target === "bambu" ? (kind === "bambuBambu" && rng.bool(0.1) ? rng.int(14, 16) : rng.int(2, 12)) : rng.int(1, 20);
  const wantVirtuals = kind === "bambuNoMix" ? (rng.bool(0.15) ? 1 : 0) : rng.pick([0, 0, 1, 2, 3]);
  const virtuals: { id: number; color: string; components: { extruder: number; ratio: number }[] }[] = [];
  for (let k = 0; k < wantVirtuals; k++) {
    const nComp = rng.bool(0.02) ? 1 : rng.pick([2, 2, 3]);
    const comps = Array.from({ length: nComp }, () => ({
      extruder: rng.bool(0.03) ? rng.pick([0, P + 1]) : rng.int(1, P),
      ratio: rng.bool(0.15) ? rng.pick([0.5, 2.5, 7]) : rng.int(1, 4),
    }));
    virtuals.push({ id: P + k + 1 + (rng.bool(0.04) ? 1 : 0), color: genValidHex(rng), components: comps });
  }
  if (rng.bool(0.4)) rng.shuffle(virtuals);
  const nSrc = Math.max(model.filaments.length, 1) + rng.int(0, 3);
  const entries: [number, number][] = [];
  for (let s = 1; s <= nSrc; s++) {
    if (!rng.bool(0.85)) continue;
    const dst = virtuals.length && rng.bool(0.3) ? rng.pick(virtuals).id : rng.int(1, P);
    entries.push([s, dst]);
  }
  const extra = {
    ...(rng.bool(0.7) ? { title: rng.pick(["Fig", 'T<i>tle & "x"', "Ünï", ""]) } : {}),
    ...(rng.bool(0.7) ? { date: rng.pick(["2026-07-05", "1999-12-31"]) } : {}),
    ...(rng.bool(0.4) ? { bbsApp: rng.pick(["BambuStudio-02.07.01.62", "Snapmaker_Orca-2.3.5", "Orca <x>&y", ""]) } : {}),
  };
  const physicalColors = Array.from({ length: P }, () => genValidHex(rng));
  return {
    label: `${kind} P=${P} V=${virtuals.length}`,
    make: () => ({
      ...(target ? { target } : {}),
      ...(mixFormat ? { mixFormat } : {}),
      ...extra,
      stateMap: new Map(entries),
      physical: physicalColors.map((color, i) => ({ slot: i + 1, color })),
      virtuals: virtuals.map((v) => ({ id: v.id, color: v.color, components: v.components.map((c) => ({ ...c })) })),
    }),
  };
}

/** Cross-realm-safe model variants that exercise build3MF fallbacks. */
export type ModelVariant = "same" | "noParts" | "partsUndefined" | "unprintable" | "noDialect" | "noIdentity" | "identity";

export function variantOf(model: Model, v: ModelVariant): Model {
  switch (v) {
    case "same": return model;
    case "noParts": return { ...model, objects: model.objects.map((o) => ({ ...o, parts: [] })) };
    case "partsUndefined": return { ...model, objects: model.objects.map((o) => ({ ...o, parts: undefined as never })) };
    case "unprintable": return { ...model, objects: model.objects.map((o, i) => ({ ...o, printable: i % 2 === 0 ? false : o.printable, transform: o.transform ?? "1 0 0 0 1 0 0 0 1 <&>" })) };
    case "noDialect": return { ...model, paintDialect: undefined as never };
    case "noIdentity": return { ...model, sourceIdentity: null };
    case "identity":
      return {
        ...model,
        sourceIdentity: {
          printer_settings_id: "Bambu Lab H2D 0.4 nozzle", printer_model: "Bambu Lab H2D", printer_variant: "0.4",
          nozzle_diameter: ["0.4", "0.4"], print_settings_id: "0.20mm Standard", filament_settings_id: ["Bambu PETG HF", "x"],
          filament_type: ["PETG", "PLA"],
        },
      };
  }
}
