// Deep comparison of results from two different JS realms (the original core runs in a
// node:vm context), with exact semantics: -0 vs 0, NaN, typed array bytes, Map order,
// and object key order all count.
import { PARITY_SEED } from "./prng";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function norm(v: unknown): Json {
  if (v === null) return null;
  switch (typeof v) {
    case "undefined": return { $: "undefined" };
    case "boolean":
    case "string": return v;
    case "number":
      if (Object.is(v, -0)) return { $: "num", v: "-0" };
      return Number.isFinite(v) ? v : { $: "num", v: String(v) };
    case "bigint": return { $: "bigint", v: String(v) };
    case "function": return { $: "function" };
    case "symbol": return { $: "symbol" };
  }
  const o = v as object;
  const tag = Object.prototype.toString.call(o);
  if (ArrayBuffer.isView(o)) {
    const u8 = new Uint8Array(o.buffer, o.byteOffset, o.byteLength);
    return { $: "typed", tag, len: (o as unknown as { length: number }).length, b64: Buffer.from(u8).toString("base64") };
  }
  if (tag === "[object Map]") return { $: "map", e: [...(o as Map<unknown, unknown>)].map(([k, x]) => [norm(k), norm(x)]) };
  if (tag === "[object Set]") return { $: "set", e: [...(o as Set<unknown>)].map(norm) };
  if (tag === "[object Error]") {
    const e = o as { name?: unknown; message?: unknown; code?: unknown; detail?: unknown };
    return { $: "error", name: norm(e.name), message: norm(e.message), code: norm(e.code), detail: norm(e.detail) };
  }
  if (Array.isArray(o)) {
    const out: Json[] = [];
    for (let i = 0; i < o.length; i++) out.push(norm(o[i]));
    return out;
  }
  const out: { [k: string]: Json } = {};
  for (const k of Object.keys(o)) out[k] = norm((o as Record<string, unknown>)[k]);
  return out;
}

function snippet(b64: string, at: number): string {
  const buf = Buffer.from(b64, "base64");
  return JSON.stringify(buf.subarray(Math.max(0, at - 40), at + 60).toString("utf8"));
}

/** Path and values of the first difference between two normalized values, or null. */
export function firstDiff(a: Json, b: Json, path = "$"): string | null {
  if (a === b) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: array vs non-array`;
    if (a.length !== b.length) return `${path}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a.$ === "typed" && b.$ === "typed") {
    if (a.tag !== b.tag || a.len !== b.len) return `${path}: typed ${a.tag}/${a.len} !== ${b.tag}/${b.len}`;
    if (a.b64 === b.b64) return null;
    const x = Buffer.from(a.b64 as string, "base64"), y = Buffer.from(b.b64 as string, "base64");
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    return `${path}: typed bytes differ at byte ${i}\n  expected: ${snippet(a.b64 as string, i)}\n  actual:   ${snippet(b.b64 as string, i)}`;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.join("\u0000") !== kb.join("\u0000")) return `${path}: keys [${ka}] !== [${kb}]`;
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** Result of calling something that may throw. */
export type Outcome<T> = { ok: T } | { threw: unknown };

export function attempt<T>(fn: () => T): Outcome<T> {
  try { return { ok: fn() }; } catch (e) { return { threw: e }; }
}
export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try { return { ok: await fn() }; } catch (e) { return { threw: e }; }
}

export const stats = { compared: 0, byTest: new Map<string, number>() };

/**
 * Compares `expected` (original core) with `actual` (port); throws with the seed and a
 * description of the first difference. Thrown errors compare by name, message, code, detail.
 */
export function assertParity(test: string, caseInfo: string, expected: unknown, actual: unknown): void {
  stats.compared++;
  stats.byTest.set(test, (stats.byTest.get(test) ?? 0) + 1);
  const d = firstDiff(norm(expected), norm(actual));
  if (d) {
    throw new Error(`PARITY FAILURE in ${test} [${caseInfo}] (PARITY_SEED=${PARITY_SEED})\n${d}`);
  }
}
