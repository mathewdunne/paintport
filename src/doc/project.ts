import { normalizeHex, type Filament, type MixComponentRef, type Model, type ModelObject, type PaintDialect, type SourceIdentity, type VolumeType } from "../core";
import type { PaintField, State } from "./paintField";
import { TrianglePaintField } from "./trianglePaintField";

/** Identifies a part: "<object index>:<part index>". */
export type PartId = string;
export const partId = (objectIndex: number, partIndex: number): PartId => `${objectIndex}:${partIndex}`;

/** A color you paint with. */
export interface DesignColor {
  /** "#RRGGBB", upper case. */
  color: string;
  /**
   * Hint for the phase 3 mapping: the ColorMix recipe the imported file stored for this
   * color (a PrusaSlicer virtual extruder). `extruder` numbers the file's physical
   * extruders, not palette entries, so it stays valid when the palette is reordered.
   */
  mix?: MixComponentRef[];
}

export interface ProjectPart {
  id: PartId;
  firstTri: number;
  triCount: number;
  type: VolumeType;
  name: string | null;
  /** Base extruder the file assigned to the part (1-based). */
  extruder: number;
}

export interface ProjectObject {
  index: number;
  /** Untrusted file content: render as text only. */
  name: string;
  printable: boolean;
  /** Build-item transform attribute, verbatim from the file. */
  transform: string | null;
  triCount: number;
  parts: ProjectPart[];
  /** Part index per triangle (NO_PART for triangles outside every part range). */
  triPart: Uint32Array;
  /** The imported geometry and paint strings. */
  source: ModelObject;
}

export const NO_PART = 0xffffffff;

export interface SourceInfo {
  paintDialect: PaintDialect;
  sourceIdentity: SourceIdentity | null;
  filaments: Filament[];
}

export interface Project {
  /** index = paint state; [0] is unused (0 = base). */
  palette: DesignColor[];
  objects: ProjectObject[];
  /** One per object. */
  fields: PaintField[];
  /** Base design color per part. */
  baseColor: Map<PartId, State>;
  source: SourceInfo;
  // TODO(phase 3): mapping: Map<State, MappingTarget> (design color -> spool | blend).
}

// Same fallback colors the core uses for filaments the file does not define.
const FALLBACK = ["#26A69A", "#EF5350", "#FFCA28", "#5C6BC0", "#8D6E63", "#66BB6A", "#EC407A", "#78909C"];
const UNUSED_SLOT_COLOR = "#808080";

/**
 * Builds the document from an imported model. The design palette is the file's filament
 * colors (state n = filament n), extended with fallback colors so that every state that
 * is painted and every part's base extruder has a color.
 */
export function createProject(model: Model): Project {
  let size = Math.max(model.filaments.length, ...model.usedExtruders);
  for (const o of model.objects) {
    size = Math.max(size, o.defaultExtruder);
    for (const p of o.parts) size = Math.max(size, p.extruder);
  }
  const palette: DesignColor[] = [{ color: UNUSED_SLOT_COLOR }];
  for (let i = 1; i <= size; i++) {
    const known = model.filaments[i - 1];
    const entry: DesignColor = { color: known ? normalizeHex(known.color) : FALLBACK[(i - 1) % FALLBACK.length] };
    if (known?.mix) entry.mix = known.mix.map((c) => ({ ...c }));
    palette.push(entry);
  }

  const baseColor = new Map<PartId, State>();
  const objects = model.objects.map((source, index): ProjectObject => {
    const triCount = source.tris.length / 3;
    const triPart = new Uint32Array(triCount).fill(NO_PART);
    const parts = source.parts.map((p, pi): ProjectPart => {
      triPart.fill(pi, p.firstTri, p.firstTri + p.triCount);
      baseColor.set(partId(index, pi), p.extruder);
      return { id: partId(index, pi), firstTri: p.firstTri, triCount: p.triCount, type: p.type, name: p.name, extruder: p.extruder };
    });
    return { index, name: source.name, printable: source.printable, transform: source.transform, triCount, parts, triPart, source };
  });

  return {
    palette,
    objects,
    fields: model.objects.map((o) => new TrianglePaintField(o)),
    baseColor,
    source: { paintDialect: model.paintDialect, sourceIdentity: model.sourceIdentity, filaments: model.filaments },
  };
}
