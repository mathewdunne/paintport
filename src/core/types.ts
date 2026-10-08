import type { PaintDialect } from "./paint/codec";

export type { PaintDialect } from "./paint/codec";

/** Volume type names as PrusaSlicer's ModelVolume::type_to_string writes them. */
export type VolumeType = "ModelPart" | "NegativeVolume" | "ParameterModifier" | "SupportBlocker" | "SupportEnforcer";

/**
 * A contiguous triangle range of a ModelObject that came from one source part
 * (a Bambu component, a PrusaSlicer volume, or a firstid/lastid range part).
 */
export interface PartRange {
  firstTri: number;
  triCount: number;
  /** Effective base extruder (1-based) of the part. */
  extruder: number;
  type: VolumeType;
  name: string | null;
}

/**
 * One build item of the loaded file, flattened into a single mesh (component transforms
 * are baked into the vertices).
 */
export interface ModelObject {
  name: string;
  /** Object-level extruder (1-based) from the slicer config; 1 if absent. */
  defaultExtruder: number;
  /** The build item's transform attribute, passed through verbatim. */
  transform: string | null;
  printable: boolean;
  /** x,y,z triples. */
  vertices: Float64Array;
  /** v1,v2,v3 triples indexing `vertices`. */
  tris: Int32Array;
  /** One paint string per triangle (null = unpainted), in the model's `paintDialect`. */
  paints: (string | null)[];
  parts: PartRange[];
  /** Dominant leaf state per triangle (0 = unpainted); used for previews. */
  triState: Int16Array;
}

export interface Filament {
  /** 1-based slot/extruder number. */
  index: number;
  /** "#RRGGBB"; a fallback palette color when the file does not know it. */
  color: string;
  colorKnown: boolean;
  /** Painted leaves with this state (a leaf count, comparable to slicer histograms). */
  paintedTris: number;
  /** Unpainted triangles whose part has this base extruder. */
  baseTris: number;
  /** Painted share in triangle equivalents (leaf share per mesh triangle). */
  paintedShare: number;
  baseShare: number;
  /** Number of objects that use this filament as their default extruder. */
  isDefaultOf: number;
}

/**
 * Printer/preset identity keys copied from the source's project_settings.config. The
 * values are whatever the JSON held (strings, string arrays), hence `unknown`.
 */
export type SourceIdentity = Record<string, unknown>;

export interface Model {
  objects: ModelObject[];
  filaments: Filament[];
  /** Unpainted triangles of ModelParts. */
  unpainted: number;
  /** Triangles of ModelParts. */
  totalTris: number;
  /** Sorted paint states that occur in the file (excluding 0). */
  usedExtruders: number[];
  /** Number of negative/modifier/support volumes. */
  specialVolumes: number;
  sourceIdentity: SourceIdentity | null;
  paintDialect: PaintDialect;
}

export interface PhysicalSlot {
  slot: number;
  color: string;
}

export interface MixComponentRef {
  extruder: number;
  ratio: number;
}

/** A ColorMix blend that becomes an additional (virtual) extruder id. */
export interface VirtualExtruder {
  id: number;
  color: string;
  components: MixComponentRef[];
}

export type BuildTarget = "prusa" | "bambu";
export type MixFormat = "snapmaker" | "bambu";

export interface Build3MFPlan {
  /** Output flavor; "prusa" when omitted. "bambu" covers Bambu Studio and Snapmaker Orca. */
  target?: BuildTarget;
  /** Required for the "bambu" flavor when `virtuals` is non-empty. */
  mixFormat?: MixFormat;
  /** Application metadata string of the target slicer, e.g. "BambuStudio-2.3.5". */
  bbsApp?: string;
  /** Source paint state (extruder) -> destination extruder id. Unmapped states pass through. */
  stateMap: Map<number, number>;
  /** All physical extruders of the target printer. */
  physical: PhysicalSlot[];
  virtuals?: VirtualExtruder[];
  title?: string;
  /** "YYYY-MM-DD" for the CreationDate metadata. */
  date?: string;
}

export interface Build3MFResult {
  /** Files of the 3MF archive; pass them to `zipAll`. */
  entries: { name: string; data: Uint8Array }[];
  /** MmPaintingVersion this export needs (1, or 2 when a state exceeds 16). Returned for both flavors, but only written to the file for the Prusa flavor. */
  mmVersion: number;
  /** Highest paint state in the output. */
  maxState: number;
}
