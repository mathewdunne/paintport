// One tab at a time may autosave. Two tabs saving into the same IndexedDB project would
// overwrite each other's work, so the first tab takes a Web Lock for its lifetime and a later
// tab runs without autosave (and says so). The store itself also refuses a paint write that
// does not match the stored geometry (idbStore.ts), which covers browsers without Web Locks.

export type TabLockResult =
  /** This tab owns autosave. */
  | "held"
  /** Another tab owns it: this tab must not autosave. */
  | "other"
  /** No Web Locks (or the browser refused): nothing known, autosave as usual. */
  | "unsupported";

export const TAB_LOCK_NAME = "paintportplus";

/** The part of `navigator.locks` that is used (and faked in tests). */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<unknown> | undefined): Promise<unknown>;
}

/**
 * Requests the lock once and holds it until the page is gone. The callback's promise never
 * settles, which is what keeps the lock; the browser releases it when the tab closes or crashes.
 */
export function createTabLock(manager: LockManagerLike | undefined | null): () => Promise<TabLockResult> {
  let result: Promise<TabLockResult> | null = null;
  return () =>
    (result ??= new Promise<TabLockResult>((resolve) => {
      if (!manager) {
        resolve("unsupported");
        return;
      }
      try {
        manager
          .request(TAB_LOCK_NAME, { ifAvailable: true }, (lock) => {
            resolve(lock ? "held" : "other");
            return lock ? new Promise<never>(() => {}) : undefined;
          })
          .catch(() => resolve("unsupported"));
      } catch {
        resolve("unsupported"); // e.g. a SecurityError in an opaque origin
      }
    }));
}

// One request per page, also across hot reloads of this module in development (a second request would find the first one held).
const shared = globalThis as { __paintportTabLock?: () => Promise<TabLockResult> };

/** The page's lock request (made on first use). */
export const acquireTabLock = (): Promise<TabLockResult> =>
  (shared.__paintportTabLock ??= createTabLock((globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks))();
