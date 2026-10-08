import { useCallback, useEffect, useRef, useState } from "react";

export interface Notice {
  id: number;
  /** A new notice replaces the one with the same key. */
  key: string;
  text: string;
  tone: "info" | "warning";
}

export interface NoticeOptions {
  tone?: Notice["tone"];
  /** Remove the notice by itself after this long. */
  autoDismissMs?: number;
}

export type Notify = (key: string, text: string, options?: NoticeOptions) => void;

/** Short messages shown over the viewport: restored session, autosave trouble, extra files ignored. */
export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => setNotices((all) => all.filter((n) => n.id !== id)), []);
  const dismissKey = useCallback((key: string) => setNotices((all) => (all.some((n) => n.key === key) ? all.filter((n) => n.key !== key) : all)), []);
  const clear = useCallback(() => setNotices([]), []);

  const notify = useCallback<Notify>(
    (key, text, options = {}) => {
      const id = nextId.current++;
      setNotices((all) => [...all.filter((n) => n.key !== key), { id, key, text, tone: options.tone ?? "info" }]);
      if (options.autoDismissMs) {
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          dismiss(id);
        }, options.autoDismissMs);
        timers.current.add(timer);
      }
    },
    [dismiss],
  );

  return { notices, notify, dismiss, dismissKey, clear };
}
