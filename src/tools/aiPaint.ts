// AI Paint (spec Q10): the pending region a Segment Anything model picks from clicks. Like guided
// fill, clicks place marks and the region stays highlighted until Enter paints it. Each camera
// pose the user clicks in is a "view": its image is encoded once, and every click there decodes a
// mask from the marks that view can see. A view's mask splits its visible triangles into inside
// and outside; the splits of all views add up (Q10.5) and seed guided fill's race, which carries
// the region onto surface no view has seen (Q10.4). Only the first click's color can join (Q10.9).
// The model answers asynchronously; an answer for marks that changed in the meantime is dropped.
import { resolveDisplayStates, resolveTriangleState } from "../doc/display";
import type { Region } from "../doc/paintField";
import { EMPTY_REGION, regionSize } from "../doc/pieces";
import type { Vec3 } from "../doc/paintField";
import type { Project } from "../doc/project";
import { liftMask, triangleFrames, type MaskSplit, type TriangleFrames } from "../sam/lift";
import { maskField, rankCandidates } from "../sam/masks";
import { combineViews, promptsFor, type AiMark } from "../sam/selection";
import type { SamEmbedding, SamMask, SamPoint, Segmenter } from "../sam/types";
import type { PaintView, PickHit, SamCapture } from "./types";

/** What the viewport bar shows. */
export interface AiState {
  /** noModel: a click came before the model was loaded; analyzing: a view is being encoded or decoded. */
  status: "noModel" | "analyzing" | "ready" | "failed";
  positive: number;
  negative: number;
  tris: number;
  /** Tab switches to another of SAM's candidate masks (the last view has a single click). */
  canCycle: boolean;
}

export type AiView = Pick<PaintView, "captureSam" | "setMarks" | "setRegionHighlight">;

export interface AiHost {
  readonly project: Project;
  readonly view: AiView;
  /** The smart fill angle and feature size (object units) guided fill would use at `point`. */
  fillSettings(object: number, point: Vec3): { angle: number; scale: number };
  /** The state Enter paints with, or null. */
  paintState(): number | null;
  onState(state: AiState | null): void;
  onError(error: unknown): void;
}

interface ViewEntry {
  id: number;
  capture: SamCapture;
  embedding: Promise<SamEmbedding>;
  /** Bumped by every decode and when the view is dropped; an answer whose number is stale is ignored. */
  seq: number;
  /** Ranked best first. */
  masks: SamMask[] | null;
  /** The prompt points the masks were decoded from. */
  points: SamPoint[];
  candidate: number;
  split: MaskSplit | null;
  /** Only the latest request controls the UI; older work may still be releasing resources. */
  pending: boolean;
  failed: boolean;
  running: number;
  dropped: boolean;
}

const NO_MODEL: AiState = { status: "noModel", positive: 0, negative: 0, tris: 0, canCycle: false };

export class AiPaintSession {
  private segmenter: Segmenter | null = null;
  private object = -1;
  private marks: AiMark[] = [];
  private views: ViewEntry[] = [];
  private region: Region = EMPTY_REGION;
  private nextView = 1;
  /** Per object, built on first use (geometry never changes in v1). */
  private readonly frames = new Map<number, TriangleFrames>();

  constructor(private readonly host: AiHost) {}

  /** True while there are marks: Enter, Escape, Backspace and Tab then belong to AI Paint. */
  get active(): boolean {
    return this.marks.length > 0;
  }

  setSegmenter(segmenter: Segmenter | null): void {
    if (segmenter === this.segmenter) return;
    this.clear();
    this.segmenter = segmenter;
  }

  /** Adds a mark where the surface was clicked: on the part (positive) or not. A mark on another object starts over. */
  mark(hit: PickHit, positive: boolean): void {
    const segmenter = this.segmenter;
    if (!segmenter) {
      this.host.onState(NO_MODEL);
      return;
    }
    const capture = this.host.view.captureSam(segmenter.inputSize);
    if (!capture) return;
    if (hit.object !== this.object) {
      this.clear();
      this.object = hit.object;
    }
    let entry = this.views.find((v) => v.capture.key === capture.key);
    if (!entry) {
      let embedding: Promise<SamEmbedding>;
      try {
        embedding = segmenter.encode(capture.render());
      } catch (error) {
        this.host.onError(error);
        return;
      }
      embedding.catch(() => {}); // reported by the decode that waits for it
      entry = { id: this.nextView++, capture, embedding, seq: 0, masks: null, points: [], candidate: 0, split: null, pending: false, failed: false, running: 0, dropped: false };
      this.views.push(entry);
    }
    const id = entry.id;
    this.marks = this.marks.filter((m) => !(m.tri === hit.tri && m.view === id)); // a second click on a triangle replaces its mark
    this.marks.push({ tri: hit.tri, point: hit.point, normal: hit.normal, positive, view: id, state: resolveTriangleState(this.host.project, hit.object, hit.tri, hit.bary) });
    this.showMarks();
    void this.decode(entry);
  }

  /** Removes the last mark (Backspace) and decodes its view again; a view left without marks of its own is dropped. */
  undoMark(): void {
    const removed = this.marks.pop();
    if (!removed) return;
    if (this.marks.length === 0) {
      this.clear();
      return;
    }
    this.showMarks();
    const entry = this.views.find((v) => v.id === removed.view);
    if (!entry) return;
    if (this.marks.some((m) => m.view === entry.id)) void this.decode(entry);
    else {
      this.dropView(entry);
      this.updateRegion();
    }
  }

  /** Steps to SAM's next candidate mask when the last view has a single click (Tab). */
  cycle(): void {
    const entry = this.lastView();
    if (!entry?.masks || entry.points.length !== 1 || entry.masks.length < 2 || this.pending || this.failed) return;
    entry.candidate = (entry.candidate + 1) % entry.masks.length;
    this.liftView(entry);
    this.updateRegion();
  }

  /** Paints the region with the active color as one undo step and clears the marks (Enter). Does nothing while a view is analyzed. */
  commit(): void {
    if (!this.active || this.pending || this.failed) return;
    const object = this.object, region = this.region, state = this.host.paintState();
    this.clear();
    if (state !== null && regionSize(region) > 0) this.host.project.paintRegion(object, region, state);
  }

  /** Drops the marks, their views and the region (Escape, a tool change, the Print view). */
  clear(): void {
    const shown = this.marks.length > 0 || this.views.length > 0;
    for (const v of [...this.views]) this.dropView(v);
    this.marks = [];
    this.region = EMPTY_REGION;
    if (shown && this.object >= 0) {
      this.host.view.setRegionHighlight(this.object, null);
      this.host.view.setMarks([]);
    }
    this.object = -1;
    this.host.onState(null);
  }

  /** Recomputes the region after the document or the fill settings changed; the masks stay. */
  refresh(): void {
    if (this.active) this.updateRegion();
  }

  dispose(): void {
    this.clear();
    this.segmenter = null;
  }

  private async decode(entry: ViewEntry): Promise<void> {
    const segmenter = this.segmenter;
    if (!segmenter) return;
    const seq = ++entry.seq;
    const current = () => seq === entry.seq && this.views.includes(entry);
    const points = promptsFor(this.marks, entry.id, entry.capture.camera, entry.capture.visibility);
    entry.pending = false;
    entry.failed = false;
    if (!points.some((p) => p.positive)) {
      entry.masks = null;
      entry.split = null;
      entry.points = [];
      this.updateRegion();
      return;
    }
    entry.pending = true;
    entry.running++;
    this.report();
    try {
      const embedding = await entry.embedding;
      if (!current()) return;
      const masks = await segmenter.decode(embedding, points);
      if (!current()) return;
      entry.masks = rankCandidates(masks);
      entry.points = points;
      entry.candidate = 0;
      this.liftView(entry);
    } catch (error) {
      if (current()) {
        entry.failed = true;
        entry.masks = null;
        entry.split = null;
        entry.points = [];
        this.host.onError(error);
      }
    } finally {
      entry.running--;
      if (entry.dropped && entry.running === 0) this.releaseEmbedding(entry);
      if (current()) {
        entry.pending = false;
        this.updateRegion();
      }
    }
  }

  private liftView(entry: ViewEntry): void {
    const mask = entry.masks?.[entry.candidate];
    if (!mask) {
      entry.split = null;
      return;
    }
    const object = this.host.project.objects[this.object];
    let frames = this.frames.get(this.object);
    if (!frames) {
      frames = triangleFrames(object.mesh, object.transform);
      this.frames.set(this.object, frames);
    }
    const { camera, visibility } = entry.capture;
    const field = maskField(mask, camera, entry.points.filter((p) => p.positive));
    entry.split = liftMask(frames, object.paintable, camera, visibility, field);
  }

  private updateRegion(): void {
    const first = this.marks.find((m) => m.positive);
    const splits = this.views.flatMap((v) => (v.split ? [v.split] : []));
    let region: Region = EMPTY_REGION;
    if (first && first.state > 0 && splits.length > 0) {
      const project = this.host.project;
      const seeds = combineViews(splits, project.objects[this.object].triCount, resolveDisplayStates(project, this.object), first.state);
      if (seeds.inside.length > 0) {
        const { angle, scale } = this.host.fillSettings(this.object, first.point);
        region = project.guidedFillRegion(this.object, seeds.inside, seeds.outside, angle, scale);
      }
    }
    this.region = region;
    this.host.view.setRegionHighlight(this.object, regionSize(region) > 0 ? region : null);
    this.report();
  }

  private report(): void {
    if (!this.active) {
      this.host.onState(null);
      return;
    }
    const positive = this.marks.filter((m) => m.positive).length;
    const last = this.lastView();
    this.host.onState({
      status: this.pending ? "analyzing" : this.failed ? "failed" : "ready",
      positive,
      negative: this.marks.length - positive,
      tris: regionSize(this.region),
      canCycle: !this.pending && !this.failed && !!last?.masks && last.points.length === 1 && last.masks.length > 1,
    });
  }

  private lastView(): ViewEntry | undefined {
    const last = this.marks.at(-1);
    return last && this.views.find((v) => v.id === last.view);
  }

  private dropView(entry: ViewEntry): void {
    entry.seq++;
    entry.dropped = true;
    this.views = this.views.filter((v) => v !== entry);
    if (entry.running === 0) this.releaseEmbedding(entry);
  }

  private releaseEmbedding(entry: ViewEntry): void {
    entry.embedding.then((e) => e.dispose(), () => {});
  }

  private get pending(): boolean {
    return this.views.some((v) => v.pending);
  }

  private get failed(): boolean {
    return this.views.some((v) => v.failed);
  }

  private showMarks(): void {
    this.host.view.setMarks(this.marks.map((m) => ({ point: m.point, inside: m.positive })));
  }
}
