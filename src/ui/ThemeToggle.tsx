import { Monitor, Moon, Sun } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { strings } from "@/strings";
import { useTheme, type ThemeChoice } from "./useTheme";

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: strings.theme.light, Icon: Sun },
  { value: "system", label: strings.theme.system, Icon: Monitor },
  { value: "dark", label: strings.theme.dark, Icon: Moon },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={theme}
      // Radix emits "" when the active item is clicked again; keep the current choice.
      onValueChange={(v) => v && setTheme(v as ThemeChoice)}
      aria-label={strings.theme.label}
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <ToggleGroupItem value={value} aria-label={label}>
              <Icon />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
