import { useRef } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { strings } from "@/strings";
import type { Confirmation } from "./useSession";

/** A yes/no question before something that cannot be undone. Cancel is the default focus. */
export function ConfirmDialog({ confirmation, onCancel }: { confirmation: Confirmation | null; onCancel: () => void }) {
  // The text stays while the dialog fades out, after `confirmation` is already null.
  const last = useRef(confirmation);
  if (confirmation) last.current = confirmation;
  const shown = last.current;
  return (
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          <AlertDialogDescription>{shown?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{strings.session.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => confirmation?.onConfirm()}>
            {shown?.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
