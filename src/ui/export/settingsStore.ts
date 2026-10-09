// The export settings as a small observable store: loaded once, saved shortly after a change.
// React-free, so the persistence logic is tested without a DOM; `useExportSettings` binds it to React.
import { loadExportSettings, saveExportSettings, type ExportSettings, type KeyValueStorage } from "@/persist/exportSettings";

export interface SaveTimers {
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
}

const globalTimers: SaveTimers = {
  setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
};

/** A color-picker drag changes the settings every frame; the write waits until it has been quiet this long. */
export const SAVE_DELAY_MS = 300;

export class ExportSettingsStore {
  private current: ExportSettings;
  private readonly listeners = new Set<() => void>();
  private timer: number | null = null;

  constructor(
    initial: ExportSettings,
    private readonly save: (settings: ExportSettings) => void,
    private readonly timers: SaveTimers = globalTimers,
  ) {
    this.current = initial;
  }

  /** The current settings: the same object until something changes (a stable snapshot for `useSyncExternalStore`). */
  readonly getSnapshot = (): ExportSettings => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Replaces the settings with `change(current)`. Listeners hear about it at once; the write to
   * storage follows after `SAVE_DELAY_MS` without further changes (or at `flush`). Returning the
   * same object changes and saves nothing.
   */
  readonly update = (change: (settings: ExportSettings) => ExportSettings): void => {
    const next = change(this.current);
    if (next === this.current) return;
    this.current = next;
    if (this.timer !== null) this.timers.clearTimer(this.timer);
    this.timer = this.timers.setTimer(() => this.flush(), SAVE_DELAY_MS);
    for (const l of [...this.listeners]) l();
  };

  /** Writes a pending change now (the page is being hidden or closed). A refused write only means the settings last for this page view. */
  readonly flush = (): void => {
    if (this.timer === null) return;
    this.timers.clearTimer(this.timer);
    this.timer = null;
    this.save(this.current);
  };
}

/** Loads the saved settings once (the browser's localStorage, or `storage` in tests) and saves later changes. */
export function createExportSettingsStore(storage?: KeyValueStorage | null, timers?: SaveTimers): ExportSettingsStore {
  const settings = storage === undefined ? loadExportSettings() : loadExportSettings(storage);
  return new ExportSettingsStore(settings, (s) => {
    if (storage === undefined) saveExportSettings(s);
    else saveExportSettings(s, storage);
  }, timers);
}
