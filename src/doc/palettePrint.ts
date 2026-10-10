// A printed ColorMix test palette (spec Q13): the dots of a palette print, read from its 3MF,
// and what clicking one picks with the current spools. DOM-free.
//
// One dot per ModelPart: its top-down footprint, the color the file stores for its extruder,
// and what it is made of. Ingredients are spool colors, not slot numbers, so a dot still works
// after the spools were reordered (Q13.3).
import { applyTransform, normalizeHex, parseTransform, type MixSlot, type Model } from "../core";
import { recipeWeights, type ResolvedTarget } from "./mapping";
import { clonePin, samePin, type MappingPin } from "./pins";
import { unescapeXml } from "./xmlText";

/** One spool color of a dot and its weight (integers 1..100; a single spool has weight 1). */
export interface PaletteIngredient {
  color: string;
  weight: number;
}

export interface PaletteDot {
  /** The part's name in the file (e.g. "7 B-R 85-15"), or "". */
  name: string;
  /** Footprint center and radius in bed millimetres (Y up), and the part's top Z (draw order). */
  x: number;
  y: number;
  r: number;
  top: number;
  /** The color the file stores for the part's extruder (PrusaSlicer's own for a blend). */
  color: string;
  /** One entry for a spool, two or more for a blend. */
  ingredients: PaletteIngredient[];
  /** The palette's base plate: drawn, not clickable. */
  backdrop: boolean;
}

export interface PalettePrint {
  name: string;
  dots: PaletteDot[];
}

/** Longest kept palette or dot name. */
export const MAX_PALETTE_NAME = 200;

/** A part whose footprint holds this many other dots' centers is a backdrop (the base plate). */
export const BACKDROP_MIN_DOTS = 3;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** What a part's extruder is made of, or null when the file does not say (unknown color, broken recipe). */
function ingredientsOf(model: Model, extruder: number): PaletteIngredient[] | null {
  const f = model.filaments[extruder - 1];
  if (!f || !f.colorKnown) return null;
  if (!f.mix) return [{ color: normalizeHex(f.color), weight: 1 }];
  const weights = recipeWeights(f.mix.map((m) => m.ratio));
  if (!weights || f.mix.length < 2) return null;
  const out: PaletteIngredient[] = [];
  for (const [i, m] of f.mix.entries()) {
    const physical = model.filaments[m.extruder - 1];
    if (!physical || !physical.colorKnown || physical.mix) return null;
    out.push({ color: normalizeHex(physical.color), weight: weights[i] });
  }
  return out;
}

/**
 * The palette's dots: one per ModelPart with a known extruder color, footprint in bed
 * coordinates (the build item's transform applied). Null when no clickable dot is left, so the
 * file is not a palette print (e.g. one colored with paint instead of parts).
 */
export function paletteFromModel(model: Model, name: string): PalettePrint | null {
  const dots: PaletteDot[] = [];
  for (const object of model.objects) {
    const transform = parseTransform(object.transform);
    for (const part of object.parts) {
      if (part.type !== "ModelPart" || part.triCount <= 0) continue;
      const ingredients = ingredientsOf(model, part.extruder);
      if (!ingredients) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, top = -Infinity;
      for (let t = part.firstTri; t < part.firstTri + part.triCount; t++) {
        for (let k = 0; k < 3; k++) {
          const v = object.tris[t * 3 + k];
          const [x, y, z] = applyTransform(transform, object.vertices[v * 3], object.vertices[v * 3 + 1], object.vertices[v * 3 + 2]);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (z > top) top = z;
        }
      }
      const r = Math.max(maxX - minX, maxY - minY) / 2;
      if (!(r > 0)) continue;
      dots.push({
        name: part.name ? unescapeXml(part.name).slice(0, MAX_PALETTE_NAME) : "",
        x: round2((minX + maxX) / 2), y: round2((minY + maxY) / 2), r: round2(r), top: round2(top),
        color: normalizeHex(model.filaments[part.extruder - 1].color),
        ingredients,
        backdrop: false,
      });
    }
  }
  for (const dot of dots) {
    const inside = dots.filter((o) => o !== dot && o.r < dot.r && Math.hypot(o.x - dot.x, o.y - dot.y) < dot.r).length;
    dot.backdrop = inside >= BACKDROP_MIN_DOTS;
  }
  return dots.some((d) => !d.backdrop) ? { name: name.slice(0, MAX_PALETTE_NAME), dots } : null;
}

/** What clicking a dot does now: pin a spool or blend, or nothing because a spool color is missing or ColorMix is off. */
export type DotChoice =
  | { kind: "pin"; pin: MappingPin }
  | { kind: "missing"; colors: string[] }
  | { kind: "mixOff" };

/**
 * Matches a dot's ingredients to the active spools by color (exact normalized hex; a color on
 * two spools takes the lower slot). Ingredients that land on the same slot are added up.
 */
export function dotChoice(dot: PaletteDot, active: readonly MixSlot[], allowMix: boolean): DotChoice {
  const bySlot = new Map<number, number>();
  const missing: string[] = [];
  for (const ing of dot.ingredients) {
    const spool = active.find((s) => s.color === ing.color);
    if (!spool) {
      if (!missing.includes(ing.color)) missing.push(ing.color);
      continue;
    }
    bySlot.set(spool.slot, (bySlot.get(spool.slot) ?? 0) + ing.weight);
  }
  if (missing.length) return { kind: "missing", colors: missing };
  const slots = [...bySlot.keys()].sort((a, b) => a - b);
  if (slots.length === 1) return { kind: "pin", pin: { kind: "spool", slot: slots[0] } };
  if (!allowMix) return { kind: "mixOff" };
  const weights = recipeWeights(slots.map((s) => bySlot.get(s)!))!;
  return { kind: "pin", pin: clonePin({ kind: "blend", components: slots.map((slot, i) => ({ slot, ratio: weights[i] })) }) };
}

/** True when a dot's choice is what the row resolves to now (the picker rings that dot). */
export function dotIsCurrent(choice: DotChoice, resolved: ResolvedTarget): boolean {
  if (choice.kind !== "pin") return false;
  if (resolved.kind === "spool") return samePin(choice.pin, { kind: "spool", slot: resolved.slot });
  if (resolved.kind === "blend") return samePin(choice.pin, { kind: "blend", components: resolved.components });
  return false;
}
