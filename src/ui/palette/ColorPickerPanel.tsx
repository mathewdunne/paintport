import { useId, useState, type Ref } from "react";
import { HexColorPicker } from "react-colorful";
import { Input } from "@/components/ui/input";
import { normalizeHex } from "@/core";
import { strings } from "@/strings";
import { liveHexInput, parseHexInput } from "./hex";

interface ColorPickerPanelProps {
  /** The color to start from, "#RRGGBB". The panel keeps the color itself from then on (it is mounted while the popover is open). */
  initialColor: string;
  /** Called with a normalized "#RRGGBB" on every change from dragging or typing. */
  onChange: (hex: string) => void;
  /** Enter in the hex field with a valid color. */
  onSubmit: () => void;
  hexRef?: Ref<HTMLInputElement>;
}

/**
 * The picker used for adding and editing a color: a saturation/hue area and a hex field.
 * A half-typed or wrong hex value is shown as invalid and is not applied; when the field loses
 * focus it shows the actual color again. Six digits apply live; a three-digit shorthand applies on
 * Enter or blur.
 *
 * The panel owns the displayed color: the model behind it may be updated a frame late (the
 * live preview is throttled), and feeding that older value back into the picker mid-drag would
 * make the handle jump.
 */
export function ColorPickerPanel({ initialColor, onChange, onSubmit, hexRef }: ColorPickerPanelProps) {
  const [color, setColor] = useState(initialColor);
  const [draft, setDraft] = useState<string | null>(null);
  const hexId = useId();
  const errorId = useId();
  const invalid = draft !== null && parseHexInput(draft) === null;

  const change = (hex: string) => {
    setColor(hex);
    onChange(hex);
  };

  return (
    <div className="space-y-3">
      <HexColorPicker
        color={color}
        onChange={(hex) => {
          setDraft(null);
          change(normalizeHex(hex));
        }}
        aria-label={strings.palette.picker}
        style={{ width: "100%", height: 168 }}
      />
      <div className="space-y-1">
        <label htmlFor={hexId} className="text-xs font-medium">
          {strings.palette.hex}
        </label>
        <Input
          id={hexId}
          ref={hexRef}
          value={draft ?? color}
          onChange={(e) => {
            setDraft(e.target.value);
            // Six digits apply as they are typed; a shorthand waits for Enter or blur (see liveHexInput).
            const hex = liveHexInput(e.target.value);
            if (hex) change(hex);
          }}
          onBlur={() => {
            const hex = draft === null ? null : parseHexInput(draft);
            if (hex) change(hex);
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const hex = parseHexInput(draft ?? color);
            if (!hex) return;
            change(hex);
            onSubmit();
          }}
          maxLength={9}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          className="font-mono uppercase"
        />
        {invalid && (
          <p id={errorId} className="text-xs text-destructive">
            {strings.palette.hexInvalid}
          </p>
        )}
      </div>
    </div>
  );
}
