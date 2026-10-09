// The used design colors of a project, kept up to date without scanning the mesh on every brush dab.
// React-free (timers are injected for tests).
import { usedStates } from "@/doc/mapping";
import type { State } from "@/doc/paintField";
import type { Project } from "@/doc/project";

export interface TimerEnv {
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
}

const browserTimers: TimerEnv = { setTimer: (cb, ms) => window.setTimeout(cb, ms), clearTimer: (id) => window.clearTimeout(id) };

/** Paint events this close together count as one burst: the scan waits until the burst is over. */
export const SETTLE_MS = 200;

const sameStates = (a: readonly State[], b: readonly State[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * `usedStates` reads every triangle (about 3 ms per million), so it must not run per dab.
 * Which colors are used changes through exactly these events:
 * - paint: scan once the painting has paused for `SETTLE_MS`, or at once when the stroke ends
 *   (the history event with no stroke open), whichever comes first;
 * - base color changes and palette renumbering (a delete/merge, or its undo): scan at once,
 *   they are single actions.
 * Other palette edits and mapping changes cannot change the set. Subscribers are told only
 * when the set of used states actually changed, so nothing downstream recomputes needlessly.
 *
 * It works as an external store (`subscribe` + `getSnapshot`). Listening to the project starts
 * with the first subscriber and ends with the last, and the first subscriber catches up with
 * everything that happened since the snapshot was taken.
 */
export class UsedStatesTracker {
  private states: readonly State[];
  private detach: (() => void) | null = null;
  private timer = 0;
  private dirty = false;
  private scannedVersion: number;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly project: Project,
    private readonly timers: TimerEnv = browserTimers,
  ) {
    this.states = usedStates(project);
    this.scannedVersion = project.version;
  }

  readonly getSnapshot = (): readonly State[] => this.states;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.attach();
      if (this.project.version !== this.scannedVersion) this.scan(); // changed since the snapshot was taken
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.detachFromProject();
    };
  };

  private attach(): void {
    this.detach = this.project.subscribe((e) => {
      switch (e.kind) {
        case "paint":
          this.dirty = true;
          this.timers.clearTimer(this.timer);
          this.timer = this.timers.setTimer(() => this.scan(), SETTLE_MS);
          break;
        case "base":
          this.scan();
          break;
        case "palette":
          if (e.renumbered) this.scan();
          break;
        case "history":
          if (this.dirty && !this.project.strokeOpen) this.scan();
          break;
      }
    });
  }

  private detachFromProject(): void {
    this.detach?.();
    this.detach = null;
    this.timers.clearTimer(this.timer);
    this.timer = 0;
  }

  /** Reads the used states now; notifies if they changed. */
  private scan(): void {
    this.timers.clearTimer(this.timer);
    this.timer = 0;
    this.dirty = false;
    this.scannedVersion = this.project.version;
    const next = usedStates(this.project);
    if (sameStates(next, this.states)) return;
    this.states = next;
    for (const l of [...this.listeners]) l();
  }
}
