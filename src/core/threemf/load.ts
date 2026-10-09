import { normalizeHex } from "../color";
import { coreError } from "../errors";
import { collectStates, type PaintDialect } from "../paint/codec";
import type { Filament, MixComponentRef, Model, ModelObject, PartRange, SourceIdentity, VolumeType } from "../types";
import { unzipAll } from "../zip";
import { applyTransform, composeTransform, parseTransform, type Transform } from "./transform";
import { parsePrusaModelConfig, readPrusaFilaments, type PrusaObjectMeta } from "./prusaProject";
import { parseAttrs, parseModelXML, type ParsedModelXml, type XmlMeshObject } from "./xml";

// Bambu part subtype -> PrusaSlicer volume_type (strings as ModelVolume::type_to_string
// writes them). Look subtypes up with volumeTypeOf(): a plain `VOLUME_TYPES[subtype]` would
// also find inherited keys such as "constructor".
export const VOLUME_TYPES: Readonly<Record<string, VolumeType | undefined>> = {
  normal_part: "ModelPart",
  negative_part: "NegativeVolume",
  modifier_part: "ParameterModifier",
  support_blocker: "SupportBlocker",
  support_enforcer: "SupportEnforcer",
};

/**
 * Volume type for a Bambu part subtype. Unknown or absent subtypes - including names that
 * only exist on Object.prototype ("constructor", "toString", "__proto__") - are ModelParts.
 * (The classic tool let prototype keys through as non-string types; this is a deliberate fix.)
 */
function volumeTypeOf(subtype: string | undefined): VolumeType {
  return (subtype !== undefined && Object.hasOwn(VOLUME_TYPES, subtype) ? VOLUME_TYPES[subtype] : undefined) || "ModelPart";
}

/** Volume type from the volume_type string PrusaSlicer writes; anything else is a ModelPart. */
function prusaVolumeTypeOf(raw: string | null): VolumeType {
  return Object.values(VOLUME_TYPES).find((t) => t === raw) || "ModelPart";
}

/**
 * Per-part data from Bambu's model_settings.config (or, for PrusaSlicer projects, the
 * volumes of Slic3r_PE_model.config).
 */
interface PartMeta {
  extruder: number | null;
  type: VolumeType;
  name: string | null;
  // Range parts (PaintPort's own bbs export, single-mesh layout): a triangle range
  // instead of a component reference - otherwise negative volumes would turn solid on
  // re-import.
  firstid: number | null;
  lastid: number | null;
}
type RangePartMeta = PartMeta & { firstid: number; lastid: number };

/** Per-object data from Bambu's model_settings.config / PrusaSlicer's Slic3r_PE_model.config. */
interface ObjMeta {
  name: string | null;
  extruder: number;
  parts: Map<string, PartMeta>;
}

/** One mesh contributing to an object, before the meshes are merged. */
interface SourcePart {
  obj: XmlMeshObject;
  transform: Transform | null;
  extruder: number;
  type: VolumeType;
  partName: string | null;
  ranges?: RangePartMeta[] | null;
}

/**
 * PrusaSlicer volumes become range parts (a Prusa object is one mesh; the volumes are
 * triangle ranges of it). They are keyed "#<n>", which no component object id can equal.
 */
function prusaObjMeta(p: PrusaObjectMeta): ObjMeta {
  const parts = new Map<string, PartMeta>();
  p.volumes.forEach((v, k) => parts.set("#" + k, {
    extruder: v.extruder, type: prusaVolumeTypeOf(v.volumeType), name: v.name, firstid: v.firstid, lastid: v.lastid,
  }));
  return { name: p.name, extruder: p.extruder, parts };
}

/**
 * Lookup in a map whose keys are always strings, with a possibly missing attribute value
 * as the key (a missing key can never be present, so this equals Map.get(undefined)).
 */
function getKey<V>(m: Map<string, V>, key: string | undefined): V | undefined {
  return key === undefined ? undefined : m.get(key);
}

export async function load3MF(bytes: Uint8Array): Promise<Model> {
  return load3MFFiles(await unzipAll(bytes));
}

/**
 * `load3MF` on an archive that is already unzipped (`unzipAll`), for callers that also need
 * other members of it (PaintPort+ reads its design sidecar this way) and must not inflate a
 * multi-hundred-megabyte model twice. `load3MF` is exactly this after unzipping.
 */
export function load3MFFiles(files: ReadonlyMap<string, Uint8Array>): Model {
  const td = new TextDecoder();
  const text = (name: string): string | null => files.has(name) ? td.decode(files.get(name)) : null;
  let sawMmuSeg = false; // any slic3rpe:mmu_segmentation attribute -> prusa dialect

  const mainXml = text("3D/3dmodel.model");
  if (!mainXml) throw coreError("ERR_NO_MODEL");
  const main = parseModelXML(mainXml);
  // The export always writes millimeters - other units would be silently rescaled.
  if (main.unit !== "millimeter") throw coreError("ERR_UNIT", main.unit);
  if (main.sawMmuSeg) sawMmuSeg = true;

  // Load external object files (Bambu production extension) on demand
  const extCache = new Map<string, ParsedModelXml>();
  const getExternal = (path: string): ParsedModelXml => {
    const norm = path.replace(/^\//, "");
    let ext = extCache.get(norm);
    if (!ext) {
      const x = text(norm);
      if (!x) throw coreError("ERR_MISSING_REF", norm);
      ext = parseModelXML(x);
      if (ext.sawMmuSeg) sawMmuSeg = true;
      extCache.set(norm, ext);
    }
    return ext;
  };

  // Bambu model_settings: object names + default extruder
  const objMeta = new Map<string, ObjMeta>(); // main object id -> metadata
  const ms = text("Metadata/model_settings.config");
  if (ms) {
    const oRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let om;
    while ((om = oRe.exec(ms)) !== null) {
      const idM = /id="(\d+)"/.exec(om[1]);
      if (!idM) continue;
      const meta: ObjMeta = { name: null, extruder: 1, parts: new Map() };
      const kvRe = /<metadata\s+key="([^"]+)"\s+value="([^"]*)"/g;
      let kv;
      const head = om[2].split("<part")[0]; // object level only, parts are handled separately
      while ((kv = kvRe.exec(head)) !== null) {
        if (kv[1] === "name") meta.name = kv[2];
        if (kv[1] === "extruder") meta.extruder = Math.max(1, parseInt(kv[2], 10) || 1);
      }
      // Part level: extruder override, subtype, name (part id == component objectid of
      // the referenced file)
      const pRe = /<part\b([^>]*)>([\s\S]*?)<\/part>/g;
      let pp;
      while ((pp = pRe.exec(om[2])) !== null) {
        const pa = parseAttrs(pp[1]);
        if (!pa.id) continue;
        const pe = /<metadata\s+key="extruder"\s+value="([^"]*)"/.exec(pp[2]);
        const pn = /<metadata\s+key="name"\s+value="([^"]*)"/.exec(pp[2]);
        meta.parts.set(pa.id, {
          extruder: pe ? Math.max(1, parseInt(pe[1], 10) || 1) : null,
          type: volumeTypeOf(pa.subtype),
          name: pn ? pn[1] : null,
          firstid: pa.firstid !== undefined ? parseInt(pa.firstid, 10) : null,
          lastid: pa.lastid !== undefined ? parseInt(pa.lastid, 10) : null,
        });
      }
      objMeta.set(idM[1], meta);
    }
  }

  // Filament colors (Bambu/Orca project_settings) + preset identity of the source.
  // The identity is passed on to the Bambu target so that a project import can restore
  // the printer/filament presets instead of falling back to defaults (fixed in 0.8.1).
  let filamentColors: string[] | null = null;
  let sourceIdentity: SourceIdentity | null = null;
  const ps = text("Metadata/project_settings.config");
  if (ps) {
    try {
      // Dynamic JSON from the file. A non-object result (e.g. `null`) throws on the first
      // property access and lands in the catch below, as in the classic tool.
      const j = JSON.parse(ps) as Record<string, unknown>;
      if (Array.isArray(j.filament_colour)) {
        filamentColors = j.filament_colour.map((c: unknown) => normalizeHex(c));
      }
      const idKeys = ["printer_settings_id", "printer_model", "printer_variant",
        "nozzle_diameter", "print_settings_id", "filament_settings_id", "filament_type"];
      const found = idKeys.filter((k) => j[k] != null);
      if (found.length) {
        const identity: SourceIdentity = {};
        for (const k of found) identity[k] = j[k];
        sourceIdentity = identity;
      }
    } catch (e) { /* broken Bambu JSON -> colors unknown */ }
  }

  // PrusaSlicer project metadata: a deliberate extension beyond the classic tool. Bambu
  // metadata keeps precedence wherever it exists: Prusa colors and ColorMix recipes are
  // read only when project_settings.config gave no filament_colour list, and an object
  // uses the Prusa extruders only when model_settings.config has no entry for it.
  const prusaObjMetas = new Map<string, ObjMeta>();
  const prusaCfg = text("Metadata/Slic3r_PE_model.config");
  if (prusaCfg) for (const [id, p] of parsePrusaModelConfig(prusaCfg)) prusaObjMetas.set(id, prusaObjMeta(p));
  let mixOf = new Map<number, MixComponentRef[]>(); // ColorMix recipe per virtual extruder id
  if (!filamentColors) {
    const prusa = readPrusaFilaments(text("Metadata/Slic3r_PE.config"), text("Metadata/Prusa_Slicer_full_spectrum.json"));
    if (prusa) { filamentColors = prusa.colors; mixOf = prusa.mix; }
  }

  // Resolve build items -> flat object list with component transforms baked in
  const outObjects: ModelObject[] = [];
  for (const item of main.buildItems) {
    const mo = main.objects.get(item.objectid);
    if (!mo) continue;
    const meta: ObjMeta = getKey(objMeta, item.objectid) || getKey(prusaObjMetas, item.objectid) || { name: null, extruder: 1, parts: new Map() };
    const parts: SourcePart[] = [];
    if (mo.hasMesh) {
      // Range parts only in the pure single-mesh case (no components): Bambu files
      // reference parts through component object ids, PaintPort's bbs exports through
      // ranges.
      const rangeParts = mo.components.length ? [] : [...meta.parts.values()]
        .filter((p): p is RangePartMeta => p.firstid !== null && p.lastid !== null && p.lastid >= p.firstid)
        .sort((a, b) => a.firstid - b.firstid);
      parts.push({ obj: mo, transform: null, extruder: meta.extruder, type: "ModelPart", partName: null, ranges: rangeParts.length ? rangeParts : null });
    }
    for (const comp of mo.components) {
      const src = comp.path ? getExternal(comp.path).objects.get(comp.objectid) : main.objects.get(comp.objectid);
      if (!src) continue;
      const ct = parseTransform(comp.transform);
      const pm = getKey(meta.parts, comp.objectid);
      const pExt = (pm && pm.extruder) || meta.extruder;
      if (src.hasMesh) parts.push({ obj: src, transform: ct, extruder: pExt, type: (pm && pm.type) || "ModelPart", partName: pm ? pm.name : null });
      else for (const c2 of src.components) {  // one level deeper (Bambu sometimes nests assemblies)
        const src2 = c2.path ? getExternal(c2.path).objects.get(c2.objectid) : (comp.path ? getExternal(comp.path).objects.get(c2.objectid) : main.objects.get(c2.objectid));
        const pm2 = getKey(meta.parts, c2.objectid) || pm;
        if (src2 && src2.hasMesh) parts.push({ obj: src2, transform: composeTransform(ct, parseTransform(c2.transform)), extruder: (pm2 && pm2.extruder) || pExt, type: (pm2 && pm2.type) || "ModelPart", partName: pm2 ? pm2.name : null });
      }
    }
    if (!parts.length) continue;
    // Merge the parts into one mesh
    let vCount = 0, tCount = 0;
    for (const p of parts) { vCount += p.obj.vertices.length / 3; tCount += p.obj.tris.length / 3; }
    const vertices = new Float64Array(vCount * 3);
    const tris = new Int32Array(tCount * 3);
    const paints: (string | null)[] = new Array(tCount);
    const partRanges: PartRange[] = []; // triangle range per part incl. its effective base extruder
    let vo = 0, to = 0;
    for (const p of parts) {
      const src = p.obj;
      const n = src.vertices.length / 3;
      for (let i = 0; i < n; i++) {
        const [x, y, z] = applyTransform(p.transform, src.vertices[i * 3], src.vertices[i * 3 + 1], src.vertices[i * 3 + 2]);
        vertices[(vo + i) * 3] = x; vertices[(vo + i) * 3 + 1] = y; vertices[(vo + i) * 3 + 2] = z;
      }
      const tn = src.tris.length / 3;
      for (let i = 0; i < tn; i++) {
        tris[(to + i) * 3] = src.tris[i * 3] + vo;
        tris[(to + i) * 3 + 1] = src.tris[i * 3 + 1] + vo;
        tris[(to + i) * 3 + 2] = src.tris[i * 3 + 2] + vo;
        paints[to + i] = src.paints[i];
      }
      if (p.ranges) {
        // Lay the config's triangle ranges onto the flat mesh; gaps become ModelParts
        // with the object extruder, implausible ranges are skipped.
        let cursor = 0;
        for (const r of p.ranges) {
          const f = r.firstid, l = Math.min(tn - 1, r.lastid);
          if (f < cursor || f >= tn || l < f) continue;
          if (f > cursor) partRanges.push({ firstTri: to + cursor, triCount: f - cursor, extruder: p.extruder, type: "ModelPart", name: null });
          partRanges.push({ firstTri: to + f, triCount: l - f + 1, extruder: r.extruder || p.extruder, type: r.type || "ModelPart", name: r.name || null });
          cursor = l + 1;
        }
        if (cursor < tn) partRanges.push({ firstTri: to + cursor, triCount: tn - cursor, extruder: p.extruder, type: "ModelPart", name: null });
      } else {
        partRanges.push({ firstTri: to, triCount: tn, extruder: p.extruder, type: p.type || "ModelPart", name: p.partName || null });
      }
      vo += n; to += tn;
    }
    outObjects.push({
      // The fallback name is German in the classic tool; kept verbatim so output stays identical
      name: meta.name || mo.name || ("Objekt " + item.objectid),
      defaultExtruder: meta.extruder,
      transform: item.transform || null,
      printable: item.printable,
      vertices, tris, paints, parts: partRanges,
      triState: new Int16Array(paints.length),
    });
  }
  if (!outObjects.length) throw coreError("ERR_NO_OBJECTS");

  // Paint dialect of the source (see parsePaintTree): Prusa files carry
  // mmu_segmentation, Bambu/Orca files paint_color - uniform per file.
  const paintDialect: PaintDialect = sawMmuSeg ? "prusa" : "bbs";

  // Painting statistics - ModelPart ranges only; negative/modifier volumes are not print
  // surface and must not distort the base or unpainted counts.
  const stateCount = new Map<number, number>();
  const baseCount = new Map<number, number>(); // base extruder -> unpainted triangles of its parts
  // Shares are in triangle equivalents (leaf share per mesh triangle); stateCount counts
  // leaves and cannot be turned into percentages against totalTris (gave > 100 %).
  const stateShare = new Map<number, number>(), baseShare = new Map<number, number>();
  let unpainted = 0, totalTris = 0, specialVolumes = 0;
  for (const o of outObjects) {
    // o.triState (dominant leaf state per triangle, 0 = unpainted) is filled below for the preview
    for (const pr of o.parts) {
      if (pr.type !== "ModelPart") { specialVolumes++; continue; }
      totalTris += pr.triCount;
      let base = 0;
      for (let i = pr.firstTri; i < pr.firstTri + pr.triCount; i++) {
        const p = o.paints[i];
        if (!p) { unpainted++; base++; baseShare.set(pr.extruder, (baseShare.get(pr.extruder) || 0) + 1); continue; }
        const local = new Map<number, number>();
        collectStates(p, local, paintDialect);
        let dom = 0, domN = 0, leaves = 0;
        for (const c of local.values()) leaves += c;
        for (const [s, c] of local) {
          stateCount.set(s, (stateCount.get(s) || 0) + c);
          if (s === 0) baseShare.set(pr.extruder, (baseShare.get(pr.extruder) || 0) + c / leaves);
          else stateShare.set(s, (stateShare.get(s) || 0) + c / leaves);
          if (c > domN || (c === domN && s > dom)) { domN = c; dom = s; }
        }
        o.triState[i] = dom;
      }
      if (base) baseCount.set(pr.extruder, (baseCount.get(pr.extruder) || 0) + base);
    }
  }
  stateCount.delete(0);
  const maxState = Math.max(0, ...stateCount.keys());
  const usedExtruders = [...stateCount.keys()].sort((a, b) => a - b);
  const filaments: Filament[] = [];
  const nFil = Math.max(filamentColors ? filamentColors.length : 0, maxState,
    ...outObjects.map((o) => o.defaultExtruder),
    ...outObjects.flatMap((o) => o.parts.filter((p) => p.type === "ModelPart").map((p) => p.extruder)));
  const FALLBACK = ["#26A69A", "#EF5350", "#FFCA28", "#5C6BC0", "#8D6E63", "#66BB6A", "#EC407A", "#78909C"];
  for (let i = 1; i <= nFil; i++) {
    const filament: Filament = {
      index: i,
      color: (filamentColors && filamentColors[i - 1]) || FALLBACK[(i - 1) % FALLBACK.length],
      colorKnown: !!(filamentColors && filamentColors[i - 1]),
      paintedTris: stateCount.get(i) || 0,
      baseTris: baseCount.get(i) || 0,
      paintedShare: stateShare.get(i) || 0,
      baseShare: baseShare.get(i) || 0,
      isDefaultOf: outObjects.filter((o) => o.defaultExtruder === i).length,
    };
    const mix = mixOf.get(i);
    if (mix) filament.mix = mix;
    filaments.push(filament);
  }
  return { objects: outObjects, filaments, unpainted, totalTris, usedExtruders, specialVolumes, sourceIdentity, paintDialect };
}
