import { useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { load3MF } from "@/core";
import { MAX_PALETTE_NAME, paletteFromModel, type PalettePrint } from "@/doc/palettePrint";
import { MAX_PALETTES } from "@/persist/paletteSettings";
import { strings } from "@/strings";
import { errorMessage } from "../errorMessage";
import { nextPaint } from "../nextPaint";

interface PaletteSectionProps {
  palettes: readonly PalettePrint[];
  onPalettes: (palettes: readonly PalettePrint[]) => void;
}

/** Loads the first palette print, then sums them up with a dialog to add, rename and remove them (spec Q13.1, Q13.4). */
export function PaletteSection({ palettes, onPalettes }: PaletteSectionProps) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);

  const load = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      await nextPaint();
      const model = await load3MF(new Uint8Array(await file.arrayBuffer()));
      const next = paletteFromModel(model, file.name.replace(/\.3mf$/i, ""));
      if (next) onPalettes([...palettes, next]);
      else setError(strings.export.paletteNotPalette);
    } catch (e) {
      setError(errorMessage(e, strings.export.paletteFailed));
    } finally {
      setBusy(false);
    }
  };

  const full = palettes.length >= MAX_PALETTES;
  const addButton = (label: string) => (
    <Button variant="outline" size="xs" disabled={busy || full} onClick={() => input.current?.click()}>
      <Upload />
      {busy ? strings.export.paletteLoading : label}
    </Button>
  );
  const errorLine = error && <p role="alert" className="text-xs text-destructive">{error}</p>;
  const summary = strings.export.paletteSummary(palettes.map((p) => p.name));
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
      {palettes.length === 0 ? (
        <>
          {addButton(strings.export.paletteLoad)}
          {errorLine}
        </>
      ) : (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-xs" title={summary}>{summary}</p>
          <Button variant="outline" size="xs" onClick={() => setManaging(true)}>
            {strings.export.paletteManage}
          </Button>
        </div>
      )}
      <Dialog open={managing} onOpenChange={(open) => { setManaging(open); setError(null); }}>
        <DialogContent className="gap-4 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{strings.export.paletteManageTitle}</DialogTitle>
            <DialogDescription>{strings.export.paletteManageHint}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-1.5">
            {palettes.map((p, i) => (
              <PaletteRow
                key={i}
                palette={p}
                onRename={(name) => onPalettes(palettes.map((q, j) => (j === i ? { ...q, name } : q)))}
                onRemove={() => onPalettes(palettes.filter((_, j) => j !== i))}
              />
            ))}
          </ul>
          <div className="space-y-1.5">
            {addButton(strings.export.paletteAdd)}
            {full && <p className="text-xs text-muted-foreground">{strings.export.paletteFull(MAX_PALETTES)}</p>}
            {errorLine}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface PaletteRowProps {
  palette: PalettePrint;
  onRename: (name: string) => void;
  onRemove: () => void;
}

/** A palette's name (edited in place, kept on blur or Enter; a blank name is undone), dot count and remove button. */
function PaletteRow({ palette, onRename, onRemove }: PaletteRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const name = draft?.trim();
    if (name && name !== palette.name) onRename(name);
    setDraft(null);
  };
  const dots = palette.dots.filter((d) => !d.backdrop).length;
  return (
    <li className="flex items-center gap-2">
      <Input
        value={draft ?? palette.name}
        maxLength={MAX_PALETTE_NAME}
        aria-label={strings.export.paletteRename(palette.name)}
        className="h-7 flex-1 border-transparent px-2 text-xs shadow-none hover:border-input md:text-xs"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{strings.export.paletteDots(dots)}</span>
      <Button variant="ghost" size="icon-xs" aria-label={strings.export.paletteRemove(palette.name)} title={strings.export.paletteRemove(palette.name)} onClick={onRemove}>
        <X />
      </Button>
    </li>
  );
}
