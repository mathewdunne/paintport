import { cn } from "@/lib/utils";

/** A small color square with an outline that shows on any color in both themes. For colors given as hex values only. */
export function ColorChip({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-4 shrink-0 rounded-sm border border-foreground/25", className)} style={{ backgroundColor: color }} />;
}
