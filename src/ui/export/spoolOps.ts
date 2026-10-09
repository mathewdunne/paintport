// Pure edits of the export settings and the pins that go with them. DOM- and React-free.
import { normalizeHex } from "@/core";
import type { MappingPin, Spool } from "@/doc/mapping";
import type { Project } from "@/doc/project";
import type { ExportSettings } from "@/persist/exportSettings";

/** The spools with `slot` changed. Returns the same array if nothing changes. */
export function patchSpool(spools: readonly Spool[], slot: number, patch: Partial<Pick<Spool, "color" | "on">>): Spool[] {
  const color = patch.color === undefined ? undefined : normalizeHex(patch.color);
  let changed = false;
  const next = spools.map((s) => {
    if (s.slot !== slot) return s;
    const on = patch.on ?? s.on, c = color ?? s.color;
    if (on === s.on && c === s.color) return s;
    changed = true;
    return { ...s, on, color: c };
  });
  return changed ? next : (spools as Spool[]);
}

/** The spools with slots `a` and `b` exchanged: their colors and on/off states move, the slot numbers stay. */
export function swapSpools(spools: readonly Spool[], a: number, b: number): Spool[] {
  const sa = spools.find((s) => s.slot === a), sb = spools.find((s) => s.slot === b);
  if (!sa || !sb || a === b) return spools as Spool[];
  return spools.map((s) => (s === sa ? { ...s, color: sb.color, on: sb.on } : s === sb ? { ...s, color: sa.color, on: sa.on } : s));
}

/** The pin after slots `a` and `b` were exchanged (classic `swapSlotRef`): a blend stays sorted by slot, so equal recipes stay equal. Returns `pin` itself when it names neither slot. */
export function swapPinSlots(pin: MappingPin, a: number, b: number): MappingPin {
  const sw = (n: number) => (n === a ? b : n === b ? a : n);
  if (pin.kind === "spool") return sw(pin.slot) === pin.slot ? pin : { kind: "spool", slot: sw(pin.slot) };
  if (!pin.components.some((c) => c.slot === a || c.slot === b)) return pin;
  return { kind: "blend", components: pin.components.map((c) => ({ slot: sw(c.slot), ratio: c.ratio })).sort((x, y) => x.slot - y.slot) };
}

/** Exchanges spools `a` and `b` in the settings and makes the project's pins that name them follow. */
export function swapSpoolSlots(project: Project | null, settings: ExportSettings, a: number, b: number): ExportSettings {
  const spools = swapSpools(settings.spools, a, b);
  if (spools === settings.spools) return settings;
  if (project) {
    for (const [state, pin] of [...project.mapping]) {
      const next = swapPinSlots(pin, a, b);
      if (next !== pin) project.setPin(state, next);
    }
  }
  return { ...settings, spools };
}

/** The extruder count the current target prints with. */
export const printerCountOf = (settings: Pick<ExportSettings, "target" | "printerCount">): number => settings.printerCount[settings.target];
