// The export must write what the classic tool's `doExport` plan writes through the same
// `build3MF`. Seeded synthetic painted 3MFs are imported, every used design color is pinned to
// the spool equal to its original file extruder (spools set to the file colors), and the
// project's export is compared byte for byte with `build3MF(originalModel, classicPlan)`; the
// plan is written out by hand here, the way `doExport` builds it. File states above 16 (the
// synthetic files go up to 300, so Prusa's 8-bit escape is read) are pinned many-to-one onto the
// slots 1..16, which the classic stateMap allows.
//
// Intended differences, made explicit by normalizing the ORIGINAL model before the build (never
// by loosening the comparison):
//  1. Paint on triangles that are not ModelParts (negative volumes, modifiers, supports) is
//     dropped by the document import, so it is removed from the expected model.
//  2. A single-leaf paint string for state 0 means "unpainted" in the document; classic would
//     emit it as `paint_color="0"` (or skip the paint-all fill under it), so it becomes null.
//  3. Colors that are not used by any painted ModelPart leaf or part base are not mapped: only
//     the used states are in the plan (classic also maps an object's default extruder even
//     when no part uses it, which the synthetic files avoid by construction here).
//  4. Parts without triangles are left out of the export (they print nothing); classic keeps them
//     as ranges, which would only split merged ranges or add empty components. (An object with
//     no triangles at all keeps its parts.)
//  5. Names go through XML-unescaping once on import; the synthetic names contain no entities
//     (the classic tool would double-escape those on export), so they compare equal.
import { describe, expect, it } from "vitest";
import { build3MF, load3MF, normalizeHex, PaintPortCore, predictMix, zipAll, type Build3MFPlan, type Model, type VirtualExtruder } from "../core";
import { makeRng, PARITY_SCALE, PARITY_SEED } from "../../test/support/prng";
import { genScenario } from "../../test/support/synth";
import { defaultExportSettings, type ExportSettings } from "../persist/exportSettings";
import { collectUsedStates } from "./designImport";
import { buildExport } from "./export";
import { isSplitTree } from "./paintTree";
import { defaultSpools, EXPORT_TARGETS, type ExportTargetId, type Spool } from "./mapping";
import { createProject } from "./project";

const dec = new TextDecoder();
const DATE = "2026-05-06";
const NAME = "scn";
const TARGETS: ExportTargetId[] = ["prusa", "bambu", "snapmaker"];
const SIDECAR_JSON = "Metadata/PaintPortPlus.json";

/** The original model without the paint the document import drops on purpose (differences 1 and 2). */
function normalized(model: Model): Model {
  return {
    ...model,
    objects: model.objects.map((o) => {
      const printable = new Uint8Array(o.tris.length / 3);
      for (const p of o.parts) if (p.type === "ModelPart") printable.fill(1, p.firstTri, p.firstTri + p.triCount);
      const paints = o.paints.map((paint, t) => {
        if (!paint || !printable[t]) return null;
        if (!isSplitTree(paint) && o.triState[t] === 0) return null;
        return paint;
      });
      return { ...o, paints, parts: o.parts.some((p) => p.triCount > 0) ? o.parts.filter((p) => p.triCount > 0) : o.parts };
    }),
  };
}

interface Case {
  model: Model;
  /** File extruder of each design state 1..k (index = state - 1). */
  fileStates: number[];
  /** The spool slot each file state is pinned to (itself up to 16, then folded onto 1..16). */
  slotOf: (fileState: number) => number;
  /** The slots that are on, ascending. */
  slots: number[];
  settings: ExportSettings;
}

const slotOf = (fileState: number): number => ((fileState - 1) % 16) + 1;

/** Spools 1..16: the slots the used file extruders map to are on, with the color of the first file extruder that maps there. */
function caseFor(model: Model, target: ExportTargetId): Case | null {
  const fileStates = collectUsedStates(model);
  if (fileStates.length === 0) return null;
  const slots = [...new Set(fileStates.map(slotOf))].sort((a, b) => a - b);
  const spools: Spool[] = defaultSpools().map((s) => {
    const first = fileStates.find((f) => slotOf(f) === s.slot);
    return first === undefined ? { ...s, on: false } : { slot: s.slot, on: true, color: normalizeHex(model.filaments[first - 1]?.color ?? s.color) };
  });
  const settings = defaultExportSettings();
  settings.target = target;
  settings.printerCount = { prusa: 16, bambu: 16, snapmaker: 16 };
  settings.spools = spools;
  return { model, fileStates, slotOf, slots, settings };
}

function classicPlan(c: Case, virtuals: VirtualExtruder[], stateMap: Map<number, number>): Build3MFPlan {
  const t = EXPORT_TARGETS[c.settings.target];
  const bbs = t.flavor === "bambu";
  const pBase = bbs ? Math.max(...c.slots) : 16;
  return {
    target: t.flavor,
    bbsApp: t.bbsApp,
    mixFormat: t.mixFormat,
    stateMap,
    physical: Array.from({ length: pBase }, (_, i) => ({ slot: i + 1, color: c.settings.spools[i].color })),
    virtuals,
    title: NAME + (t.flavor === "prusa" ? " (INDX)" : " (PaintPort)"),
    date: DATE,
  };
}

/** Every entry of the classic build must be in the export, byte for byte; the export adds only the sidecar. */
function expectSameFiles(actual: { name: string; data: Uint8Array }[], expected: { name: string; data: Uint8Array }[], objectCount: number, where: string): void {
  const sidecar = actual.filter((e) => e.name === SIDECAR_JSON || e.name.startsWith("Metadata/PaintPortPlus/"));
  expect(sidecar.map((e) => e.name), where).toEqual([SIDECAR_JSON, ...Array.from({ length: objectCount }, (_, i) => `Metadata/PaintPortPlus/object_${i}.bin`)]);
  const rest = actual.filter((e) => !sidecar.includes(e));
  expect(rest.map((e) => e.name), where).toEqual(expected.map((e) => e.name));
  for (const e of expected) {
    const got = rest.find((x) => x.name === e.name)!;
    expect(dec.decode(got.data), `${where}: ${e.name}`).toBe(dec.decode(e.data));
  }
}

/** Synthetic scenarios that load, as models (the generator also injects error conditions, which are skipped). */
async function scenarios(label: string, count: number): Promise<Model[]> {
  const rng = makeRng(PARITY_SEED, label);
  const out: Model[] = [];
  for (let i = 0; i < count; i++) {
    const sc = genScenario(rng, PaintPortCore);
    try {
      out.push(await load3MF(await zipAll(sc.files)));
    } catch {
      // an injected error condition: nothing to export
    }
  }
  return out;
}

const COUNT = Math.round(80 * PARITY_SCALE);

describe.each(TARGETS)("export parity with the classic plan: %s", (targetId) => {
  it("spool pins to the original extruders give the same files", async () => {
    let compared = 0, folded = 0, escaped = 0;
    for (const model of await scenarios(`exportParity/${targetId}`, COUNT)) {
      const c = caseFor(model, targetId);
      if (!c) continue;
      const project = createProject(model, { name: NAME });
      c.fileStates.forEach((fileState, i) => project.setPin(i + 1, { kind: "spool", slot: c.slotOf(fileState) }));
      if (c.fileStates.some((f) => f > 16)) folded++;
      if (model.paintDialect === "prusa" && c.fileStates.some((f) => f > 16)) escaped++; // the source used the 8-bit escape
      const expected = build3MF(normalized(model), classicPlan(c, [], new Map(c.fileStates.map((f) => [f, c.slotOf(f)]))));
      const actual = buildExport(project, c.settings, { date: DATE });
      expectSameFiles(actual.entries, expected.entries, model.objects.length, `${targetId} #${compared}`);
      expect(actual.mmVersion).toBe(expected.mmVersion);
      expect(actual.virtualCount).toBe(0);
      compared++;
    }
    expect(compared).toBeGreaterThan(20);
    expect(folded).toBeGreaterThan(2); // states above 16 really were mapped many-to-one
    expect(escaped).toBeGreaterThan(0);
  });

  it("blend pins give the same virtual extruders, deduplicated and numbered like the classic plan", async () => {
    const rng = makeRng(PARITY_SEED, `exportParity/blends/${targetId}`);
    let compared = 0, blended = 0, capped = 0, escapedOut = 0;
    for (const model of await scenarios(`exportParity/blendModels/${targetId}`, COUNT)) {
      const c = caseFor(model, targetId);
      if (!c || c.slots.length < 2) continue;
      const project = createProject(model, { name: NAME });
      const pBase = EXPORT_TARGETS[targetId].flavor === "bambu" ? Math.max(...c.slots) : 16;
      const stateMap = new Map<number, number>();
      const virtuals: VirtualExtruder[] = [];
      const byKey = new Map<string, number>();
      c.fileStates.forEach((fileState, i) => {
        const state = i + 1;
        if (!rng.bool(0.5)) {
          project.setPin(state, { kind: "spool", slot: c.slotOf(fileState) });
          stateMap.set(fileState, c.slotOf(fileState));
          return;
        }
        // a blend of two of the active slots, 1:1 or 1:3 (the plan keeps a < b)
        const [a, b] = rng.shuffle([...c.slots]).slice(0, 2).sort((x, y) => x - y);
        const ratios = rng.pick([[1, 1], [1, 3]]);
        project.setPin(state, { kind: "blend", components: [{ slot: a, ratio: ratios[0] }, { slot: b, ratio: ratios[1] }] });
        const key = `${a}:${ratios[0]}|${b}:${ratios[1]}`;
        let id = byKey.get(key);
        if (id === undefined) {
          id = pBase + virtuals.length + 1;
          const comps = [{ slot: a, color: c.settings.spools[a - 1].color, ratio: ratios[0] }, { slot: b, color: c.settings.spools[b - 1].color, ratio: ratios[1] }];
          virtuals.push({ id, color: predictMix(comps), components: comps.map((m) => ({ extruder: m.slot, ratio: m.ratio })) });
          byKey.set(key, id);
        }
        stateMap.set(fileState, id);
        blended++;
      });
      if (EXPORT_TARGETS[targetId].mixFormat === "bambu" && pBase + virtuals.length > 16) {
        // the one case where the classic build refuses too: surfaced as a DocError
        expect(() => build3MF(normalized(model), classicPlan(c, virtuals, stateMap))).toThrow(expect.objectContaining({ code: "ERR_BBS_MAX16" }));
        expect(() => buildExport(project, c.settings, { date: DATE })).toThrow(expect.objectContaining({ code: "EXPORT_BAMBU_LIMIT" }));
        capped++;
        continue;
      }
      const expected = build3MF(normalized(model), classicPlan(c, virtuals, stateMap));
      const actual = buildExport(project, c.settings, { date: DATE });
      expectSameFiles(actual.entries, expected.entries, model.objects.length, `${targetId} blends #${compared}`);
      expect(actual.mmVersion).toBe(expected.mmVersion);
      expect(actual.virtualCount).toBe(virtuals.length);
      if (expected.mmVersion === 2) escapedOut++;
      compared++;
    }
    expect(compared + capped).toBeGreaterThan(15);
    expect(blended).toBeGreaterThan(10);
    // Prusa writes the blends' ids 17+ with the 8-bit escape (MmPaintingVersion 2)
    if (targetId === "prusa") expect(escapedOut).toBeGreaterThan(2);
  });
});
