// Restoring the autosaved project when the app starts.
import type { Project } from "../doc/project";
import { restoreProject, type SnapshotStore } from "../doc/snapshot";

export type SessionRestore =
  | { status: "restored"; project: Project }
  /** Nothing was saved. */
  | { status: "empty" }
  /** What was saved could not be read. It is still in the store; the next save of a new project replaces it. */
  | { status: "invalid" }
  /** What was saved comes from another (probably newer) version. It is still in the store. */
  | { status: "version" }
  /** The browser would not let us read the store (private mode, blocked storage, or it never answered). Autosave probably cannot work either. */
  | { status: "unavailable" };

/** How long startup waits for the browser's storage before it gives up and starts without it. */
export const RESTORE_TIMEOUT_MS = 8000;

/**
 * `restoreProject` with storage failures turned into a result, so the app always starts. An
 * `indexedDB.open()` that never settles (a blocked or crashed storage backend) counts as
 * `unavailable` after `timeoutMs`; a restore that finishes later is ignored.
 */
export async function restoreSession(store: SnapshotStore, timeoutMs = RESTORE_TIMEOUT_MS): Promise<SessionRestore> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SessionRestore>((resolve) => {
    timer = setTimeout(() => resolve({ status: "unavailable" }), timeoutMs);
  });
  const restore = restoreProject(store).then(
    (r): SessionRestore => (r.status === "restored" ? r : { status: r.status }),
    (e): SessionRestore => {
      console.warn("Could not read the saved session", e);
      return { status: "unavailable" };
    },
  );
  try {
    return await Promise.race([restore, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
