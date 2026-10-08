import type { MixComponentRef, VolumeType } from "../core";
import type { EditableMesh } from "./paintField";

/** Identifies a part: "<object index>:<part index>". */
export type PartId = string;
export const partId = (objectIndex: number, partIndex: number): PartId => `${objectIndex}:${partIndex}`;

/** `ProjectObject.triPart` value for triangles outside every part range. */
export const NO_PART = 0xffffffff;

/**
 * A color you paint with. Entries are immutable values: the project replaces an entry
 * (and the palette array) when a color changes, so references stay valid as snapshots.
 */
export interface DesignColor {
  /** "#RRGGBB", upper case. */
  readonly color: string;
  /**
   * True if the imported file (or the user) defined this color. False means it is a
   * generated stand-in, to be shown with an "unknown color" marker until it is edited.
   */
  readonly known: boolean;
  /**
   * Hint for the phase 3 mapping: the ColorMix recipe the imported file stored for this
   * color (a PrusaSlicer virtual extruder). `extruder` numbers the file's physical
   * extruders, not palette entries, so it stays valid when the palette is reordered.
   * Dropped when the user changes the color, because the recipe no longer matches it.
   */
  readonly mix?: readonly MixComponentRef[];
}

export interface ProjectPart {
  id: PartId;
  firstTri: number;
  triCount: number;
  type: VolumeType;
  name: string | null;
  /** The base extruder the FILE assigned (1-based file numbering, not a design state). */
  extruder: number;
}

export interface ProjectObject {
  index: number;
  /** Untrusted file content: render as text only. */
  name: string;
  printable: boolean;
  /** Build-item transform attribute, verbatim from the file. */
  transform: string | null;
  /** Object-level extruder the file assigned (raw file numbering, not a design state). */
  fileExtruder: number;
  triCount: number;
  parts: ProjectPart[];
  /** Part index per triangle (NO_PART for triangles outside every part range). */
  triPart: Uint32Array;
  /** 1 for paintable triangles (ModelPart volumes), 0 for negative volumes, modifiers, supports. */
  paintable: Uint8Array;
  /** The imported geometry, in object space (before `transform`). Never mutated. */
  mesh: EditableMesh;
}

/** Triangles per color: painted with it, and unpainted on a part whose base color it is. */
export interface ColorUsage {
  painted: number;
  base: number;
}

/**
 * Volume types whose file extruder is a design color the document tracks (`baseColor`):
 * model parts, and modifiers (which can override the extruder of what they cover). Only
 * ModelParts are print surface that can be painted.
 */
export const hasBaseColor = (type: VolumeType): boolean => type === "ModelPart" || type === "ParameterModifier";
