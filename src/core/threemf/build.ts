import { CoreError } from "../errors";
import { emitPaintTree, remapPaintString, type PaintDialect } from "../paint/codec";
import type { Build3MFPlan, Build3MFResult, Model, VolumeType } from "../types";
import { PAINTPORT_VERSION } from "../version";
import { VOLUME_TYPES } from "./load";

function xmlEscape(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// PrusaSlicer volume_type -> bbs subtype. The bbs slicers' ModelVolume::type_from_string
// knows ONLY these strings; Prusa names silently fall back to normal_part there, so a
// NegativeVolume would be printed solid.
const BBS_VOLUME_TYPES: Record<string, string> = Object.fromEntries(Object.entries(VOLUME_TYPES).flatMap(([k, v]) => (v ? [[v, k]] : [])));

/** A run of triangles with one volume type and (mapped) base extruder. */
interface VolumeRange {
  firstid: number;
  lastid: number;
  extruder: number;
  type: VolumeType;
  name: string | null;
}

/** An exported object, kept for the slicer config (model_settings / Slic3r_PE_model). */
interface ConfigObject {
  id: number;
  name: string;
  ranges: VolumeRange[];
  childIds: number[] | null;
}

export function build3MF(model: Model, plan: Build3MFPlan): Build3MFResult {
  // "bambu" covers Bambu Studio, Snapmaker Orca and (in future) upstream OrcaSlicer -
  // they share the bbs_3mf.cpp base, which reads paint_color unconditionally and
  // range volumes (firstid/lastid) through the same <part>/<volume> handler.
  const bambu = plan.target === "bambu";
  const outDialect: PaintDialect = bambu ? "bbs" : "prusa"; // leaf-state dialect of the export (see parsePaintTree)
  // ColorMix in the bbs world comes in two formats: Snapmaker Orca (mixFormat
  // "snapmaker") = the compact mixed_filament_definitions string; Bambu Studio
  // (mixFormat "bambu") = per-slot arrays filament_is_mixed/_components/_ratios (mixes are
  // regular filament slots of the same list there; ground truth: SpeedBoat).
  const smMix = bambu && plan.mixFormat === "snapmaker";
  const bsMix = bambu && plan.mixFormat === "bambu";
  if (bambu && !smMix && !bsMix && plan.virtuals && plan.virtuals.length) {
    throw new CoreError("ERR_BBS_NO_MIX");
  }
  if (bsMix && plan.virtuals && plan.virtuals.length && plan.physical.length + plan.virtuals.length > 16) {
    throw new CoreError("ERR_BBS_MAX16");
  }
  let maxState = 0;
  const mapState = (s: number): number => {
    const d = plan.stateMap.get(s);
    return d === undefined ? s : d;
  };
  const ATTR_PAINT = bambu ? "paint_color" : "slic3rpe:mmu_segmentation";
  const leafCache = new Map<number, string>(); // paint-all: leaf string per mapped extruder state
  const leafStr = (s: number): string => {
    let v = leafCache.get(s);
    if (v === undefined) { v = emitPaintTree({ state: s }, outDialect); leafCache.set(s, v); }
    return v;
  };

  const modelParts: string[] = [];
  modelParts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  const today = plan.date || "2026-01-01";
  // Application string per target: it sets m_is_bbl_3mf (the "BambuStudio-" prefix) AND
  // provides file_version (bbs_3mf.cpp: file_version = m_bambuslicer_generator_version)
  // for the version dialogs in Plater.cpp - it should match the target slicer's version.
  const bbsApp = plan.bbsApp || "BambuStudio-2.3.5";
  if (bambu) {
    // Header as in files saved by Snapmaker Orca / Bambu Studio; it also suppresses the
    // BS >= 2.5 color-conversion dialog.
    // Deliberately NO MmPaintingVersion metadata: BambuStudio:MmPaintingVersion > 0 makes
    // the bbs import throw version_error (MM_PAINTING_VERSION = 0), the slic3rpe variant
    // is ignored, and real bbs files do not write one.
    modelParts.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n');
    modelParts.push(` <metadata name="Application">${xmlEscape(bbsApp)}</metadata>\n`);
    modelParts.push(' <metadata name="BambuStudio:3mfVersion">1</metadata>\n');
    modelParts.push(` <metadata name="Generator">PaintPort-${PAINTPORT_VERSION}</metadata>\n`);
    modelParts.push(` <metadata name="Title">${xmlEscape(plan.title || "PaintPort Export")}</metadata>\n`);
    modelParts.push(` <metadata name="CreationDate">${today}</metadata>\n`);
  } else {
    modelParts.push('<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n');
    // MmPaintingVersion is only known after the remap -> placeholder, replaced at the end
    modelParts.push(" <metadata name=\"slic3rpe:Version3mf\">1</metadata>\n");
    modelParts.push("__MM_VERSION__");
    // "PrusaSlicer-<version>" in the Application metadata is how PrusaSlicer recognizes a
    // project 3MF (is_project_3mf): without this marker and without Slic3r_PE.config,
    // drag&drop / double-click SILENTLY loads the file as plain geometry and discards
    // Prusa_Slicer_full_spectrum.json together with the virtual extruders. It must sit in
    // the first 1024 bytes -> before the (variable-length) Title.
    modelParts.push(` <metadata name="Application">PrusaSlicer-2.9.6</metadata>\n`);
    modelParts.push(` <metadata name="Generator">PaintPort-${PAINTPORT_VERSION}</metadata>\n`);
    modelParts.push(` <metadata name="Title">${xmlEscape(plan.title || "PaintPort Export")}</metadata>\n`);
    modelParts.push(` <metadata name="CreationDate">${today}</metadata>\n`);
  }
  modelParts.push(" <resources>\n");

  const configObjects: ConfigObject[] = [];
  const buildIds: number[] = []; // export object id per model.objects entry (composite: parent id)
  let nextId = 1;
  model.objects.forEach((o) => {
    const t = o.tris;
    // Volume ranges per part base extruder; consecutive ModelParts with the same target
    // extruder are merged (without part overrides => exactly one range, as before).
    // Negative/modifier/support volumes stay separate and do not print => no extruder.
    // (Computed before the triangle loop because paint-all needs the ranges.)
    const srcParts = (o.parts && o.parts.length) ? o.parts : [{ firstTri: 0, triCount: t.length / 3, extruder: o.defaultExtruder, type: "ModelPart" as VolumeType, name: null }];
    const ranges: VolumeRange[] = [];
    for (const p of srcParts) {
      const type = p.type || "ModelPart";
      const ext = (type === "ModelPart" || type === "ParameterModifier") ? mapState(p.extruder) : 0;
      const last = ranges[ranges.length - 1];
      if (type === "ModelPart" && last && last.type === "ModelPart" && last.extruder === ext) last.lastid = p.firstTri + p.triCount - 1;
      else ranges.push({ firstid: p.firstTri, lastid: p.firstTri + p.triCount - 1, extruder: ext, type, name: p.name || null });
    }
    // Paint-all (bbs): unpainted ModelPart triangles get the leaf state of their mapped
    // base extruder - belt and braces next to the config's extruder key; ZIP absorbs the
    // redundancy. Special volumes (they do not print) stay unpainted.
    let fill: Int32Array | null = null;
    if (bambu) {
      fill = new Int32Array(t.length / 3);
      for (const r of ranges) if (r.type === "ModelPart" && r.extruder > 0) fill.fill(r.extruder, r.firstid, r.lastid + 1);
    }
    // The bbs import only knows component parts: _generate_volumes_new matches <part id>
    // against component object ids; the old range path (_generate_volumes, firstid/
    // lastid) is dead code in both Bambu AND Snapmaker (no call sites). Objects with
    // special volumes must therefore be exported as parent + components with their own
    // mesh objects - otherwise negative volumes would turn solid. Pure ModelPart objects
    // stay flat (paint-all carries the colors; part id == object id for the metadata
    // matching).
    const composite = bambu && ranges.some((r) => r.type !== "ModelPart");
    const emitTriangle = (v1: number, v2: number, v3: number, i: number, fillState: number): void => {
      const p = o.paints[i];
      if (p) {
        const rm = remapPaintString(p, mapState, model.paintDialect || "bbs", outDialect);
        if (rm.maxState > maxState) maxState = rm.maxState;
        modelParts.push(`     <triangle v1="${v1}" v2="${v2}" v3="${v3}" ${ATTR_PAINT}="${rm.str}"/>\n`);
      } else if (fillState > 0) {
        if (fillState > maxState) maxState = fillState;
        modelParts.push(`     <triangle v1="${v1}" v2="${v2}" v3="${v3}" paint_color="${leafStr(fillState)}"/>\n`);
      } else {
        modelParts.push(`     <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>\n`);
      }
    };
    const v = o.vertices;
    if (!composite) {
      const objId = nextId++;
      modelParts.push(`  <object id="${objId}" type="model">\n   <mesh>\n    <vertices>\n`);
      for (let i = 0; i < v.length; i += 3) {
        modelParts.push(`     <vertex x="${v[i]}" y="${v[i + 1]}" z="${v[i + 2]}"/>\n`);
      }
      modelParts.push("    </vertices>\n    <triangles>\n");
      for (let i = 0; i < t.length / 3; i++) emitTriangle(t[i * 3], t[i * 3 + 1], t[i * 3 + 2], i, fill ? fill[i] : 0);
      modelParts.push("    </triangles>\n   </mesh>\n  </object>\n");
      buildIds.push(objId);
      configObjects.push({ id: objId, name: o.name, ranges, childIds: null });
    } else {
      // One mesh object per range (the range's vertices extracted and re-indexed)
      const childIds: number[] = [];
      for (const r of ranges) {
        const cid = nextId++;
        childIds.push(cid);
        const fillState = (r.type === "ModelPart" && r.extruder > 0) ? r.extruder : 0;
        const vmap = new Map<number, number>();
        const localVerts: number[] = [];
        const localTris: number[][] = [];
        for (let i = r.firstid; i <= r.lastid; i++) {
          const tri: number[] = [];
          for (let k = 0; k < 3; k++) {
            const vi = t[i * 3 + k];
            let nv = vmap.get(vi);
            if (nv === undefined) { nv = localVerts.length; vmap.set(vi, nv); localVerts.push(vi); }
            tri.push(nv);
          }
          localTris.push(tri);
        }
        modelParts.push(`  <object id="${cid}" type="model">\n   <mesh>\n    <vertices>\n`);
        for (const vi of localVerts) {
          modelParts.push(`     <vertex x="${v[vi * 3]}" y="${v[vi * 3 + 1]}" z="${v[vi * 3 + 2]}"/>\n`);
        }
        modelParts.push("    </vertices>\n    <triangles>\n");
        for (let k = 0; k < localTris.length; k++) emitTriangle(localTris[k][0], localTris[k][1], localTris[k][2], r.firstid + k, fillState);
        modelParts.push("    </triangles>\n   </mesh>\n  </object>\n");
      }
      const pid = nextId++;
      modelParts.push(`  <object id="${pid}" type="model">\n   <components>\n`);
      for (const cid of childIds) modelParts.push(`    <component objectid="${cid}"/>\n`);
      modelParts.push("   </components>\n  </object>\n");
      buildIds.push(pid);
      configObjects.push({ id: pid, name: o.name, ranges, childIds });
    }
  });
  modelParts.push(" </resources>\n <build>\n");
  model.objects.forEach((o, oi) => {
    const tf = o.transform ? ` transform="${xmlEscape(o.transform)}"` : "";
    modelParts.push(`  <item objectid="${buildIds[oi]}"${tf} printable="${o.printable === false ? 0 : 1}"/>\n`);
  });
  modelParts.push(" </build>\n</model>\n");

  const mmVersion = maxState > 16 ? 2 : 1;
  const modelXml = bambu
    ? modelParts.join("")
    : modelParts.join("").replace("__MM_VERSION__", ` <metadata name="slic3rpe:MmPaintingVersion">${mmVersion}</metadata>\n`);

  const cfg: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'];
  if (bambu) {
    // bbs model_settings.config: <part id> MUST be a component object id -
    // _generate_volumes_new matches volumes[..].subobject_id against the component ids
    // (range parts with firstid/lastid are only read by the dead legacy path, see above).
    // Flat objects: part id == object id (inline layout as GrainPort / the import
    // default). Subtypes MUST be bbs strings (BBS_VOLUME_TYPES); the extruder key ends up
    // in the volume config via set_deserialize.
    for (const co of configObjects) {
      cfg.push(` <object id="${co.id}">\n`);
      cfg.push(`  <metadata key="name" value="${xmlEscape(co.name)}"/>\n`);
      const firstPart = co.ranges.find((r) => r.type === "ModelPart" && r.extruder > 0);
      if (firstPart) cfg.push(`  <metadata key="extruder" value="${firstPart.extruder}"/>\n`);
      const childIds = co.childIds;
      const partDefs: { pid: number; r: Pick<VolumeRange, "type" | "extruder" | "name"> }[] = childIds
        ? co.ranges.map((r, k) => ({ pid: childIds[k], r }))
        : [{ pid: co.id, r: { type: "ModelPart", extruder: firstPart ? firstPart.extruder : 0, name: null } }];
      for (const { pid, r } of partDefs) {
        cfg.push(`  <part id="${pid}" subtype="${Object.hasOwn(BBS_VOLUME_TYPES, r.type) ? BBS_VOLUME_TYPES[r.type] : "normal_part"}">\n`);
        cfg.push(`   <metadata key="name" value="${xmlEscape(r.type === "ModelPart" ? co.name : (r.name || co.name))}"/>\n`);
        if (r.extruder > 0) cfg.push(`   <metadata key="extruder" value="${r.extruder}"/>\n`);
        cfg.push('   <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n');
        cfg.push('   <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n');
        cfg.push("  </part>\n");
      }
      cfg.push(" </object>\n");
    }
  } else {
    for (const co of configObjects) {
      cfg.push(` <object id="${co.id}" instances_count="1">\n`);
      cfg.push(`  <metadata type="object" key="name" value="${xmlEscape(co.name)}"/>\n`);
      for (const r of co.ranges) {
        cfg.push(`  <volume firstid="${r.firstid}" lastid="${r.lastid}">\n`);
        cfg.push(`   <metadata type="volume" key="name" value="${xmlEscape(r.type === "ModelPart" ? co.name : (r.name || co.name))}"/>\n`);
        cfg.push(`   <metadata type="volume" key="volume_type" value="${r.type}"/>\n`);
        if (r.extruder > 0) cfg.push(`   <metadata type="volume" key="extruder" value="${r.extruder}"/>\n`);
        cfg.push('   <metadata type="volume" key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n');
        cfg.push('   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n');
        cfg.push("  </volume>\n");
      }
      cfg.push(" </object>\n");
    }
  }
  cfg.push("</config>\n");

  const te = new TextEncoder();
  const entries: Build3MFResult["entries"] = [
    {
      name: "[Content_Types].xml",
      data: te.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n</Types>\n'),
    },
    {
      name: "_rels/.rels",
      data: te.encode('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n'),
    },
    { name: "3D/3dmodel.model", data: te.encode(modelXml) },
    { name: bambu ? "Metadata/model_settings.config" : "Metadata/Slic3r_PE_model.config", data: te.encode(cfg.join("")) },
  ];

  // bbs: MINIMAL project_settings.config - only the mapped slot colors plus version
  // context, NO preset/process keys and (until stage 2/3) no mixed_* keys. Reason:
  // without project_settings, Bambu Studio shows the misleading "generated by old Bambu
  // Studio, load geometry data only" dialog on "open as project" (Plater.cpp:
  // load_config && config_loaded.empty()) and the filament colors are missing. How much a
  // minimal config overrides in the user's presets is settled by gate S1b.
  if (bambu) {
    const psJson: { version: string; from: string; filament_colour: string[]; [key: string]: unknown } = {
      version: bbsApp.replace(/^BambuStudio-/, ""),
      from: "project",
      filament_colour: plan.physical.map((p) => p.color),
    };
    if (bsMix && plan.virtuals && plan.virtuals.length) {
      // Bambu: a blend is an additional filament slot of the same list (SpeedBoat ground
      // truth): filament_colour gets the predicted color, per-slot arrays mark the
      // components (1-based, "1,2[,3]") and sublayer ratios (sum 1.0, 4 decimals). Paint
      // states point straight at these slot indices - so the virtual ids must follow the
      // physical ones without gaps (checked below). Gradient arrays are empty/off;
      // enable_mixed_color_sublayer is deliberately NOT set (a process key that stays a
      // preset matter - minimal-config principle).
      const P = plan.physical.length;
      // The German plain Errors below (here and in the Snapmaker branch) are kept verbatim
      // for parity with the classic tool; they get codes and English text later.
      const virt = [...plan.virtuals].sort((a, b) => a.id - b.id);
      const pad = (fill: string, mixVal: (v: (typeof virt)[number]) => string): string[] => [...Array<string>(P).fill(fill), ...virt.map(mixVal)];
      virt.forEach((v, k) => {
        if (v.id !== P + k + 1) throw new Error(`Mix-ID-Lücke: virtueller Extruder ${v.id} erwartet ${P + k + 1}`);
        if (v.components.some((c) => c.extruder < 1 || c.extruder > P)) throw new Error("Mix-Komponente außerhalb der physischen Slots");
      });
      const ratioStr = (comps: { ratio: number }[]): string => {
        const sum = comps.reduce((s, c) => s + c.ratio, 0);
        const parts = comps.map((c) => (c.ratio / sum).toFixed(4));
        const rest = (1 - parts.slice(0, -1).reduce((s, x) => s + parseFloat(x), 0)).toFixed(4);
        return [...parts.slice(0, -1), rest].join(",");
      };
      psJson.filament_colour = [...plan.physical.map((p) => p.color), ...virt.map((v) => v.color)];
      psJson.filament_is_mixed = pad("0", () => "1");
      psJson.filament_mixed_components = pad("", (v) => v.components.map((c) => c.extruder).join(","));
      psJson.filament_mixed_sublayer_ratios = pad("", (v) => ratioStr(v.components));
      psJson.filament_mixed_gradient = pad("0", () => "0");
      psJson.filament_mixed_gradient_curve = pad("", () => "");
      psJson.filament_mixed_gradient_per_part = pad("0", () => "0");
      psJson.filament_mixed_gradient_range = pad("", () => "");
    }
    if (smMix && plan.virtuals && plan.virtuals.length) {
      // mixed_filament_definitions (MixedFilament.cpp serialize_custom_entries, v2.3.5):
      // a row is a,b,enabled,custom,mix_b_percent,pointillism,g<ids>,w<weights>,m<mode>,
      // z0,xa0,xb0,d0,o0,u<stable_id>,cm<ui_mode>. On import, the mix filament id =
      // num_physical + (enabled index in definition order) -> the definitions MUST be
      // sorted by virtual id and all stay enabled / not deleted.
      // 2 components: mode m2 (Simple) + mix_b_percent (ground truth Platypus).
      // 3 components: g = /-separated ids + w = weights, mode m0 (LayerCycle) -
      // resolve() only uses the g/w path for !Simple && ids >= 3 (MixedFilament.cpp).
      const P = plan.physical.length;
      const defs = [...plan.virtuals].sort((a, b) => a.id - b.id).map((v, k) => {
        if (v.id !== P + k + 1) throw new Error(`Mix-ID-Lücke: virtueller Extruder ${v.id} erwartet ${P + k + 1}`);
        const comps = v.components;
        if (comps.some((c) => c.extruder < 1 || c.extruder > P)) throw new Error("Mix-Komponente außerhalb der physischen Slots");
        const a = comps[0].extruder, b = comps[1].extruder;
        let pct = 50, mode = 2, g = "", w = "";
        if (comps.length === 2) {
          pct = Math.round(100 * comps[1].ratio / (comps[0].ratio + comps[1].ratio));
        } else {
          mode = 0;
          g = comps.map((c) => c.extruder).join("/");
          w = comps.map((c) => c.ratio).join("/");
        }
        return `${a},${b},1,1,${pct},0,g${g},w${w},m${mode},z0,xa0,xb0,d0,o0,u${k + 1},cm0`;
      });
      psJson.mixed_filament_definitions = defs.join(";");
    }
    // Preset identity (fix 0.8.1): without *_settings_id the bbs project import finds no
    // system preset (PresetBundle::load_config_file_config -> empty original_name ->
    // external default preset) and falls back to the first list entries - on the U1 the
    // "0.2 nozzle" variant + "Generic ABS". The Snapmaker target gets the U1 stock
    // identity (ground truth platypus), the Bambu target the source 3MF's.
    // Per-slot arrays must cover the FINAL filament_colour length (incl. blends).
    const idFill = (v: string): string[] => Array<string>(psJson.filament_colour.length).fill(v);
    if (plan.mixFormat === "snapmaker") {
      Object.assign(psJson, {
        printer_settings_id: "Snapmaker U1 (0.4 nozzle)",
        printer_model: "Snapmaker U1",
        printer_variant: "0.4",
        nozzle_diameter: ["0.4", "0.4", "0.4", "0.4"],
        print_settings_id: "0.20 Standard @Snapmaker U1 (0.4 nozzle)",
        filament_settings_id: idFill("Snapmaker PLA SnapSpeed @U1"),
        filament_type: idFill("PLA"),
      });
    } else if (model.sourceIdentity) {
      const src = model.sourceIdentity;
      for (const k of ["printer_settings_id", "printer_model", "printer_variant", "nozzle_diameter", "print_settings_id"])
        if (src[k] != null) psJson[k] = src[k];
      if (Array.isArray(src.filament_settings_id) && src.filament_settings_id.length)
        psJson.filament_settings_id = idFill(src.filament_settings_id[0]);
      if (Array.isArray(src.filament_type) && src.filament_type.length)
        psJson.filament_type = idFill(src.filament_type[0]);
    }
    entries.push({ name: "Metadata/project_settings.config", data: te.encode(JSON.stringify(psJson, null, 4)) });
  }

  // full_spectrum.json is Prusa-only (the bbs blend embedding lives in the minimal config
  // above).
  if (!bambu && plan.virtuals && plan.virtuals.length) {
    const fsJson = {
      version: 1,
      physical_extruders: plan.physical.map((p, i) => ({ id: i + 1, color: p.color })),
      virtual_extruders: plan.virtuals.map((v) => ({
        id: v.id,
        kind: "fullspectrum",
        color: v.color,
        components: v.components.map((c) => ({ extruder: c.extruder, ratio: c.ratio })),
      })),
    };
    entries.push({ name: "Metadata/Prusa_Slicer_full_spectrum.json", data: te.encode(JSON.stringify(fsJson, null, 4)) });
  }
  return { entries, mmVersion, maxState };
}

/** Legacy alias (test script, release gate): the Prusa output stays byte-identical. */
export function buildPrusa3MF(model: Model, plan: Omit<Build3MFPlan, "target">): Build3MFResult {
  return build3MF(model, { ...plan, target: "prusa" });
}
