import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { load3MF } from "@/core";
import { paletteFromModel, type PalettePrint } from "@/doc/palettePrint";
import { strings } from "@/strings";
import { errorMessage } from "../errorMessage";
import { nextPaint } from "../nextPaint";

interface PaletteSectionProps {
  palette: PalettePrint | null;
  onPalette: (palette: PalettePrint | null) => void;
}

/** Loads, replaces or removes the palette print (spec Q13.1, Q13.4). */
export function PaletteSection({ palette, onPalette }: PaletteSectionProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await nextPaint();
      const model = await load3MF(new Uint8Array(await file.arrayBuffer()));
      const next = paletteFromModel(model, file.name.replace(/\.3mf$/i, ""));
      if (next) onPalette(next);
      else setError(strings.export.paletteNotPalette);
    } catch (e) {
      setError(errorMessage(e, strings.export.paletteFailed));
    } finally {
      setBusy(false);
    }
  };

  const clickable = palette ? palette.dots.filter((d) => !d.backdrop).length : 0;
  return (
    <div className="space-y-1.5">
      <input
        ref={input}
        type="file"
        accept=".3mf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void load(file);
        }}
      />
      {palette && <p className="truncate text-xs" title={palette.name}>{strings.export.paletteSummary(palette.name, clickable)}</p>}
      <div className="flex flex-wrap gap-1.5">
        <Button variant="outline" size="xs" disabled={busy} onClick={() => input.current?.click()}>
          <Upload />
          {busy ? strings.export.paletteLoading : palette ? strings.export.paletteReplace : strings.export.paletteLoad}
        </Button>
        {palette && (
          <Button variant="outline" size="xs" disabled={busy} onClick={() => { setError(null); onPalette(null); }}>
            {strings.export.paletteRemove}
          </Button>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
