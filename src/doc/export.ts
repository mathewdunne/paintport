// Export (spec 3.2): turns a project and the export settings into the files of a 3MF for
// PrusaSlicer, Bambu Studio or Snapmaker Orca. DOM-free; zipping and downloading are the UI's
// job. This is the classic tool's `doExport` plan on top of `build3MF`:
//
// - slot n is extruder n (no compacting);
// - Prusa lists every extruder of the printer as a physical one, and blends become virtual
//   extruders above the printer's count (PrusaSlicer's import shifts paint states but not a
//   volume's base extruder, so a colliding id would put a whole body on the wrong toolhead);
// - the bbs targets (Bambu Studio, Snapmaker Orca) list the physical filaments up to the
//   highest active slot only, and blends follow directly: trailing empty slots would eat the
//   16-filament cap of Bambu Studio;
// - blends are deduplicated by recipe, one virtual extruder each.
import {
  build3MF, CoreError, normalizeHex,
  type Model, type ModelObject, type PartRange, type PhysicalSlot, type VirtualExtruder, type ZipEntry,
} from "../core";
import { DocError } from "./errors";
import {
  activeSpools, blendKey, colorModeSuffix, EXPORT_TARGETS, resolveMapping,
  type ExportSettings, type ExportTargetId, type MappingSettings,
} from "./mapping";
import type { State } from "./paintField";
import type { Project } from "./project";
import { buildSidecar } from "./sidecar";
import { hasBaseColor } from "./types";

export interface ExportOptions {
  /** "YYYY-MM-DD" for the CreationDate metadata; today when omitted. */
  date?: string;
}

export interface ExportResult {
  /** Files of the 3MF archive (the slicer's files, then the design sidecar); pass them to `zipAll`. */
  entries: ZipEntry[];
  /** `<source name or "PaintPort"><target suffix><color mode suffix>.3mf`. */
  fileName: string;
  target: ExportTargetId;
  /** Extruder count of the target printer. */
  printerCount: number;
  /** MmPaintingVersion this export needs (1, or 2 above 16 extruders); only Prusa files carry it. */
  mmVersion: number;
  /** Number of ColorMix blends, each a virtual extruder. */
  virtualCount: number;
  /** Id of the first virtual extruder (meaningful when `virtualCount` > 0). */
  firstVirtualId: number;
  /** Design state -> output extruder for every used color. */
  stateMap: ReadonlyMap<State, number>;
  physical: PhysicalSlot[];
  virtuals: VirtualExtruder[];
}

/** Highest extruder a PrusaSlicer paint string can address (17 + an 8-bit escape field). */
const PRUSA_MAX_EXTRUDER = 272;

/**
 * Builds the export. Throws a `DocError` (never a partial result) when the export cannot be
 * made: `EXPORT_NO_SPOOL` without an active spool, `EXPORT_UNMAPPED` for a used color that
 * resolved to nothing, `EXPORT_MIX_OFF` for a blend while "Allow ColorMix" is off,
 * `EXPORT_BAMBU_LIMIT` when Bambu Studio's 16 filaments would be exceeded and
 * `EXPORT_TOO_MANY` when a Prusa extruder id would not fit a paint string. Colors that are
 * neither painted nor a part's base color are not mapped and create no virtual extruder.
 */
export function buildExport(project: Project, settings: ExportSettings, opts: ExportOptions = {}): ExportResult {
  const target = EXPORT_TARGETS[settings.target];
  const printerCount = settings.printerCount[target.id];
  const allowMix = settings.allowMix;
  const mappingSettings: MappingSettings = { spools: settings.spools, printerCount, allowMix };
  const active = activeSpools(settings.spools, printerCount);
  if (active.length === 0) throw new DocError("EXPORT_NO_SPOOL", "No spool is switched on");

  const bbs = target.flavor === "bambu";
  const physicalCount = bbs ? Math.max(...active.map((s) => s.slot)) : printerCount;

  // design state -> spool slot, or a virtual extruder for a blend
  const stateMap = new Map<State, number>();
  const virtuals: VirtualExtruder[] = [];
  const virtualByKey = new Map<string, number>();
  for (const [state, resolved] of resolveMapping(project, mappingSettings)) {
    if (resolved.kind === "none") throw new DocError("EXPORT_UNMAPPED", `Color ${state} maps to no spool`);
    if (resolved.kind === "spool") {
      stateMap.set(state, resolved.slot);
      continue;
    }
    if (!allowMix) throw new DocError("EXPORT_MIX_OFF", `Color ${state} needs a ColorMix blend but ColorMix is off`);
    const key = blendKey(resolved.components);
    let id = virtualByKey.get(key);
    if (id === undefined) {
      id = physicalCount + virtuals.length + 1;
      virtuals.push({ id, color: resolved.color, components: resolved.components.map((c) => ({ extruder: c.slot, ratio: c.ratio })) });
      virtualByKey.set(key, id);
    }
    stateMap.set(state, id);
  }
  if (!bbs && physicalCount + virtuals.length > PRUSA_MAX_EXTRUDER) {
    throw new DocError("EXPORT_TOO_MANY", `${physicalCount + virtuals.length} extruders, PrusaSlicer paint strings address at most ${PRUSA_MAX_EXTRUDER}`);
  }

  // Slots below the highest active one are listed too (inactive ones with their colors).
  const physical: PhysicalSlot[] = [];
  for (let slot = 1; slot <= physicalCount; slot++) {
    physical.push({ slot, color: normalizeHex(settings.spools.find((s) => s.slot === slot)?.color) });
  }

  const sourceName = project.source.name || "PaintPort";
  let built;
  try {
    built = build3MF(exportModel(project), {
      target: target.flavor,
      ...(target.mixFormat ? { mixFormat: target.mixFormat } : {}),
      ...(target.bbsApp ? { bbsApp: target.bbsApp } : {}),
      stateMap,
      physical,
      virtuals,
      title: sourceName + (target.flavor === "prusa" ? " (INDX)" : " (PaintPort)"),
      date: opts.date ?? new Date().toISOString().slice(0, 10),
    });
  } catch (e) {
    if (e instanceof CoreError && e.code === "ERR_BBS_MAX16") {
      throw new DocError("EXPORT_BAMBU_LIMIT", `${physical.length} filaments plus ${virtuals.length} blends exceed Bambu Studio's 16`);
    }
    throw e;
  }

  return {
    entries: [...built.entries, ...buildSidecar(project)],
    fileName: `${sourceName}${target.suffix}${colorModeSuffix(settings.spools, printerCount)}.3mf`,
    target: target.id,
    printerCount,
    mmVersion: built.mmVersion,
    virtualCount: virtuals.length,
    firstVirtualId: physicalCount + 1,
    stateMap,
    physical,
    virtuals,
  };
}

/**
 * The project as the core's Model for `build3MF`, still in design states: paint strings from
 * `serialize("bbs")` (the internal dialect) with `paintDialect: "bbs"`, and each printing
 * part's extruder set to its base design state. `build3MF` maps both through the plan's
 * `stateMap`. Only `objects`, `paintDialect` and `sourceIdentity` of the Model are read by
 * the build; the statistics fields are neutral.
 */
function exportModel(project: Project): Model {
  const objects = project.objects.map((object, i): ModelObject => {
    // Parts without triangles are left out: they print nothing, and as ranges they would only
    // split a merged ModelPart range or become empty components. (The sidecar leaves them out too.)
    // An object with no triangles at all keeps its parts, so that build3MF still sees a part list.
    const nonEmpty = object.parts.filter((p) => p.triCount > 0);
    const parts = (nonEmpty.length > 0 ? nonEmpty : object.parts).map((p): PartRange => {
      // Only ModelParts and modifiers carry a mapped extruder (build3MF ignores it for the rest).
      // Every such part has a base color; the project guarantees it.
      const base = hasBaseColor(p.type) ? project.baseColor.get(p.id) : p.extruder;
      if (base === undefined) throw new Error(`Part ${p.id} has no base color`);
      return { firstTri: p.firstTri, triCount: p.triCount, extruder: base, type: p.type, name: p.name };
    });
    return {
      name: object.name,
      defaultExtruder: 1, // build3MF reads it only for an object without parts, which a project object never is (import and restore give every object a part)
      transform: object.transform,
      printable: object.printable,
      vertices: object.mesh.vertices,
      tris: object.mesh.tris,
      paints: project.fields[i].serialize("bbs").paint,
      parts,
      triState: new Int16Array(0), // a preview aid of the importer, unused by the build
    };
  });
  return {
    objects, filaments: [], unpainted: 0, totalTris: 0, usedExtruders: [], specialVolumes: 0,
    sourceIdentity: project.source.sourceIdentity, paintDialect: "bbs",
  };
}
