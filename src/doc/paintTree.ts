import { emitPaintTree, parsePaintTree, type PaintDialect, type PaintNode, type PaintSplit } from "../core";

/**
 * Dialect of every paint tree the document stores ("preserved" strings). "bbs" has
 * unbounded states, so design states never overflow the escape of the "prusa" dialect.
 * Phase 3 export converts to the target dialect with `remapPaintString`.
 */
export const INTERNAL_DIALECT: PaintDialect = "bbs";

/** True if the TriangleSelector string is a split tree rather than a single leaf. */
export function isSplitTree(paint: string): boolean {
  // The string is read right to left, so the last character is the root node. A root
  // with split sides (low 2 bits) other than 0 is a split; a leaf has them at 0.
  const root = parseInt(paint[paint.length - 1], 16);
  return (root & 3) !== 0;
}

const isSplit = (n: PaintNode): n is PaintSplit => !!(n as PaintSplit).children;

/** Adds every leaf state > 0 of the tree to `into`. */
export function collectLeafStates(paint: string, dialect: PaintDialect, into: Set<number>): void {
  (function walk(n: PaintNode): void {
    if (isSplit(n)) n.children.forEach(walk);
    else if (n.state > 0) into.add(n.state);
  })(parsePaintTree(paint, dialect));
}

/**
 * Rewrites a tree: every leaf state > 0 goes through `mapState`, the result is emitted in
 * the internal dialect. `dominant` is the most frequent leaf state of the result (leaf
 * count, ties to the higher state, 0 counts as a state), the same rule `load3MF` uses
 * for `triState`.
 */
export function remapTree(
  paint: string,
  mapState: (s: number) => number,
  from: PaintDialect = INTERNAL_DIALECT,
): { tree: string; dominant: number } {
  const root = parsePaintTree(paint, from);
  const counts = new Map<number, number>();
  (function walk(n: PaintNode): void {
    if (isSplit(n)) { n.children.forEach(walk); return; }
    if (n.state > 0) n.state = mapState(n.state);
    counts.set(n.state, (counts.get(n.state) ?? 0) + 1);
  })(root);
  let dominant = 0, best = 0;
  for (const [s, c] of counts) if (c > best || (c === best && s > dominant)) { best = c; dominant = s; }
  return { tree: emitPaintTree(root, INTERNAL_DIALECT), dominant };
}

/**
 * Reads a tree without changing it: the highest state it uses and its dominant state (same
 * rule as `remapTree`). Throws a CoreError if the string is not a valid tree.
 */
export function inspectTree(paint: string, from: PaintDialect = INTERNAL_DIALECT): { maxState: number; dominant: number } {
  const counts = new Map<number, number>();
  let maxState = 0;
  (function walk(n: PaintNode): void {
    if (isSplit(n)) { n.children.forEach(walk); return; }
    counts.set(n.state, (counts.get(n.state) ?? 0) + 1);
    if (n.state > maxState) maxState = n.state;
  })(parsePaintTree(paint, from));
  let dominant = 0, best = 0;
  for (const [s, c] of counts) if (c > best || (c === best && s > dominant)) { best = c; dominant = s; }
  return { maxState, dominant };
}
