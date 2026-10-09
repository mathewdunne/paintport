import { Button } from "@/components/ui/button";
import { strings } from "@/strings";
import type { AiModelState } from "./useAiModel";

const mb = (bytes: number) => (bytes / 1e6).toFixed(0);

/** The Paint panel's AI Paint section: availability, the one-time download and status (spec Q10.6). */
export function AiPaintSection({ state, onDownload }: { state: AiModelState; onDownload: () => void }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{strings.panel.aiPaint}</h2>
      <p className="text-xs text-muted-foreground">{strings.panel.aiAbout}</p>
      <div role="status" className="space-y-2 text-xs">
        {state.kind === "checking" && <p>{strings.panel.aiChecking}</p>}
        {state.kind === "unavailable" && <p>{strings.aiUnavailable[state.reason]}</p>}
        {state.kind === "needsDownload" && (
          <>
            <p>{strings.panel.aiDownloadPrompt(mb(state.bytes))}</p>
            <Button size="sm" onClick={onDownload}>{strings.panel.aiDownload}</Button>
          </>
        )}
        {state.kind === "downloading" && (
          <>
            <p className="tabular-nums">{strings.panel.aiDownloading(mb(state.loaded), mb(state.total))}</p>
            <div className="h-1.5 overflow-hidden rounded bg-muted">
              <div className="h-full bg-primary" style={{ width: `${Math.min(100, (state.loaded / state.total) * 100)}%` }} />
            </div>
          </>
        )}
        {state.kind === "starting" && <p>{strings.panel.aiStarting}</p>}
        {state.kind === "ready" && <p>{strings.panel.aiReady}</p>}
        {state.kind === "failed" && (
          <>
            <p>{strings.panel.aiFailed}</p>
            <Button size="sm" variant="outline" onClick={onDownload}>{strings.panel.aiRetry}</Button>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{strings.panel.aiCredits}</p>
    </section>
  );
}
