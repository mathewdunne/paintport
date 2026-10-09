import { normalizeHex, type Filament, type Model, type PaintDialect, type SourceIdentity } from "../core";
import { generateDistinctColors } from "./colors";
import { importDesign, type DesignImportOptions } from "./designImport";
import { resolveTriangleState } from "./display";
import { DocError } from "./errors";
import type { ProjectEvent, ProjectListener } from "./events";
import { featureFill, shellFill, smartFill } from "./fill";
import { hashGeometry, newProjectId } from "./geometryHash";
import { MeshTopology } from "./meshTopology";
import type { BrushOpts, EditRecord, PaintField, PaintFieldView, State, Vec3 } from "./paintField";
import { clonePin, dropPinState, pinProblem, prunePins, restorePinState, samePin, type MappingPin } from "./pins";
import type { ColorUsage, DesignColor, PartId, ProjectObject } from "./types";

// Document types live in types.ts; re-exported so existing imports from "./project" work.
export { NO_PART, partId } from "./types";
export type { ColorUsage, DesignColor, PartId, ProjectObject, ProjectPart } from "./types";
export type { MappingPin } from "./pins";

/** Where the project came from, kept for the phase 3 export. */
export interface SourceInfo {
  paintDialect: PaintDialect;
  sourceIdentity: SourceIdentity | null;
  filaments: Filament[];
  /** Base name of the imported file (no extension), for the export file name. Absent for sessions saved before it existed. */
  name?: string;
}

/** Default number of undo steps kept (spec section 3). */
export const DEFAULT_UNDO_LIMIT = 200;
/** Default memory budget of the undo history: the oldest steps are dropped beyond it. */
export const DEFAULT_UNDO_BYTE_LIMIT = 256 * 1024 * 1024;

export interface ProjectOptions {
  /** Most undo steps kept. */
  undoLimit?: number;
  /** Most memory the undo history may hold (approximate). The newest step is always kept. */
  undoByteLimit?: number;
}

/** Everything a Project is made of; `createProject` and `fromSnapshot` build it. */
export interface ProjectInit extends ProjectOptions {
  /** Index = design state; [0] is the unused base slot. */
  palette: readonly DesignColor[];
  objects: ProjectObject[];
  /** One per object. */
  fields: PaintField[];
  /** Base design state per part that has one (ModelParts and ParameterModifiers). */
  baseColor: ReadonlyMap<PartId, State>;
  source: SourceInfo;
  /** Mapping pins by design state (spec 3.2). The caller has validated them. None when omitted. */
  mapping?: ReadonlyMap<State, MappingPin>;
  /** Identity of the project, shared by its autosave halves. Generated when omitted. */
  projectId?: string;
}

/** One undoable step. Field records are opaque and interpreted by their field. */
type Edit =
  | { kind: "paint"; object: number; rec: EditRecord }
  | { kind: "renumber"; object: number; rec: EditRecord }
  /** Palette and/or base-color replacement: immutable [before, after] values, so no copying. */
  | { kind: "meta"; palette?: [readonly DesignColor[], readonly DesignColor[]]; base?: [ReadonlyMap<PartId, State>, ReadonlyMap<PartId, State>]; drops?: PinDrop[] }
  | { kind: "compound"; edits: Edit[] };

/**
 * A color deletion's effect on the pins, which are not part of the history otherwise: redo drops
 * the deleted state's pin and moves the higher pins down; undo moves them up again and brings
 * the dropped pin back. Pins set or changed in between are kept (they move with their states).
 * Known limit: the recorded pin is the one at deletion time. If the user re-pins that state
 * between an undo and the next redo, the following undo restores the recorded pin, not the newer one.
 */
interface PinDrop {
  state: State;
  pin: MappingPin | undefined;
}

interface Step {
  edit: Edit;
  bytes: number;
}

/** Events collected while an edit is applied, flushed once the project is consistent. */
interface Effects {
  paint: { object: number; tris: Uint32Array }[];
  base: Map<number, number[]>;
  palette: boolean;
  changed: Set<number>;
  renumbered: boolean;
  mapping: boolean;
}
const noEffects = (): Effects => ({ paint: [], base: new Map(), palette: false, changed: new Set(), renumbered: false, mapping: false });

const sameEntry = (a: DesignColor, b: DesignColor): boolean =>
  a === b || (a.color === b.color && a.known === b.known
    && (a.mix === b.mix || (!!a.mix && !!b.mix && a.mix.length === b.mix.length && a.mix.every((m, i) => m.extruder === b.mix![i].extruder && m.ratio === b.mix![i].ratio))));
const samePalette = (a: readonly DesignColor[], b: readonly DesignColor[]): boolean =>
  a === b || (a.length === b.length && a.every((c, i) => sameEntry(c, b[i])));
const sameBase = (a: ReadonlyMap<PartId, State>, b: ReadonlyMap<PartId, State>): boolean => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
};
/** States whose color value differs between two palettes (added and removed ones included). */
const changedStates = (before: readonly DesignColor[], after: readonly DesignColor[]): number[] => {
  const out: number[] = [];
  for (let s = 1; s < Math.max(before.length, after.length); s++) if (before[s]?.color !== after[s]?.color) out.push(s);
  return out;
};

/**
 * The document: design palette, objects, paint fields, base colors, undo history and
 * change notifications. DOM-free.
 *
 * Read the data through the public properties; change it only through the methods below,
 * which validate, record one undo step per call (or per stroke/batch) and notify
 * subscribers with exact change events. `palette` and `baseColor` are replaced, never
 * mutated, so `project.palette` can be used as a change token.
 *
 * Every edit is applied and recorded before its events are sent, and a listener that
 * throws is logged and skipped, so a faulty subscriber cannot leave the document with an
 * edit that cannot be undone.
 */
export class Project {
  readonly objects: readonly ProjectObject[];
  /** Read-only views of the paint fields, one per object. Edit through the project: that records undo and notifies. */
  readonly fields: readonly PaintFieldView[];
  readonly source: SourceInfo;
  /** Identity of this project; the autosave's geometry and paint halves carry it. */
  readonly id: string;
  readonly undoLimit: number;
  readonly undoByteLimit: number;

  private readonly editable: readonly PaintField[];
  private _palette: readonly DesignColor[];
  private _base: ReadonlyMap<PartId, State>;
  private _pins: ReadonlyMap<State, MappingPin>;
  private _version = 0;
  private hash: string | null = null;
  private readonly listeners = new Set<ProjectListener>();
  private readonly undoStack: Step[] = [];
  private readonly redoStack: Step[] = [];
  private _undoBytes = 0;
  private group: Edit[] | null = null;
  private groupDepth = 0;
  /** The palette when the open stroke began (or was last renumbered): what "unchanged" means inside a stroke. */
  private strokePalette: readonly DesignColor[] | null = null;
  private readonly topologies: (MeshTopology | null)[];

  /** Use `createProject` or `fromSnapshot`. Takes ownership of `init`. */
  constructor(init: ProjectInit) {
    this.objects = init.objects;
    this.editable = init.fields;
    this.fields = init.fields;
    this.source = init.source;
    this.id = init.projectId ?? newProjectId();
    this._palette = init.palette;
    this._base = init.baseColor;
    this._pins = init.mapping ?? new Map();
    this.undoLimit = init.undoLimit ?? DEFAULT_UNDO_LIMIT;
    this.undoByteLimit = init.undoByteLimit ?? DEFAULT_UNDO_BYTE_LIMIT;
    this.topologies = init.objects.map(() => null);
  }

  // --- reading -------------------------------------------------------------------

  /** Index = design state; [0] is the unused base slot. A new array whenever a color changes. */
  get palette(): readonly DesignColor[] {
    return this._palette;
  }

  /** Base design state per part that has one (`partId`). A new map whenever a base color changes. */
  get baseColor(): ReadonlyMap<PartId, State> {
    return this._base;
  }

  /**
   * Mapping pins by design state: the design colors fixed to a spool slot or a blend recipe;
   * every other used color is Auto. A new map whenever a pin changes. Not part of the undo
   * history (see `setPin`).
   */
  get mapping(): ReadonlyMap<State, MappingPin> {
    return this._pins;
  }

  /** Counts every change (edits, undo, redo, history changes). A cheap change token, e.g. for useSyncExternalStore. */
  get version(): number {
    return this._version;
  }

  /** Fingerprint of the immutable geometry (computed once). The autosave uses it to pair its two halves. */
  geometryHash(): string {
    return (this.hash ??= hashGeometry(this.objects.map((o) => ({ vertices: o.mesh.vertices, tris: o.mesh.tris, parts: o.parts }))));
  }

  /** Calls `listener` for every change from now on. Returns the unsubscribe function. */
  subscribe(listener: ProjectListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Eyedropper: the design state shown at triangle `tri` (its paint, else its part's base; 0 off the print surface). */
  stateShownAt(objectIndex: number, tri: number): State {
    return resolveTriangleState(this, objectIndex, tri);
  }

  /** Triangle counts per color, indexed by state: painted with it, and unpainted on a part whose base color it is. */
  colorUsage(): ColorUsage[] {
    const usage: ColorUsage[] = this._palette.map(() => ({ painted: 0, base: 0 }));
    this.objects.forEach((object, i) => {
      const painted = this.fields[i].displayStates();
      const baseOfPart = object.parts.map((p) => this._base.get(p.id) ?? 0);
      for (let t = 0; t < painted.length; t++) {
        if (object.paintable[t] !== 1) continue;
        const s = painted[t];
        if (s > 0) usage[s].painted++;
        else usage[baseOfPart[object.triPart[t]]].base++;
      }
    });
    return usage;
  }

  /** Parts whose base color is `state`. */
  basePartsOf(state: State): PartId[] {
    const out: PartId[] = [];
    for (const [id, s] of this._base) if (s === state) out.push(id);
    return out;
  }

  /** True if some part (or modifier) uses the color as its base. Such a color cannot be deleted into "base" (see `deleteColor`). */
  isBaseColor(state: State): boolean {
    for (const s of this._base.values()) if (s === state) return true;
    return false;
  }

  /** A color that differs from every palette color, for the "add color" button. Deterministic. */
  suggestColor(): string {
    return generateDistinctColors(1, this._palette.slice(1).map((c) => c.color))[0];
  }

  // --- paint edits ---------------------------------------------------------------

  /**
   * Brush: paints the triangles of `objectIndex` that the sphere touches (see
   * `PaintField.paintSphere` for the contract: `center` and `radius` in object space,
   * `opts.candidates` already narrowed and visibility-filtered by the caller, and with
   * `opts.candidatesExact` already tested against the sphere). State 0 erases.
   * Returns the number of triangles that changed; nothing is recorded or emitted if it is 0.
   */
  paintSphere(objectIndex: number, center: Vec3, radius: number, state: State, opts?: BrushOpts): number {
    this.checkObject(objectIndex);
    this.checkState(state, true);
    return this.commitPaint(objectIndex, this.editable[objectIndex].paintSphere(center, radius, state, opts));
  }

  /** Paints the given triangles (fills) with `state` (0 erases). Returns the number that changed. */
  paintTriangles(objectIndex: number, tris: ArrayLike<number>, state: State): number {
    this.checkObject(objectIndex);
    this.checkState(state, true);
    return this.commitPaint(objectIndex, this.editable[objectIndex].paintTriangles(tris, state));
  }

  // --- strokes -------------------------------------------------------------------

  /** True while a stroke is open (`undo` and `redo` are refused meanwhile). */
  get strokeOpen(): boolean {
    return this.groupDepth > 0;
  }

  /**
   * Starts a stroke: until the matching `endStroke`, every edit joins one undo step (a
   * brush drag, a color-picker drag, a multi-part operation). Edits still apply and notify
   * immediately. Calls nest; the outermost `endStroke` closes the step. Within a stroke,
   * consecutive paint edits of one object merge (a triangle's first "before" and last
   * "after" win), consecutive palette/base edits merge too, and a stroke whose palette or
   * base edits end where they began leaves no step. A `history` event announces that a
   * stroke opened or closed.
   *
   * Strokes that can be interrupted (pointercancel, blur, a lost pointer capture) must be
   * closed with `endAllStrokes`, which is safe to call at any time.
   */
  beginStroke(): void {
    if (this.groupDepth++ === 0) {
      this.group = [];
      this.strokePalette = this._palette;
      this.emit({ kind: "history" });
    }
  }

  /** Ends the stroke started by `beginStroke` and, for the outermost one, commits it as one undo step (nothing if it changed nothing). */
  endStroke(): void {
    if (this.groupDepth === 0) return;
    if (--this.groupDepth > 0) return;
    this.closeGroup();
  }

  /** Closes every open stroke at once, however deeply nested. A no-op when none is open. */
  endAllStrokes(): void {
    if (this.groupDepth === 0) return;
    this.groupDepth = 0;
    this.closeGroup();
  }

  /** Runs `fn` as one undo step (`beginStroke`/`endStroke`, also when `fn` throws). */
  batch<T>(fn: () => T): T {
    this.beginStroke();
    try {
      return fn();
    } finally {
      this.endStroke();
    }
  }

  // --- palette -------------------------------------------------------------------

  /** Appends a color the user chose and returns its state. */
  addColor(hex: string): State {
    const state = this._palette.length;
    if (state > 0xffff) throw new DocError("PALETTE_FULL", "The palette is full");
    this.commitMeta({ kind: "meta", palette: [this._palette, [...this._palette, { color: normalizeHex(hex), known: true }]] });
    return state;
  }

  /**
   * Edits a color: everything painted with it (and every part with it as base) shows the
   * new value. Marks the color as known. A ColorMix recipe hint is kept only while the
   * value equals the one the color had before the edit (or before the open stroke began),
   * since the recipe describes that value. Returns false if nothing changed.
   */
  setColor(state: State, hex: string): boolean {
    this.checkState(state, false);
    const cur = this._palette[state];
    const color = normalizeHex(hex);
    const start = this.strokePalette?.[state] ?? cur;
    const next: DesignColor = color === start.color && start.mix ? { color, known: true, mix: start.mix } : { color, known: true };
    if (sameEntry(cur, next)) return false;
    const palette = this._palette.slice();
    palette[state] = next;
    this.commitMeta({ kind: "meta", palette: [this._palette, palette] });
    return true;
  }

  /**
   * Deletes a color by merging its surface into `mergeInto`: another color, or 0 for
   * "unpainted" (painted triangles fall back to their part's base). The remaining colors
   * keep their order and are renumbered to stay contiguous (every field, preserved tree
   * and base color follows). One undo step; if anything fails, nothing is changed.
   *
   * A color that is some part's (or modifier's) base color cannot merge into base, since
   * that part would have no color: this throws `BASE_IN_USE`. Check `isBaseColor(state)`
   * first and ask for a concrete target. With a concrete target, those bases move to it.
   *
   * The color's mapping pin is dropped and the pins of the higher colors follow their
   * states; undo brings the dropped pin back and moves the others up again, redo drops it
   * again (a `mapping` event announces each of these when a pin was involved).
   */
  deleteColor(state: State, mergeInto: State): void {
    const size = this._palette.length;
    this.checkState(state, false);
    this.checkState(mergeInto, true);
    if (mergeInto === state) throw new DocError("SAME_COLOR", "Cannot merge a color into itself");
    if (mergeInto === 0 && this.isBaseColor(state)) throw new DocError("BASE_IN_USE", `State ${state} is the base color of a part`);

    const forward = new Uint16Array(size), inverse = new Uint16Array(size - 1);
    for (let s = 0; s < size; s++) forward[s] = s < state ? s : s === state ? 0 : s - 1;
    for (let s = 0; s < size - 1; s++) inverse[s] = s < state ? s : s + 1;

    const edits: Edit[] = [];
    try {
      this.editable.forEach((field, object) => {
        const merge = field.remap((s) => (s === state ? mergeInto : s));
        if (merge.size > 0) edits.push({ kind: "paint", object, rec: merge });
        const renumber = field.renumber(forward, inverse);
        if (renumber.size > 0) edits.push({ kind: "renumber", object, rec: renumber });
      });
    } catch (e) {
      for (const done of edits.reverse()) this.editable[(done as { object: number }).object].undoEdit((done as { rec: EditRecord }).rec);
      throw e;
    }
    const base = new Map<PartId, State>();
    for (const [id, s] of this._base) base.set(id, forward[s === state ? mergeInto : s]);
    const palette = this._palette.filter((_, s) => s !== state);
    const meta: Edit = { kind: "meta", palette: [this._palette, palette], base: [this._base, base], drops: [{ state, pin: this._pins.get(state) }] };
    const fx = noEffects();
    this.apply(meta, "redo", fx);
    edits.push(meta);
    if (this.group) this.strokePalette = this._palette; // indices changed: "unchanged" is now relative to this palette
    this.commit(edits.length === 1 ? edits[0] : { kind: "compound", edits }, [{ kind: "palette", renumbered: true, changed: [] }, ...(fx.mapping ? [{ kind: "mapping" } as const] : [])]);
  }

  // --- base colors ---------------------------------------------------------------

  /** Sets the base color of one part that has one (a ModelPart or ParameterModifier). Returns false if unchanged. */
  setBaseColor(objectIndex: number, partIndex: number, state: State): boolean {
    this.checkState(state, false);
    const id = this.objects[objectIndex]?.parts[partIndex]?.id;
    if (id === undefined || !this._base.has(id)) throw new DocError("NOT_BASE_PART", `Part ${objectIndex}:${partIndex} has no base color`);
    if (this._base.get(id) === state) return false;
    this.commitMeta({ kind: "meta", base: [this._base, new Map(this._base).set(id, state)] });
    return true;
  }

  /** Recolors the base of every ModelPart of an object in one undo step (modifiers keep theirs). Returns false if nothing changed. */
  setObjectBaseColor(objectIndex: number, state: State): boolean {
    this.checkObject(objectIndex);
    this.checkState(state, false);
    const next = new Map(this._base);
    let changed = false;
    for (const part of this.objects[objectIndex].parts) {
      if (part.type === "ModelPart" && next.get(part.id) !== state) { next.set(part.id, state); changed = true; }
    }
    if (!changed) return false;
    this.commitMeta({ kind: "meta", base: [this._base, next] });
    return true;
  }

  // --- mapping pins --------------------------------------------------------------

  /**
   * Pins design color `state` to a spool slot or a blend recipe (see `MappingPin`), or
   * returns it to Auto with `null`. Throws `STATE_RANGE` for a state outside the palette and
   * `PIN_INVALID` for a malformed pin. Returns false (and emits nothing) if nothing changed.
   *
   * Pins are mapping settings, not paint: this is not an undo step and emits only a
   * `mapping` event. Deleting a color drops its pin, and undoing that delete brings the pin
   * back (see `deleteColor`).
   */
  setPin(state: State, pin: MappingPin | null): boolean {
    this.checkState(state, false);
    if (pin !== null) {
      const problem = pinProblem(pin);
      if (problem) throw new DocError("PIN_INVALID", `Invalid mapping pin: ${problem}`);
    }
    const current = this._pins.get(state);
    if (pin === null ? current === undefined : current !== undefined && samePin(current, pin)) return false;
    const next = new Map(this._pins);
    if (pin === null) next.delete(state); else next.set(state, clonePin(pin));
    this._pins = next;
    this.emit({ kind: "mapping" });
    return true;
  }

  // --- fills ---------------------------------------------------------------------

  /** Edge adjacency and shells of an object, built on first use and cached (geometry never changes in v1). */
  topology(objectIndex: number): MeshTopology {
    this.checkObject(objectIndex);
    const object = this.objects[objectIndex];
    return (this.topologies[objectIndex] ??= new MeshTopology(object.mesh, object.paintable, object.parts));
  }

  /** Triangles a shell fill from `seedTri` would paint: its whole connected shell. Does not paint. */
  shellFillRegion(objectIndex: number, seedTri: number): Uint32Array {
    return shellFill(this.topology(objectIndex), seedTri);
  }

  /**
   * Triangles a smart fill from `seedTri` would paint: flood across edges with a dihedral
   * angle <= `angleDeg` that show the same state as the seed. With a feature size `scale`
   * (object units, > 0) the bend is measured over that size instead (see `featureFill`).
   * Does not paint.
   */
  smartFillRegion(objectIndex: number, seedTri: number, angleDeg: number, scale = 0): Uint32Array {
    const object = this.objects[objectIndex];
    const display = {
      painted: this.fields[objectIndex].displayStates(),
      triPart: object.triPart,
      baseOfPart: object.parts.map((p) => this._base.get(p.id) ?? 0),
    };
    const topology = this.topology(objectIndex);
    return scale > 0 ? featureFill(topology, seedTri, angleDeg, scale, display) : smartFill(topology, seedTri, angleDeg, display);
  }

  // --- history -------------------------------------------------------------------

  get canUndo(): boolean {
    return this.groupDepth === 0 && this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.groupDepth === 0 && this.redoStack.length > 0;
  }

  /** Number of steps `undo` can revert (at most `undoLimit`, and within `undoByteLimit`). */
  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  /** Approximate memory held by the undo steps. */
  get undoBytes(): number {
    return this._undoBytes;
  }

  /** Reverts the last step. Returns false if there is none, or a stroke is still open. */
  undo(): boolean {
    if (!this.canUndo) return false;
    const step = this.undoStack.pop()!;
    this._undoBytes -= step.bytes;
    const fx = noEffects();
    this.apply(step.edit, "undo", fx);
    this.redoStack.push(step);
    this.emitAll([...this.eventsOf(fx), { kind: "history" }]);
    return true;
  }

  /** Re-applies the last undone step. Returns false if there is none, or a stroke is still open. */
  redo(): boolean {
    if (!this.canRedo) return false;
    const step = this.redoStack.pop()!;
    const fx = noEffects();
    this.apply(step.edit, "redo", fx);
    this.undoStack.push(step);
    this._undoBytes += step.bytes;
    this.emitAll([...this.eventsOf(fx), { kind: "history" }]);
    return true;
  }

  /** Forgets all undo and redo steps. */
  clearHistory(): void {
    if (this.undoStack.length === 0 && this.redoStack.length === 0) return;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._undoBytes = 0;
    this.emit({ kind: "history" });
  }

  // --- internals -----------------------------------------------------------------

  private checkObject(objectIndex: number): void {
    if (!this.objects[objectIndex]) throw new RangeError(`No object ${objectIndex}`);
  }

  private checkState(state: State, allowBase: boolean): void {
    if (!Number.isInteger(state) || state < (allowBase ? 0 : 1) || state >= this._palette.length) {
      throw new DocError("STATE_RANGE", `State ${state} is not in the palette`);
    }
  }

  private commitPaint(object: number, rec: EditRecord): number {
    if (rec.size === 0) return 0;
    this.commit({ kind: "paint", object, rec }, [{ kind: "paint", object, tris: this.editable[object].editedTriangles(rec) }]);
    return rec.size;
  }

  private commitMeta(edit: Edit): void {
    const fx = noEffects();
    this.apply(edit, "redo", fx);
    this.commit(edit, this.eventsOf(fx));
  }

  /** Records an edit that is already applied, then tells the subscribers (the history entry always comes first). */
  private commit(edit: Edit, events: ProjectEvent[]): void {
    const pushed = !this.group;
    if (this.group) this.group.push(...(edit.kind === "compound" ? edit.edits : [edit]));
    else this.pushHistory(edit);
    this.emitAll(pushed ? [...events, { kind: "history" }] : events);
  }

  private pushHistory(edit: Edit): void {
    const bytes = this.editBytes(edit);
    this.undoStack.push({ edit, bytes });
    this._undoBytes += bytes;
    // Drop the oldest steps beyond the count or memory budget, but always keep the newest.
    while (this.undoStack.length > 1 && (this.undoStack.length > this.undoLimit || this._undoBytes > this.undoByteLimit)) {
      this._undoBytes -= this.undoStack.shift()!.bytes;
    }
    this.redoStack.length = 0;
  }

  private editBytes(edit: Edit): number {
    switch (edit.kind) {
      case "paint":
      case "renumber":
        return edit.rec.bytes;
      case "meta":
        return 160 + (edit.palette ? (edit.palette[0].length + edit.palette[1].length) * 16 : 0) + (edit.base ? (edit.base[0].size + edit.base[1].size) * 56 : 0) + (edit.drops ? edit.drops.length * 96 : 0);
      case "compound":
        return edit.edits.reduce((n, e) => n + this.editBytes(e), 64);
    }
  }

  private closeGroup(): void {
    const edits = this.group!;
    this.group = null;
    this.strokePalette = null;
    const edit = this.finalize(edits);
    if (edit) this.pushHistory(edit);
    this.emit({ kind: "history" });
  }

  /**
   * Merges adjacent paint edits of one object and adjacent palette/base edits of a closed
   * stroke into as few records as possible, and drops palette/base changes that ended where
   * they began.
   */
  private finalize(edits: Edit[]): Edit | null {
    const out: Edit[] = [];
    let i = 0;
    while (i < edits.length) {
      const e = edits[i];
      let j = i + 1;
      if (e.kind === "paint") {
        while (j < edits.length && edits[j].kind === "paint" && (edits[j] as typeof e).object === e.object) j++;
        out.push(j - i === 1 ? e : { kind: "paint", object: e.object, rec: this.editable[e.object].mergeEdits(edits.slice(i, j).map((x) => (x as typeof e).rec)) });
      } else if (e.kind === "meta") {
        let merged = e;
        while (j < edits.length && edits[j].kind === "meta") {
          const next = edits[j] as typeof e;
          merged = {
            kind: "meta",
            palette: merged.palette && next.palette ? [merged.palette[0], next.palette[1]] : merged.palette ?? next.palette,
            base: merged.base && next.base ? [merged.base[0], next.base[1]] : merged.base ?? next.base,
            drops: merged.drops || next.drops ? [...(merged.drops ?? []), ...(next.drops ?? [])] : undefined,
          };
          j++;
        }
        // A change that ended where it began is dropped. The original array is put back only when it is still the
        // current one (later edits of the stroke may have replaced it, and they must win).
        if (merged.palette && samePalette(merged.palette[0], merged.palette[1])) {
          if (this._palette === merged.palette[1]) this._palette = merged.palette[0];
          // The palette ended where it began, so the step has no palette change to pair the pin drops with.
          // Pins dropped meanwhile stay dropped (pins are not undoable).
          merged = { ...merged, palette: undefined, drops: undefined };
        }
        if (merged.base && sameBase(merged.base[0], merged.base[1])) {
          if (this._base === merged.base[1]) this._base = merged.base[0];
          merged = { ...merged, base: undefined };
        }
        if (merged.palette || merged.base) out.push(merged);
      } else out.push(e);
      i = j;
    }
    return out.length === 0 ? null : out.length === 1 ? out[0] : { kind: "compound", edits: out };
  }

  /** Applies (redo) or reverts (undo) an edit to the project's data and collects the events. */
  private apply(edit: Edit, dir: "undo" | "redo", fx: Effects): void {
    const undo = dir === "undo";
    switch (edit.kind) {
      case "paint":
      case "renumber": {
        const field = this.editable[edit.object];
        if (undo) field.undoEdit(edit.rec); else field.redoEdit(edit.rec);
        if (edit.kind === "renumber") fx.renumbered = true;
        else fx.paint.push({ object: edit.object, tris: field.editedTriangles(edit.rec) });
        return;
      }
      case "meta": {
        if (edit.palette) {
          const before = this._palette;
          this._palette = edit.palette[undo ? 0 : 1];
          fx.palette = true;
          for (const s of changedStates(before, this._palette)) fx.changed.add(s);
        }
        if (edit.drops) {
          const before = this._pins;
          if (undo) for (const d of [...edit.drops].reverse()) this._pins = restorePinState(this._pins, d.state, d.pin);
          else for (const d of edit.drops) this._pins = dropPinState(this._pins, d.state);
          if (this._pins !== before) fx.mapping = true;
        }
        if (edit.palette) {
          // A palette that shrank (undo of addColor, redo of a delete) leaves no state for pins above it. They are
          // not brought back when the palette grows again: the color that returns is a fresh one.
          const before = this._pins;
          this._pins = prunePins(this._pins, this._palette.length);
          if (this._pins !== before) fx.mapping = true;
        }
        if (edit.base) {
          const before = this._base;
          this._base = edit.base[undo ? 0 : 1];
          this.objects.forEach((object, oi) => {
            const parts: number[] = [];
            object.parts.forEach((p, pi) => { if (before.get(p.id) !== this._base.get(p.id)) parts.push(pi); });
            if (parts.length) fx.base.set(oi, [...(fx.base.get(oi) ?? []), ...parts]);
          });
        }
        return;
      }
      case "compound": {
        const list = undo ? [...edit.edits].reverse() : edit.edits;
        for (const e of list) this.apply(e, dir, fx);
      }
    }
  }

  private eventsOf(fx: Effects): ProjectEvent[] {
    const events: ProjectEvent[] = [];
    if (fx.renumbered) events.push({ kind: "palette", renumbered: true, changed: [] });
    else {
      if (fx.palette) events.push({ kind: "palette", renumbered: false, changed: [...fx.changed].sort((a, b) => a - b) });
      for (const p of fx.paint) events.push({ kind: "paint", object: p.object, tris: p.tris });
      for (const [object, parts] of fx.base) events.push({ kind: "base", object, parts: [...new Set(parts)] });
    }
    if (fx.mapping) events.push({ kind: "mapping" });
    return events;
  }

  private emitAll(events: ProjectEvent[]): void {
    for (const e of events) this.emit(e);
  }

  /** Sends one event to every subscriber. A subscriber that throws is reported and skipped. */
  private emit(event: ProjectEvent): void {
    this._version++;
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (e) {
        console.error("Project listener failed", e);
      }
    }
  }
}

export interface CreateProjectOptions extends ProjectOptions, DesignImportOptions {
  /** Base name of the imported file, without extension (kept in `source.name`). */
  name?: string;
}

/**
 * Builds the document from an imported model. The design palette holds only colors that
 * are used (see `importDesign`); colors the file did not define are generated and marked
 * `known: false`.
 */
export function createProject(model: Model, options: CreateProjectOptions = {}): Project {
  const { name, plainNames, ...projectOptions } = options;
  const { palette, objects, fields, baseColor } = importDesign(model, { plainNames });
  return new Project({
    ...projectOptions,
    palette,
    objects,
    fields,
    baseColor,
    source: { paintDialect: model.paintDialect, sourceIdentity: model.sourceIdentity, filaments: model.filaments, ...(name ? { name } : {}) },
  });
}
