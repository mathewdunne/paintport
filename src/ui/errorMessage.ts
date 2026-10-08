import { strings } from "@/strings";

const codes: Readonly<Record<string, string>> = strings.errors.codes;

/** Human message for an import failure: by error `code` (core and formats), else generic. */
export function errorMessage(err: unknown): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string" && Object.hasOwn(codes, code)) return codes[code];
  return strings.errors.generic;
}
