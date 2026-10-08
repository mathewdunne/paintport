import { useRef, type ChangeEvent } from "react";
import { ExternalLink, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { strings } from "@/strings";
import { ThemeToggle } from "./ThemeToggle";

export function Header({ onImportFiles }: { onImportFiles: (files: ArrayLike<File>) => void }) {
  const input = useRef<HTMLInputElement>(null);

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ""; // so picking the same file again still fires a change
    onImportFiles(files);
  };

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-3">
      <span className="text-sm font-semibold tracking-tight">{strings.appName}</span>
      <div className="flex items-center gap-2">
        <input ref={input} type="file" accept=".3mf,.stl,.obj" className="hidden" onChange={onChange} />
        <Button size="sm" title={strings.header.importHint} onClick={() => input.current?.click()}>
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
