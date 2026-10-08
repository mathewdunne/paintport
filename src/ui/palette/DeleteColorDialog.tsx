import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { Project } from "@/doc/project";
import { cn } from "@/lib/utils";
import { strings } from "@/strings";
import { ColorChip } from "./ColorChip";

interface DeleteColorDialogProps {
  project: Project;
  /** The color to delete, or null when the dialog is closed. */
  state: number | null;
  onCancel: () => void;
  /** The user chose where its surface goes (0 = base). */
  onDelete: (state: number, mergeInto: number) => void;
}

/**
 * Deleting a color merges its surface into another color or back into the base. Base is not
 * offered when the color is some part's (or modifier's) base color, since that part would be
 * left with no color; merging into another color moves those bases along.
 */
export function DeleteColorDialog({ project, state, onCancel, onDelete }: DeleteColorDialogProps) {
  // The body is mounted only while open, so the usage counts are computed when the dialog opens and not on every change.
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false}>{state !== null && <Body project={project} state={state} onCancel={onCancel} onDelete={onDelete} />}</DialogContent>
    </Dialog>
  );
}

function Body({ project, state, onCancel, onDelete }: Omit<DeleteColorDialogProps, "state"> & { state: number }) {
  const palette = project.palette;
  const usage = useMemo(() => project.colorUsage(), [project]);
  const baseParts = project.basePartsOf(state).length;
  const baseBlocked = baseParts > 0;
  // Base is the natural default. When it is not available the user has to pick: no default that merges by accident.
  const [target, setTarget] = useState<string>(baseBlocked ? "" : "0");

  const color = palette[state];
  const rows = palette.map((c, s) => ({ c, s })).filter(({ s }) => s >= 1 && s !== state);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ColorChip color={color.color} className="size-5" />
          {strings.palette.deleteTitle(state)}
        </DialogTitle>
        <DialogDescription>{strings.palette.deleteDescription}</DialogDescription>
        <p className="text-xs text-muted-foreground">{strings.palette.usage(usage[state].painted, usage[state].base)}</p>
      </DialogHeader>

      <RadioGroup value={target} onValueChange={setTarget} aria-label={strings.palette.mergeInto} className="max-h-72 gap-1 overflow-y-auto pr-1">
        <Option value="0" disabled={baseBlocked} describedBy={baseBlocked ? "base-reason" : undefined}>
          <span className="flex min-w-0 flex-col">
            <span className="font-medium">{strings.palette.baseOption}</span>
            <span className="text-xs text-muted-foreground">{strings.palette.baseOptionHint}</span>
          </span>
        </Option>
        {baseBlocked && (
          <p id="base-reason" className="-mt-0.5 px-2 pb-1 text-xs text-muted-foreground">
            {strings.palette.baseUnavailable(baseParts)}
          </p>
        )}
        {rows.map(({ c, s }) => (
          <Option key={s} value={String(s)}>
            <ColorChip color={c.color} className="size-5" />
            <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
              <span className="font-medium">
                {strings.palette.colorName(s)} <span className="font-mono text-xs font-normal text-muted-foreground">{c.color}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{strings.palette.usage(usage[s].painted, usage[s].base)}</span>
            </span>
          </Option>
        ))}
      </RadioGroup>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {strings.palette.cancel}
        </Button>
        <Button variant="destructive" disabled={target === ""} onClick={() => onDelete(state, Number(target))}>
          {strings.palette.deleteConfirm}
        </Button>
      </DialogFooter>
    </>
  );
}

function Option({ value, disabled, describedBy, children }: { value: string; disabled?: boolean; describedBy?: string; children: ReactNode }) {
  const id = `merge-${value}`;
  return (
    <label
      htmlFor={id}
      className={cn("flex items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 text-sm has-data-checked:border-border has-data-checked:bg-muted", disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-muted/60")}
    >
      <RadioGroupItem id={id} value={value} disabled={disabled} aria-describedby={describedBy} />
      {children}
    </label>
  );
}
