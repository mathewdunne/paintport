import type { Project } from "@/doc/project";

/** Animation-frame scheduling, replaceable in tests. */
export interface FrameEnv {
  raf(callback: () => void): number;
  cancelRaf(id: number): void;
}

const browserEnv: FrameEnv = { raf: (cb) => requestAnimationFrame(cb), cancelRaf: (id) => cancelAnimationFrame(id) };

/**
 * One color-picker session: everything between opening and closing the picker is a single
 * undo step (a project stroke), however many times the color changes.
 *
 * `set` is the live preview. Recoloring a huge model is far more expensive than a picker
 * event, and a drag fires events faster than frames, so only the latest value is applied,
 * once per animation frame. `end` applies what is still pending and closes the step; it is
 * safe to call at any time, any number of times (Escape, outside click, unmount, import).
 *
 * The session owns the stroke it opened. If something else ends all strokes meanwhile (a brush
 * stroke finishing calls `endAllStrokes`), the project announces it with a history event while
 * no stroke is open, and the session lets go: it neither closes a stroke that now belongs to
 * someone else nor keeps previewing into it.
 *
 * A session belongs to one project and is not reused across projects.
 */
export class ColorEditSession {
  private open = false;
  private state = 0;
  private pending: string | null = null;
  private frame = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly project: Project,
    private readonly env: FrameEnv = browserEnv,
  ) {}

  /** Starts editing `state`. A session already open is closed first. */
  begin(state: number): void {
    this.end();
    this.project.beginStroke();
    this.open = true;
    this.state = state;
    this.unsubscribe = this.project.subscribe((e) => {
      // Our stroke is gone (something called endAllStrokes): nothing of it is ours to close any more.
      if (e.kind === "history" && this.open && !this.project.strokeOpen) this.release();
    });
  }

  /** Previews `hex` on the model (at most once per frame). No-op when no session is open. */
  set(hex: string): void {
    if (!this.open) return;
    this.pending = hex;
    if (!this.frame) {
      this.frame = this.env.raf(() => {
        this.frame = 0;
        this.apply();
      });
    }
  }

  /** Applies the pending value and closes the undo step. A session with no net change leaves no step. */
  end(): void {
    if (!this.open) return;
    try {
      this.apply();
    } finally {
      const owned = this.project.strokeOpen;
      this.release();
      if (owned) this.project.endStroke();
    }
  }

  /** Forgets the session without touching the project's strokes. */
  private release(): void {
    this.open = false;
    this.pending = null;
    if (this.frame) {
      this.env.cancelRaf(this.frame);
      this.frame = 0;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private apply(): void {
    const hex = this.pending;
    if (hex === null) return;
    this.pending = null;
    try {
      this.project.setColor(this.state, hex);
    } catch (e) {
      console.error("Could not preview the color", e); // e.g. the color is gone; the session still closes cleanly
    }
  }
}
