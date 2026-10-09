import { strings } from "@/strings";

const codes: Readonly<Record<string, string>> = strings.errors.codes;

/** Human message for a failure: by error `code` (core, formats, export), else `fallback` (default: the generic import text). Never shows the error's own text. */
export function errorMessage(err: unknown, fallback: string = strings.errors.generic): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && Object.hasOwn(codes, code)) return codes[code];
  return fallback;
}
