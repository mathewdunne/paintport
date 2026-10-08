import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/doc/project";
import { ProjectSaver } from "@/doc/snapshot";
import { Autosaver } from "@/persist/autosave";
import { createIdbSnapshotStore, StoreConflictError } from "@/persist/idbStore";
import { restoreSession } from "@/persist/session";
import { requestPersistentStorage } from "@/persist/storage";
import { acquireTabLock } from "@/persist/tabLock";
import { strings } from "@/strings";
import { useImport } from "./useImport";
import { useNotices } from "./useNotices";

/** A question the user must answer before something destructive happens. */
export interface Confirmation {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm(): void;
}

const RESTORED_NOTICE_MS = 6000;

/**
 * Saved data that is in the store but was not opened: `newer` comes from a newer version of the
 * app and is protected (importing needs a confirmation); `unreadable` could not be read and is
 * only kept in case it is worth something. Either is replaced by the next project that is
 * saved, or removed by "New".
 */
type Leftover = "none" | "newer" | "unreadable";

/**
 * The open project and its life across reloads: restores the autosaved project when the app
 * starts, imports files, autosaves changes, and starts over ("New").
 *
 * Only one tab autosaves (a Web Lock; see persist/tabLock.ts). A tab that does not own it, or
 * whose storage does not work, runs without autosave and says so. Saved data this tab could
 * not open is never deleted automatically.
 */
export function useSession() {
  const { notices, notify, dismiss, dismissKey, clear: clearNotices } = useNotices();
  const importer = useImport(notify, dismissKey);
  const { project, adopt } = importer;

  const store = useMemo(() => createIdbSnapshotStore(), []);
  const saver = useMemo(() => new ProjectSaver(store), [store]);
  const [restoring, setRestoring] = useState(true);
  /** False when this tab must not write to the store: another tab owns it, the storage is unusable, or it was changed under us. */
  const [persist, setPersist] = useState(true);
  const [leftover, setLeftover] = useState<Leftover>("none");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const restored = useRef<Project | null>(null);
  const autosaver = useRef<Autosaver | null>(null);
  const leftoverRef = useRef<Leftover>("none");
  leftoverRef.current = leftover;
  const failureShown = useRef(false);

  // Take the autosave lock, then restore the last session once, when the app starts.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const lock = await acquireTabLock();
      if (cancelled) return;
      if (lock === "other") {
        setPersist(false);
        notify("tab", strings.session.otherTab, { tone: "warning" });
      }
      const result = await restoreSession(store);
      if (cancelled) return;
      switch (result.status) {
        case "restored":
          restored.current = result.project;
          adopt(result.project);
          notify("session", strings.session.restored, { autoDismissMs: RESTORED_NOTICE_MS });
          break;
        case "invalid":
          setLeftover("unreadable");
          notify("session", strings.session.invalid, { tone: "warning" });
          break;
        case "version":
          setLeftover("newer");
          notify("session", strings.session.newer, { tone: "warning" });
          break;
        case "unavailable":
          setPersist(false); // the storage does not answer: do not queue saves that may never end
          notify("session", strings.session.unavailable, { tone: "warning" });
          break;
        case "empty":
          break;
      }
      setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [store, adopt, notify]);

  // Autosave the open project; flush when the page is hidden or closed.
  useEffect(() => {
    if (!project || !persist) return;
    const wasRestored = restored.current === project;
    if (wasRestored) saver.adopt(project);
    else if (leftoverRef.current !== "none") {
      // The user chose to replace the saved data this tab could not open: this project's saves replace it.
      setLeftover("none");
      void saver.clear().catch(() => {});
    }
    failureShown.current = false;
    const saving: Autosaver = new Autosaver(project, saver, {
      startDirty: !wasRestored,
      onSaved: () => void requestPersistentStorage(),
      onError: (error) => {
        console.warn("Autosave failed", error);
        if (error instanceof StoreConflictError) {
          // Another tab replaced the saved project. Saving on would mix or overwrite its work: stop for good.
          setPersist(false);
          notify("autosave", strings.session.conflict, { tone: "warning" });
          return;
        }
        if (failureShown.current) return;
        failureShown.current = true; // once per project, not on every attempt
        notify("autosave", strings.session.autosaveFailed, { tone: "warning" });
      },
    });
    autosaver.current = saving;
    const onHidden = () => {
      if (document.visibilityState === "hidden") saving.flush();
    };
    const onPageHide = () => saving.flush();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      saving.dispose();
      if (autosaver.current === saving) autosaver.current = null;
      // No saver.reset() here: this cleanup also runs when the app crashes or unmounts, and the flush that
      // was just started must still be written. Saves are FIFO, so an older project's queued save cannot land
      // after the next project's; only "New" has to cancel queued saves, and `saver.clear()` does.
    };
  }, [project, persist, saver, notify]);

  const importFiles = importer.importFiles;
  const requestImport = useCallback(
    (files: ArrayLike<File>) => {
      const list = Array.from(files); // a dropped FileList empties once the event is over
      if (list.length === 0) return;
      if (restoring) {
        notify("import", strings.session.stillRestoring, { autoDismissMs: 5000 });
        return;
      }
      const confirmThen = (title: string, description: string) =>
        setConfirmation({
          title,
          description,
          confirmLabel: strings.session.replaceConfirm,
          onConfirm: () => {
            setConfirmation(null);
            void importFiles(list);
          },
        });
      // Work is lost by replacing a project that has edits, or one that came back from an autosave (it is someone's work either way).
      const hasWork = project !== null && (project.undoCount + project.redoCount > 0 || restored.current === project);
      if (persist && leftover === "newer") confirmThen(strings.session.replaceTitle, strings.session.replaceDescription);
      else if (hasWork) confirmThen(strings.session.replaceOpenTitle, strings.session.replaceOpenDescription);
      else void importFiles(list);
    },
    [restoring, persist, leftover, project, importFiles, notify],
  );

  const startNew = useCallback(() => {
    // Stop the autosaver first: nothing it has queued may land after the store is cleared.
    autosaver.current?.dispose();
    autosaver.current = null;
    restored.current = null;
    adopt(null);
    setLeftover("none");
    clearNotices();
    if (!persist) return; // this tab does not own the store: the saved project is not ours to delete
    saver.clear().catch((error) => {
      console.warn("Could not clear the autosaved project", error);
      notify("autosave", strings.session.clearFailed, { tone: "warning" });
    });
  }, [adopt, clearNotices, persist, saver, notify]);

  const canStartNew = !restoring && (project !== null || (persist && leftover !== "none"));
  const requestNew = useCallback(() => {
    setConfirmation({
      title: strings.session.newTitle,
      description:
        project !== null ? strings.session.newDescription : leftover === "newer" ? strings.session.newNewerDescription : strings.session.newUnreadableDescription,
      confirmLabel: strings.session.newConfirm,
      onConfirm: () => {
        setConfirmation(null);
        startNew();
      },
    });
  }, [leftover, project, startNew]);

  const cancelConfirmation = useCallback(() => setConfirmation(null), []);

  return {
    project,
    restoring,
    loading: importer.loading,
    error: importer.error,
    dismissError: importer.dismissError,
    notices,
    dismissNotice: dismiss,
    requestImport,
    canStartNew,
    requestNew,
    confirmation,
    cancelConfirmation,
  };
}
