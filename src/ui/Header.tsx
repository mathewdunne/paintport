import { ExternalLink, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { strings } from "@/strings";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
      <span className="text-sm font-semibold tracking-tight">{strings.appName}</span>
      <div className="flex items-center gap-2">
        {/* Placeholder: import is wired up together with the viewer. */}
        <Button size="sm" disabled title={strings.header.importHint}>
          <Upload />
          {strings.header.import}
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="sm" asChild>
          <a href="./classic/" title={strings.header.classicHint}>
            {strings.header.classic}
            <ExternalLink />
          </a>
        </Button>
      </div>
    </header>
  );
}
