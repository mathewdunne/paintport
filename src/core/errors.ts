// Core errors carry an English message plus a stable `code`; the UI translates the code
// into a localized string.
export const CORE_ERRORS = {
  ERR_NO_EOCD: "No ZIP central directory (EOCD) found",
  ERR_ZIP_CDIR: "ZIP central directory corrupted",
  ERR_PAINT_SHORT: "Paint string too short",
  ERR_PAINT_CHAR: "Invalid character in paint string",
  ERR_PAINT_TRAIL: "Paint string not fully consumed",
  ERR_NO_MODEL: "3D/3dmodel.model missing - not a valid 3MF file",
  ERR_MISSING_REF: "Referenced model file missing from archive",
  ERR_NO_OBJECTS: "No printable objects found in the file",
  ERR_UNIT: "Unsupported model unit (only millimeter is supported)",
  // Raised by build3MF. The classic tool built these two with an ad-hoc `new Error`
  // plus a `code` property and a German message; the message text is kept verbatim.
  ERR_BBS_NO_MIX: "ColorMix braucht für bbs-Ziele ein mixFormat (snapmaker | bambu)",
  ERR_BBS_MAX16: "Bambu Studio unterstützt maximal 16 Filamente (physisch + Mischfarben)",
} as const;

export type CoreErrorCode = keyof typeof CORE_ERRORS;

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly detail: string | undefined;
  constructor(code: CoreErrorCode, detail?: string) {
    super(CORE_ERRORS[code] + (detail !== undefined ? ": " + detail : ""));
    this.code = code;
    this.detail = detail;
  }
}

export function coreError(code: CoreErrorCode, detail?: string): CoreError {
  return new CoreError(code, detail);
}
