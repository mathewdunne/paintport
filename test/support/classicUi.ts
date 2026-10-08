// Evaluates the classic tool's mapping functions (they sit outside the CORE block, in the UI
// script) in an isolated node:vm context with a tiny fake DOM, so the TypeScript port can be
// compared with them on the same inputs.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { loadClassicCore } from "./classic";

export interface ClassicTarget {
  flavor: string;
  suffix: string;
  printerN: number;
  mix: boolean;
  bbsApp?: string;
  mixFormat?: string;
}

export interface ClassicUi {
  PRESETS: { id: string; colors: string[] }[];
  DEFAULT_SLOTS: string[];
  TARGETS: Record<string, ClassicTarget>;
  /** `f` only needs a `color`. Returns "p<N>", "mix" or null. */
  bestOption(f: { color: string }, slots: { slot: number; color: string }[], allowMix: boolean): string | null;
  /** The classic file name suffix for slots 1..n given as {color, on}. */
  colorModeSuffix(spools: { color: string; on: boolean }[], n: number): string;
}

const html = readFileSync(new URL("../../public/classic/index.html", import.meta.url), "utf8");

function grab(re: RegExp, what: string): string {
  const m = re.exec(html);
  if (!m) throw new Error(`classic tool: ${what} not found`);
  return m[0];
}

let cached: ClassicUi | null = null;

export function loadClassicUi(): ClassicUi {
  if (cached) return cached;
  const { core } = loadClassicCore();
  const code = [
    grab(/^const TARGETS = \{[\s\S]*?^\};/m, "TARGETS"),
    grab(/^const DEFAULT_SLOTS = \[[\s\S]*?\];/m, "DEFAULT_SLOTS"),
    grab(/^const PRESETS = \[[\s\S]*?^\];/m, "PRESETS"),
    grab(/^function bestOption\([\s\S]*?^\}/m, "bestOption"),
    grab(/^function activeSlots\(\)[\s\S]*?^\}/m, "activeSlots"),
    grab(/^function colorModeSuffix\(\)[\s\S]*?^\}/m, "colorModeSuffix"),
  ].join("\n");
  const ctx = vm.createContext({ PaintPortCore: core });
  // The fake DOM: slot rows read from __state, which the wrapper below sets per call.
  vm.runInContext(
    `var __state = { n: 8, spools: [] };
     const $ = (id) => { const m = /^(slotOn|slotHex)(\\d+)$/.exec(id); const s = __state.spools[+m[2] - 1]; return m[1] === "slotOn" ? { checked: s.on } : { value: s.color }; };
     function printerCount() { return __state.n; }
     ${code}`,
    ctx,
    { filename: "classic-ui.js" },
  );
  const g = vm.runInContext("({ TARGETS, DEFAULT_SLOTS, PRESETS, bestOption, colorModeSuffix, setState(s) { __state = s; } })", ctx) as {
    TARGETS: ClassicUi["TARGETS"]; DEFAULT_SLOTS: string[]; PRESETS: ClassicUi["PRESETS"];
    bestOption: ClassicUi["bestOption"]; colorModeSuffix(): string; setState(s: unknown): void;
  };
  const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T; // out of the vm realm
  cached = {
    TARGETS: plain(g.TARGETS),
    DEFAULT_SLOTS: plain(g.DEFAULT_SLOTS),
    PRESETS: plain(g.PRESETS),
    bestOption: g.bestOption,
    colorModeSuffix(spools, n) {
      g.setState({ n, spools });
      return g.colorModeSuffix();
    },
  };
  return cached;
}
