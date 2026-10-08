// Import-format errors follow the CoreError pattern: an English message plus a stable
// `code` that the UI translates through strings.ts.
export const FORMAT_ERRORS = {
  ERR_UNSUPPORTED_FORMAT: "Unsupported file format (expected 3MF, STL or OBJ)",
  ERR_STL_INVALID: "Not a valid STL file",
  ERR_STL_EMPTY: "The STL file contains no triangles",
  ERR_OBJ_INVALID: "Not a valid OBJ file",
  ERR_OBJ_EMPTY: "The OBJ file contains no faces",
} as const;

export type FormatErrorCode = keyof typeof FORMAT_ERRORS;

export class FormatError extends Error {
  readonly code: FormatErrorCode;
  readonly detail: string | undefined;
  constructor(code: FormatErrorCode, detail?: string) {
    super(FORMAT_ERRORS[code] + (detail !== undefined ? ": " + detail : ""));
    this.code = code;
    this.detail = detail;
  }
}

export function formatError(code: FormatErrorCode, detail?: string): FormatError {
  return new FormatError(code, detail);
}
