// View state of the Objects tab: which objects are hidden. Not part of the document, so it is
// neither undoable nor saved. Pure helpers; `useObjectVisibility` holds the state.
export type HiddenObjects = ReadonlySet<number>;

export const NONE_HIDDEN: HiddenObjects = new Set<number>();

export function toggleHidden(hidden: HiddenObjects, index: number): HiddenObjects {
  const next = new Set(hidden);
  if (!next.delete(index)) next.add(index);
  return next;
}

/** True if `index` is the only visible object (of at least two). */
export function isIsolated(hidden: HiddenObjects, index: number, count: number): boolean {
  if (count < 2 || hidden.has(index)) return false;
  for (let i = 0; i < count; i++) if (i !== index && !hidden.has(i)) return false;
  return true;
}

/** Solo: hide everything but `index`; on an object that is already alone, show everything again. */
export function isolate(hidden: HiddenObjects, index: number, count: number): HiddenObjects {
  if (isIsolated(hidden, index, count)) return NONE_HIDDEN;
  const next = new Set<number>();
  for (let i = 0; i < count; i++) if (i !== index) next.add(i);
  return next;
}
