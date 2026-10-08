// Turns an imported core Model into the document's design data: a compact palette, paint
// fields in design states, and base colors (spec section 3, Q7.1).
import { normalizeHex, type Model, type ModelObject } from "../core";
import { IMPORT_DEFAULT_COLOR } from "../formats/singleMesh";
import { generateDistinctColors } from "./colors";
import { collectLeafStates, isSplitTree, remapTree } from "./paintTree";
import type { State } from "./paintField";
import { hasBaseColor, NO_PART, partId, type DesignColor, type PartId, type ProjectObject, type ProjectPart } from "./types";
import { TrianglePaintField } from "./trianglePaintField";

/** Placeholder at palette index 0, which means "base" and is never a real color. */
export const BASE_SLOT: DesignColor = Object.freeze({ color: "#808080", known: true });

/** Base extruder of a part as a file state (>= 1). */
const baseExtruder = (extruder: number): number => Math.max(1, extruder);

/**
 * Every file state that is used, ascending: each leaf of each paint string on a ModelPart
 * triangle (including leaves that exist only inside split trees, which `triState` does not
 * show) and the base extruder of each ModelPart and ParameterModifier (a modifier's extruder
 * is a design color like a part's, so export can map it). Negative volumes and supports
 * are not printed, and paint on anything but ModelParts does not count.
 */
export function collectUsedStates(model: Model): number[] {
  const used = new Set<number>();
  for (const o of model.objects) {
    for (const p of o.parts) {
      if (hasBaseColor(p.type)) used.add(baseExtruder(p.extruder));
      if (p.type !== "ModelPart") continue;
      for (let t = p.firstTri; t < p.firstTri + p.triCount; t++) {
        const paint = o.paints[t];
        if (!paint) continue;
        if (isSplitTree(paint)) collectLeafStates(paint, model.paintDialect, used);
        else if (o.triState[t] > 0) used.add(o.triState[t]);
      }
    }
  }
  return [...used].sort((a, b) => a - b);
}

/**
 * The design palette for the used file states (design state i+1 = file state used[i]).
 * Colors the file defines keep their value; the others get generated colors that differ
 * from every defined color and from each other.
 */
export function buildPalette(model: Model, used: readonly number[]): DesignColor[] {
  const entries = used.map((fileState): DesignColor | null => {
    const f = model.filaments[fileState - 1];
    if (!f) return null;
    // The STL/OBJ importers give their one filament a deliberate neutral gray: not a guess.
    if (!f.colorKnown && f.color !== IMPORT_DEFAULT_COLOR) return null;
    const entry: DesignColor = { color: normalizeHex(f.color), known: true };
    return f.mix ? { ...entry, mix: f.mix.map((c) => ({ ...c })) } : entry;
  });
  const taken = entries.flatMap((e) => (e ? [e.color] : []));
  const generated = generateDistinctColors(entries.length - taken.length, taken);
  let g = 0;
  return [BASE_SLOT, ...entries.map((e) => e ?? { color: generated[g++], known: false })];
}

export interface ImportedDesign {
  palette: DesignColor[];
  objects: ProjectObject[];
  fields: TrianglePaintField[];
  baseColor: Map<PartId, State>;
}

/**
 * Builds the document data from a model.
 *
 * - The palette holds only used colors, compacted to design states 1..k in file-state order.
 * - Paint states, preserved trees (rewritten into design states, internal dialect) and part
 *   base colors are remapped consistently. A preserved triangle's state is the dominant
 *   leaf state of its remapped tree.
 * - Paint on non-ModelPart triangles is dropped: it is not drawn and cannot be edited.
 * - ModelParts and ParameterModifiers get a base color; other volumes get none.
 */
export function importDesign(model: Model): ImportedDesign {
  const used = collectUsedStates(model);
  const palette = buildPalette(model, used);
  const toDesign = new Map<number, State>(used.map((s, i) => [s, i + 1]));
  const design = (fileState: number): State => toDesign.get(fileState)!;

  const baseColor = new Map<PartId, State>();
  const fields: TrianglePaintField[] = [];
  const objects = model.objects.map((source: ModelObject, index): ProjectObject => {
    const triCount = source.tris.length / 3;
    const triPart = new Uint32Array(triCount).fill(NO_PART);
    const paintable = new Uint8Array(triCount);
    const parts = source.parts.map((p, pi): ProjectPart => {
      triPart.fill(pi, p.firstTri, p.firstTri + p.triCount);
      if (p.type === "ModelPart") paintable.fill(1, p.firstTri, p.firstTri + p.triCount);
      if (hasBaseColor(p.type)) baseColor.set(partId(index, pi), design(baseExtruder(p.extruder)));
      return { id: partId(index, pi), firstTri: p.firstTri, triCount: p.triCount, type: p.type, name: p.name, extruder: p.extruder };
    });
    const mesh = { vertices: source.vertices, tris: source.tris, triCount };

    const states = new Uint16Array(triCount);
    const preserved = new Map<number, string>();
    for (let t = 0; t < triCount; t++) {
      const paint = source.paints[t];
      if (!paint || !paintable[t]) continue;
      if (isSplitTree(paint)) {
        const r = remapTree(paint, design, model.paintDialect);
        states[t] = r.dominant;
        preserved.set(t, r.tree);
      } else if (source.triState[t] > 0) states[t] = design(source.triState[t]);
    }
    fields.push(new TrianglePaintField(mesh, paintable, { states, preserved }));

    return { index, name: source.name, printable: source.printable, transform: source.transform, fileExtruder: source.defaultExtruder, triCount, parts, triPart, paintable, mesh };
  });
  return { palette, objects, fields, baseColor };
}
