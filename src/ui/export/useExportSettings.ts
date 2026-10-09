import { useEffect, useState, useSyncExternalStore } from "react";
import { createExportSettingsStore } from "./settingsStore";

/** The export settings (target, spools, ColorMix): read from localStorage once, saved shortly after a change and when the page is hidden. */
export function useExportSettings() {
  const [store] = useState(() => createExportSettingsStore());
  const settings = useSyncExternalStore(store.subscribe, store.getSnapshot);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") store.flush();
    };
    const onPageHide = () => store.flush();
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      store.flush();
    };
  }, [store]);

  return { settings, update: store.update };
}
