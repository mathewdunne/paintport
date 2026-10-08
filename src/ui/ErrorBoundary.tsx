import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { flushAutosavers } from "@/persist/autosave";
import { strings } from "@/strings";

interface State {
  failed: boolean;
}

/**
 * Last line of defense for a render error: instead of a blank page it shows a short message
 * with "Try again" (mounts the app again, which restores the last autosave) and "Reload page".
 *
 * Unsaved changes are flushed first. `getDerivedStateFromError` runs before React tears the
 * app down (its autosaver is disposed during that teardown), so this is where the flush has
 * to happen.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    try {
      flushAutosavers();
    } catch {
      /* best effort: the error page must still show */
    }
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("PaintPort+ crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
        <h1 className="text-lg font-semibold">{strings.crash.title}</h1>
        <p className="max-w-md text-sm text-muted-foreground">{strings.crash.description}</p>
        <div className="flex gap-2">
          <Button onClick={() => this.setState({ failed: false })}>{strings.crash.retry}</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>
            {strings.crash.reload}
          </Button>
        </div>
      </div>
    );
  }
}
