import { Monitor, Moon, Settings, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { strings } from "@/strings";
import { useTheme, type ThemeChoice } from "./useTheme";

const THEMES: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: strings.theme.light, Icon: Sun },
  { value: "system", label: strings.theme.system, Icon: Monitor },
  { value: "dark", label: strings.theme.dark, Icon: Moon },
];

/** App settings behind one header button; each setting is a labeled group in the menu. */
export function SettingsMenu() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={strings.settings.label}>
              <Settings />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{strings.settings.label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{strings.theme.label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemeChoice)}>
          {THEMES.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
