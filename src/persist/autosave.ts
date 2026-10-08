// Debounced autosave of the open project through a ProjectSaver.
//
// Rules: the debounced save never starts while a stroke is open (a picker drag or brush stroke
// is still changing the document; the stroke's closing event re-arms the save); a burst of edits
// becomes one save after a quiet period; at most one save runs at a time; and the snapshot is
// taken when the browser is idle. `flush` is the best-effort save before the page goes away: it
// does not wait for a stroke, because the document is consistent at every moment (edits apply
// immediately) and the tab may never get another chance.
import type { ProjectEvent } from "../doc/events";
import type { Project } from "../doc/project";
import type { ProjectSaver } from "../doc/snapshot";

/** Quiet time after the last edit before a save starts. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;
/** The browser may postpone the idle callback this long when it is busy. */
const IDLE_TIMEOUT_MS = 2000;

/** Timers, replaceable in tests. */
export interface AutosaveEnv {
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Runs `callback` when the browser is idle (or soon, where there is no idle callback). */
  idle(callback: () => void): unknown;
  cancelIdle(handle: unknown): void;
}

const browserEnv = (): AutosaveEnv => ({
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  idle: (cb) => (typeof requestIdleCallback === "function" ? { idle: requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS }) } : { timer: setTimeout(cb, 0) }),
  cancelIdle: (h) => {
    const handle = h as { idle?: number; timer?: ReturnType<typeof setTimeout> };
    if (handle.idle !== undefined) cancelIdleCallback(handle.idle);
    if (handle.timer !== undefined) clearTimeout(handle.timer);
  },
});

export interface AutosaveOptions {
  /** True for a project the store does not hold yet (a fresh import): it is saved without waiting for an edit. */
  startDirty?: boolean;
  debounceMs?: number;
  /** A save failed (called every time; the owner decides what to tell the user). The next edit tries again. */
  onError?(error: unknown): void;
  /** A save reached the store. */
  onSaved?(): void;
}

/** The autosavers that are running, so code outside React (an error boundary) can flush them. */
const running = new Set<Autosaver>();

/** Starts a save for every running autosaver that has unsaved changes. Safe at any time. */
export function flushAutosavers(): void {
  for (const a of [...running]) a.flush();
}

/** Saves one project whenever it changes. Create one per project and `dispose` it when the project goes away. */
export class Autosaver {
  private dirty: boolean;
  private timer: unknown = null;
  private idleHandle: unknown = null;
  private inFlight = 0;
  private failed = false;
  private disposed = false;
  private readonly debounceMs: number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly project: Project,
    private readonly saver: ProjectSaver,
    private readonly options: AutosaveOptions = {},
    private readonly env: AutosaveEnv = browserEnv(),
  ) {
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
    this.dirty = options.startDirty ?? false;
    this.unsubscribe = project.subscribe(this.onEvent);
    running.add(this);
    if (this.dirty) this.arm(0);
  }

  /** True while changes are not stored yet (or their write has not finished). */
  get pending(): boolean {
    return this.dirty || this.inFlight > 0;
  }

  /**
   * Saves right now if there are unsaved changes, also while a stroke is open. For `pagehide`,
   * `visibilitychange` and crashes; the write is only started, the page may go away before it ends.
   */
  flush(): void {
    if (this.disposed || !this.dirty) return;
    this.cancelTimers();
    this.start(true);
    // A stroke that is still open will close later and has more to save: its closing event re-arms the timer.
  }

  dispose(): void {
    this.disposed = true;
    running.delete(this);
    this.unsubscribe();
    this.cancelTimers();
  }

  private readonly onEvent = (e: ProjectEvent): void => {
    if (this.disposed) return;
    if (e.kind !== "history") this.dirty = true;
    // During a stroke, edits only mark the document dirty; the event that closes the stroke arms the timer.
    if (this.dirty && !this.project.strokeOpen) this.arm(this.debounceMs);
  };

  /** (Re)starts the quiet period; when it ends, the save waits for an idle moment. */
  private arm(ms: number): void {
    this.cancelTimers();
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      // A stroke opened in the meantime: it re-arms when it closes (the document is dirty, so its closing event does).
      if (this.disposed || !this.dirty || this.project.strokeOpen) return;
      this.idleHandle = this.env.idle(() => {
        this.idleHandle = null;
        if (this.project.strokeOpen) return; // same: re-armed when the stroke closes
        this.start(false);
      });
    }, ms);
  }

  private cancelTimers(): void {
    if (this.timer !== null) this.env.clearTimer(this.timer);
    if (this.idleHandle !== null) this.env.cancelIdle(this.idleHandle);
    this.timer = this.idleHandle = null;
  }

  /** `force` (flush) starts even during a stroke and queues behind a save still writing; otherwise `finish` follows up. */
  private start(force: boolean): void {
    if (this.disposed || !this.dirty) return;
    if (!force && (this.project.strokeOpen || this.inFlight > 0)) return;
    this.dirty = false;
    this.failed = false;
    this.inFlight++;
    this.saver.save(this.project).then(
      () => {
        this.options.onSaved?.();
        this.finish();
      },
      (error) => {
        this.dirty = true; // not stored: the next edit (or flush) tries again
        this.failed = true;
        this.options.onError?.(error);
        this.finish();
      },
    );
  }

  private finish(): void {
    this.inFlight--;
    // Edits that arrived while writing get their own save, unless this write just failed (no retry loop).
    if (!this.disposed && this.dirty && !this.failed && !this.project.strokeOpen && this.inFlight === 0) this.arm(this.debounceMs);
  }
}
