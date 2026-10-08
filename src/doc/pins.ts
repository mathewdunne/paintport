// Mapping pins (spec 3.2): a design color fixed to one spool or one ColorMix recipe,
// instead of the live Auto choice. Pure data helpers shared by the project, the snapshot
// and the mapping logic; DOM-free.
import type { State } from "./paintField";

/** Spool slots are 1..16 (a printer has at most 16 extruders). */
export const MAX_SPOOLS = 16;
/** Largest ratio share of a blend component a pin may hold (the candidates use 1 and 3). */
const MAX_RATIO = 100;

/** One blend component: a spool slot (1-based) and its share. */
export interface BlendRatio {
  readonly slot: number;
  readonly ratio: number;
}

/**
 * A mapping the user fixed. Refers to spool slots, not to colors, so it keeps pointing at the
 * same slot when the spool's color is edited. A blend's components are sorted by slot (like
 * `topMixes` returns them), so equal recipes compare equal.
 */
export type MappingPin =
  | { readonly kind: "spool"; readonly slot: number }
  | { readonly kind: "blend"; readonly components: readonly BlendRatio[] };

const isSlot = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= MAX_SPOOLS;
const isRatio = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= MAX_RATIO;

/**
 * Why `pin` is not a valid pin, or null if it is one: a spool pin has a slot 1..16, a blend
 * pin has 2..16 components with distinct slots in ascending order and positive integer ratios.
 */
export function pinProblem(pin: unknown): string | null {
  if (typeof pin !== "object" || pin === null || Array.isArray(pin)) return "not an object";
  const p = pin as Record<string, unknown>;
  if (p.kind === "spool") return isSlot(p.slot) ? null : "spool slot";
  if (p.kind !== "blend") return "unknown kind";
  const comps = p.components;
  if (!Array.isArray(comps) || comps.length < 2 || comps.length > MAX_SPOOLS) return "blend components";
  let previous = 0;
  for (const c of comps as unknown[]) {
    if (typeof c !== "object" || c === null) return "blend component";
    const { slot, ratio } = c as Record<string, unknown>;
    if (!isSlot(slot) || !isRatio(ratio)) return "blend component values";
    if (slot <= previous) return "blend components must have ascending distinct slots";
    previous = slot;
  }
  return null;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** The ratios divided by their greatest common divisor, so 2:2 and 1:1 are the same blend. */
export function reduceRatios(components: readonly { readonly ratio: number }[]): number[] {
  const g = components.reduce((acc, c) => gcd(acc, c.ratio), 0) || 1;
  return components.map((c) => c.ratio / g);
}

/** A copy that holds only the pin's own fields, with a blend's ratios reduced. Call after `pinProblem` returned null. */
export function clonePin(pin: MappingPin): MappingPin {
  if (pin.kind === "spool") return { kind: "spool", slot: pin.slot };
  const ratios = reduceRatios(pin.components);
  return { kind: "blend", components: pin.components.map((c, i) => ({ slot: c.slot, ratio: ratios[i] })) };
}

/** True if both pins are the same choice (blend recipes are compared in reduced form). */
export function samePin(a: MappingPin, b: MappingPin): boolean {
  if (a.kind === "spool") return b.kind === "spool" && a.slot === b.slot;
  return b.kind === "blend" && blendKey(a.components) === blendKey(b.components);
}

/** Key of a recipe, ratios reduced: equal recipes share one virtual extruder at export. */
export const blendKey = (components: readonly BlendRatio[]): string => {
  const ratios = reduceRatios(components);
  return components.map((c, i) => `${c.slot}:${ratios[i]}`).join("|");
};

/** The pins without those on states >= `size` (the palette shrank below them). Returns `pins` itself when nothing goes. */
export function prunePins(pins: ReadonlyMap<State, MappingPin>, size: number): ReadonlyMap<State, MappingPin> {
  let stale = false;
  for (const s of pins.keys()) if (s >= size) stale = true;
  if (!stale) return pins;
  return new Map([...pins].filter(([s]) => s < size));
}

/**
 * The pins after the palette lost `deleted`: its pin goes, the pins of higher states move
 * down by one. Returns `pins` itself when nothing changes.
 */
export function dropPinState(pins: ReadonlyMap<State, MappingPin>, deleted: State): ReadonlyMap<State, MappingPin> {
  let touched = false;
  for (const s of pins.keys()) if (s >= deleted) touched = true;
  if (!touched) return pins;
  const next = new Map<State, MappingPin>();
  for (const [s, pin] of pins) {
    if (s < deleted) next.set(s, pin);
    else if (s > deleted) next.set(s - 1, pin);
  }
  return next;
}

/**
 * The inverse of `dropPinState`: a state is inserted at `state` again, so the pins at and
 * above it move up by one, and the pin it had (if any) comes back.
 */
export function restorePinState(pins: ReadonlyMap<State, MappingPin>, state: State, pin: MappingPin | undefined): ReadonlyMap<State, MappingPin> {
  let touched = pin !== undefined;
  for (const s of pins.keys()) if (s >= state) touched = true;
  if (!touched) return pins;
  const next = new Map<State, MappingPin>();
  for (const [s, p] of pins) next.set(s >= state ? s + 1 : s, p);
  if (pin) next.set(state, pin);
  return next;
}
