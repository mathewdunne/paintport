import { coreError } from "../errors";

// Paint-state codec shared by PrusaSlicer's and BambuStudio's TriangleSelector.
//
// The hex string is read from RIGHT to LEFT, one nibble (4 bits, LSB-first in the
// bitstream) per character.
//   Leaf:  code & 3 == 0, state = code >> 2. state == 3 means an extra nibble z follows:
//          see the two dialects below.
//   Split: code & 3 = number of split sides (1..3), code >> 2 = special side; followed by
//          (splitSides + 1) child nodes.
//
// The dialects are identical up to state 16 and differ only for larger states
// (source-verified 2026-08-13):
//   "prusa" (slic3rpe:mmu_segmentation, MmPaintingVersion 2 - PrusaSlicer 2.9.6
//            TriangleSelector): escape nibble 14 introduces an 8-bit field, state = 17 + v.
//   "bbs"   (paint_color - Snapmaker Orca v2.3.5 TriangleSelector, line 1790 ff., BBS lineage incl.
//            Bambu 02.06/H2C): unary extension with F nibbles, state = 3 + 15*numF + z,
//            unbounded (EC = 17, 0FC = 18, DFC = 31).
// An undefined dialect behaves like "prusa" (the classic default).
export type PaintDialect = "prusa" | "bbs";

export interface PaintLeaf {
  state: number;
}
export interface PaintSplit {
  splitSides: number;
  special: number;
  children: PaintNode[];
}
export type PaintNode = PaintLeaf | PaintSplit;

const isSplit = (n: PaintNode): n is PaintSplit => !!(n as PaintSplit).children;

export function parsePaintTree(str: string, dialect?: PaintDialect): PaintNode {
  let i = str.length;
  const next = (): number => {
    if (i <= 0) throw coreError("ERR_PAINT_SHORT", str);
    const ch = str[--i];
    const v = parseInt(ch, 16);
    if (Number.isNaN(v)) throw coreError("ERR_PAINT_CHAR", str);
    return v;
  };
  function node(): PaintNode {
    const code = next();
    const splitSides = code & 3;
    if (splitSides === 0) {
      let state = code >> 2;
      if (state === 3) {
        if (dialect === "bbs") {
          let z = next(), num = 0;
          while (z === 15) { num++; z = next(); }
          state = 3 + 15 * num + z;
        } else {
          const z = next();
          if (z === 14) { const lo = next(); const hi = next(); state = 17 + (lo | (hi << 4)); }
          else state = 3 + z;
        }
      }
      return { state };
    }
    const special = code >> 2;
    const children: PaintNode[] = [];
    for (let c = 0; c <= splitSides; c++) children.push(node());
    return { splitSides, special, children };
  }
  const root = node();
  if (i !== 0) throw coreError("ERR_PAINT_TRAIL", str);
  return root;
}

export function emitPaintTree(root: PaintNode, dialect?: PaintDialect): string {
  const nibbles: number[] = [];
  function emit(n: PaintNode): void {
    if (isSplit(n)) {
      nibbles.push((n.special << 2) | n.splitSides);
      for (const c of n.children) emit(c);
    } else {
      const s = n.state;
      if (s <= 2) nibbles.push(s << 2);
      else if (dialect === "bbs") {
        nibbles.push(0b1100);
        let v = s - 3;
        while (v >= 15) { nibbles.push(15); v -= 15; }
        nibbles.push(v);
      }
      else if (s <= 16) { nibbles.push(0b1100); nibbles.push(s - 3); }
      else { nibbles.push(0b1100); nibbles.push(14); nibbles.push((s - 17) & 0xF); nibbles.push((s - 17) >> 4); }
    }
  }
  emit(root);
  // Nibbles are in stream order; the string is built backwards.
  let out = "";
  for (const n of nibbles) out = n.toString(16).toUpperCase() + out;
  return out;
}

export function remapPaintString(
  str: string,
  mapState: (state: number) => number,
  inDialect?: PaintDialect,
  outDialect?: PaintDialect,
): { str: string; maxState: number } {
  const root = parsePaintTree(str, inDialect);
  let maxState = 0;
  (function walk(n: PaintNode): void {
    if (isSplit(n)) { n.children.forEach(walk); return; }
    if (n.state > 0) n.state = mapState(n.state);
    if (n.state > maxState) maxState = n.state;
  })(root);
  return { str: emitPaintTree(root, outDialect), maxState };
}

/** Adds one count per leaf (not per triangle) to `counter`, keyed by paint state. */
export function collectStates(str: string, counter: Map<number, number>, dialect?: PaintDialect): void {
  const root = parsePaintTree(str, dialect);
  (function walk(n: PaintNode): void {
    if (isSplit(n)) { n.children.forEach(walk); return; }
    counter.set(n.state, (counter.get(n.state) || 0) + 1);
  })(root);
}
