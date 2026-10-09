/** Codes of the errors the document layer throws; the UI maps them to messages. */
export type DocErrorCode =
  /** A state is outside the palette (or 0 where a real color is required). */
  | "STATE_RANGE"
  /** Merging a color into itself. */
  | "SAME_COLOR"
  /** `deleteColor(state, 0)` while the color is some part's base color: pick a concrete target. */
  | "BASE_IN_USE"
  /** A base color was set on a part that has none (not a ModelPart), or the part does not exist. */
  | "NOT_BASE_PART"
  /** `setPin` was given something that is not a valid mapping pin (see `pinProblem`). */
  | "PIN_INVALID"
  /** The palette cannot hold more colors (states are 16 bit). */
  | "PALETTE_FULL"
  /** The snapshot was written by another (or no known) format version. */
  | "SNAPSHOT_VERSION"
  /** The snapshot is not a project snapshot, or its contents are inconsistent. */
  | "SNAPSHOT_INVALID"
  /** Export: no spool is switched on (within the printer's extruder count), so nothing can be mapped. */
  | "EXPORT_NO_SPOOL"
  /** Export: a used color resolved to no spool or blend. */
  | "EXPORT_UNMAPPED"
  /** Export: a used color resolved to a ColorMix blend while "Allow ColorMix" is off. */
  | "EXPORT_MIX_OFF"
  /** Export: physical filaments plus blends exceed Bambu Studio's 16 filaments. */
  | "EXPORT_BAMBU_LIMIT"
  /** Export: a PrusaSlicer paint string cannot address the highest extruder id (limit 272). */
  | "EXPORT_TOO_MANY";

/** Typed error of the document layer. Branch on `code`; `message` is for logs, not for users. */
export class DocError extends Error {
  constructor(readonly code: DocErrorCode, message: string) {
    super(message);
    this.name = "DocError";
  }
}
