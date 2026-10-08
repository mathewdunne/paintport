// Differential parity suite: the ORIGINAL core (extracted from public/classic/index.html and
// evaluated in an isolated node:vm context) and the TypeScript port receive identical inputs
// and must produce identical results, byte for byte. Failures print PARITY_SEED; rerun with
// the same seed to reproduce. PARITY_SCALE multiplies the number of random cases.
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadClassicCore } from "../../test/support/classic";
import { assertParity, attempt, attemptAsync, firstDiff, norm, stats } from "../../test/support/parity";
import { makeRng, PARITY_SCALE, PARITY_SEED } from "../../test/support/prng";
import {
  genColorInput, genHex, genNumberStr, genPlan, genScenario, genTree, genValidHex, genZipEntries,
  MAX_STATE, variantOf, type ModelVariant,
} from "../../test/support/synth";
import { deltaE, hexToRgb, linearToSrgb, normalizeHex, rgbToHex, rgbToLab, srgbToLinear } from "./color";
import { CORE_ERRORS } from "./errors";
import { bestMix, predictMix, topMixes } from "./mix";
import { collectStates, emitPaintTree, parsePaintTree, remapPaintString, type PaintDialect } from "./paint/codec";
import { applyTransform, composeTransform, parseTransform } from "./threemf/transform";
import { build3MF, buildPrusa3MF } from "./threemf/build";
import { load3MF, VOLUME_TYPES } from "./threemf/load";
import { parseAttrs, parseModelXML } from "./threemf/xml";
import { PAINTPORT_VERSION } from "./version";
import { crc32, unzipAll, zipAll } from "./zip";
import { PaintPortCore } from "./index";

const { core: O, internals: OI } = loadClassicCore();
const S = PARITY_SCALE;
// Larger PARITY_SCALE runs take proportionally longer.
vi.setConfig({ testTimeout: 60_000 * Math.max(1, S) });
const PROTO_SUBTYPE = /subtype="(?:constructor|toString|__proto__)"/;
const PROTO_SUBTYPE_ALL = new RegExp(PROTO_SUBTYPE.source, "g");
const DIALECTS: (PaintDialect | undefined)[] = ["prusa", "bbs", undefined];
// INTENDED DIVERGENCE (PrusaSlicer project import, phase 2.0): the port reads these archive
// members, the classic tool ignores them. PaintPort's own Prusa exports contain them.
const PRUSA_PROJECT_MEMBERS = new Set(["Metadata/Slic3r_PE.config", "Metadata/Slic3r_PE_model.config", "Metadata/Prusa_Slicer_full_spectrum.json"]);
const coverage: Record<string, number> = {};
const bump = (k: string, n = 1) => { coverage[k] = (coverage[k] ?? 0) + n; };

afterAll(() => {
  const rows = [...stats.byTest].map(([k, v]) => `  ${k.padEnd(34)} ${v}`).join("\n");
  const cov = Object.entries(coverage).map(([k, v]) => `  ${k.padEnd(34)} ${v}`).join("\n");
  console.log(`\nParity: ${stats.compared} comparisons (PARITY_SEED=${PARITY_SEED}, PARITY_SCALE=${S})\n${rows}\nCoverage of generated cases:\n${cov}`);
});

describe("api surface", () => {
  it("PaintPortCore has exactly the original keys, in order, and the version matches", () => {
    expect(Object.keys(PaintPortCore)).toEqual(Object.keys(O));
    expect(PaintPortCore.version).toBe(O.version);
    expect(PAINTPORT_VERSION).toBe(OI.PAINTPORT_VERSION);
    for (const k of Object.keys(O) as (keyof typeof O)[]) {
      expect(typeof PaintPortCore[k], k).toBe(typeof O[k]);
    }
  });

  it("does not publish itself on globalThis", () => {
    expect("PaintPortCore" in globalThis).toBe(false);
  });

  it("keeps the original error table (messages byte-identical)", () => {
    for (const [code, msg] of Object.entries(OI.CORE_ERRORS)) {
      expect((CORE_ERRORS as Record<string, string>)[code]).toBe(msg);
    }
  });

  it("VOLUME_TYPES matches", () => {
    assertParity("VOLUME_TYPES", "table", OI.VOLUME_TYPES, VOLUME_TYPES);
  });
});

describe("paint codec parity", () => {
  it("emit / parse / collect / remap agree on random trees", () => {
    const rng = makeRng(PARITY_SEED, "paint-codec");
    const N = 2500 * S;
    for (let i = 0; i < N; i++) {
      const d = rng.pick<PaintDialect>(["prusa", "bbs"]);
      const big = rng.bool(0.05); // states beyond what the dialect can encode: garbage in, same garbage out
      const tree = genTree(rng, big ? 300 : MAX_STATE[d], rng.int(0, 6));
      const info = `#${i} dialect=${d}`;

      for (const ed of DIALECTS) {
        const eo = attempt(() => O.emitPaintTree(tree, ed));
        const ep = attempt(() => emitPaintTree(tree, ed));
        assertParity("emitPaintTree", `${info} emit=${ed}`, eo, ep);
        if (!("ok" in eo)) continue;
        const str = eo.ok;
        for (const pd of DIALECTS) {
          assertParity("parsePaintTree", `${info} str=${str} parse=${pd}`, attempt(() => O.parsePaintTree(str, pd)), attempt(() => parsePaintTree(str, pd)));
          const co = new Map<number, number>(), cp = new Map<number, number>();
          const ro = attempt(() => O.collectStates(str, co, pd)), rp = attempt(() => collectStates(str, cp, pd));
          assertParity("collectStates", `${info} str=${str} parse=${pd}`, [ro, co], [rp, cp]);
        }
      }

      // a clean round trip in the matching dialect (only where the dialect can encode the states)
      if (!big) {
        const s = emitPaintTree(tree, d);
        expect(norm(parsePaintTree(s, d)), `round trip ${info}`).toEqual(norm(tree));
      }

      // remap with several state functions and every dialect pair; the call sequence must match too
      const a = rng.int(1, 5), b = rng.int(0, 9), m = rng.pick([7, 17, 40, 300]);
      const fns: Record<string, (s: number) => number> = {
        identity: (s) => s,
        affine: (s) => (s * a + b) % m,
        toZero: () => 0,
        shiftUp: (s) => s + 200,
        swap12: (s) => (s === 1 ? 2 : s === 2 ? 1 : s),
      };
      const fname = rng.pick(Object.keys(fns));
      const base = attempt(() => O.emitPaintTree(tree, d));
      if (!("ok" in base)) continue;
      for (const id of DIALECTS) for (const od of DIALECTS) {
        const callsO: number[] = [], callsP: number[] = [];
        const ro = attempt(() => O.remapPaintString(base.ok, (s) => { callsO.push(s); return fns[fname](s); }, id, od));
        const rp = attempt(() => remapPaintString(base.ok, (s) => { callsP.push(s); return fns[fname](s); }, id, od));
        assertParity("remapPaintString", `${info} str=${base.ok} fn=${fname} in=${id} out=${od}`, [ro, callsO], [rp, callsP]);
      }
    }
  });

  it("malformed strings throw the same errors", () => {
    const rng = makeRng(PARITY_SEED, "paint-malformed");
    const N = 3000 * S;
    const alphabet = "0123456789abcdefABCDEFgGxZ -_é";
    let threw = 0;
    for (let i = 0; i < N; i++) {
      let str: unknown;
      const kind = rng.int(0, 5);
      if (kind === 0) str = Array.from({ length: rng.int(0, 14) }, () => alphabet[rng.int(0, alphabet.length - 1)]).join("");
      else if (kind === 1) str = genHex(rng, rng.int(0, 10));
      else {
        const d = rng.pick<PaintDialect>(["prusa", "bbs"]);
        const valid = emitPaintTree(genTree(rng, MAX_STATE[d], 4), d);
        if (kind === 2) str = valid.slice(rng.int(0, valid.length)); // drops leading nibbles: read from the right, so usually "too short"
        else if (kind === 3) str = genHex(rng, rng.int(1, 3)) + valid; // extra leading nibbles: trailing garbage or reinterpretation
        else if (kind === 4) { const p = rng.int(0, Math.max(0, valid.length - 1)); str = valid.slice(0, p) + rng.pick(["G", "-", " ", "z"]) + valid.slice(p + 1); }
        else str = rng.pick([undefined, null, 5, {}]); // non-strings: same TypeError either way
      }
      for (const pd of DIALECTS) {
        const eo = attempt(() => O.parsePaintTree(str as string, pd));
        const ep = attempt(() => parsePaintTree(str as string, pd));
        if ("threw" in eo) threw++;
        assertParity("parsePaintTree (malformed)", `str=${JSON.stringify(str)} dialect=${pd}`, eo, ep);
        assertParity("collectStates (malformed)", `str=${JSON.stringify(str)} dialect=${pd}`,
          attempt(() => O.collectStates(str as string, new Map(), pd)), attempt(() => collectStates(str as string, new Map(), pd)));
        assertParity("remapPaintString (malformed)", `str=${JSON.stringify(str)} dialect=${pd}`,
          attempt(() => O.remapPaintString(str as string, (s) => s + 1, pd, "bbs")), attempt(() => remapPaintString(str as string, (s) => s + 1, pd, "bbs")));
      }
    }
    bump("malformed strings that threw", threw);
    expect(threw).toBeGreaterThan(N / 2);
  });

  it("every error code is reachable and matches", () => {
    const codes = new Set<string>();
    for (const s of ["", "G", "C", "CE", "0F", "1A", "48"]) {
      for (const pd of DIALECTS) {
        const eo = attempt(() => O.parsePaintTree(s, pd));
        const ep = attempt(() => parsePaintTree(s, pd));
        assertParity("paint error codes", `${s}/${pd}`, eo, ep);
        if ("threw" in ep) codes.add((ep.threw as { code: string }).code);
      }
    }
    expect([...codes].sort()).toEqual(["ERR_PAINT_CHAR", "ERR_PAINT_SHORT", "ERR_PAINT_TRAIL"]);
  });
});

describe("color and mix parity", () => {
  it("normalizeHex / hexToRgb / rgbToHex / rgbToLab / deltaE", () => {
    const rng = makeRng(PARITY_SEED, "color");
    const N = 4000 * S;
    for (let i = 0; i < N; i++) {
      const c = genColorInput(rng);
      assertParity("normalizeHex", `${JSON.stringify(c)}`, attempt(() => O.normalizeHex(c)), attempt(() => normalizeHex(c)));
      assertParity("hexToRgb", `${JSON.stringify(c)}`, attempt(() => O.hexToRgb(c as string)), attempt(() => hexToRgb(c as string)));
      const c2 = genColorInput(rng);
      assertParity("deltaE", `${JSON.stringify([c, c2])}`, attempt(() => O.deltaE(c as string, c2 as string)), attempt(() => deltaE(c as string, c2 as string)));

      const rgb = [0, 1, 2].map(() => rng.pick([rng.next(), rng.next() * 1.4 - 0.2, 0, 1, NaN, -0]));
      assertParity("rgbToHex", JSON.stringify(rgb), attempt(() => OI.rgbToHex(rgb)), attempt(() => rgbToHex(rgb)));
      const rgb01 = [0, 1, 2].map(() => rng.next());
      assertParity("rgbToLab", JSON.stringify(rgb01), attempt(() => OI.rgbToLab(rgb01)), attempt(() => rgbToLab(rgb01)));
      const v = rng.next() * 1.2 - 0.1;
      assertParity("srgbToLinear", String(v), OI.srgbToLinear(v), srgbToLinear(v));
      assertParity("linearToSrgb", String(v), OI.linearToSrgb(v), linearToSrgb(v));
    }
  });

  it("exhaustive 8-bit gray ramp and single-channel sweeps (covers both branches of the Lab/sRGB curves)", () => {
    const h2 = (v: number) => v.toString(16).padStart(2, "0");
    const refs = ["#000000", "#808080", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF"];
    for (let v = 0; v < 256; v++) {
      for (const hex of [`#${h2(v)}${h2(v)}${h2(v)}`, `#${h2(v)}0000`, `#00${h2(v)}00`, `#0000${h2(v)}`]) {
        assertParity("hexToRgb (sweep)", hex, O.hexToRgb(hex), hexToRgb(hex));
        assertParity("rgbToLab (sweep)", hex, OI.rgbToLab(O.hexToRgb(hex)), rgbToLab(hexToRgb(hex)));
        for (const r of refs) assertParity("deltaE (sweep)", `${hex} ${r}`, O.deltaE(hex, r), deltaE(hex, r));
      }
    }
    // sRGB transfer curve around its knee points, at fine resolution
    for (let i = 0; i <= 2000; i++) {
      const v = i / 2000 * 0.02;
      assertParity("srgbToLinear (knee)", String(v), OI.srgbToLinear(v), srgbToLinear(v));
      assertParity("linearToSrgb (knee)", String(v), OI.linearToSrgb(v), linearToSrgb(v));
    }
  });

  it("predictMix / topMixes / bestMix on random slot sets", () => {
    const rng = makeRng(PARITY_SEED, "mix");
    const N = 600 * S;
    for (let i = 0; i < N; i++) {
      const comps = Array.from({ length: rng.int(0, 4) }, () => ({
        color: (rng.bool(0.8) ? genValidHex(rng) : genColorInput(rng)) as string,
        ratio: rng.pick([1, 2, 3, 0, 0.5, rng.int(1, 9), -1]),
      }));
      assertParity("predictMix", JSON.stringify(comps), attempt(() => O.predictMix(comps)), attempt(() => predictMix(comps)));

      const nSlots = rng.int(0, 7);
      // slot numbers are not necessarily 1..n; colors may repeat so de-duplication by predicted color gets exercised
      const palette = Array.from({ length: rng.int(1, 4) }, () => genValidHex(rng));
      const slots = Array.from({ length: nSlots }, (_, k) => ({ slot: rng.bool(0.8) ? k + 1 : rng.int(1, 20), color: rng.bool(0.3) ? rng.pick(palette) : genValidHex(rng) }));
      const target = (rng.bool(0.9) ? genValidHex(rng) : genColorInput(rng)) as string;
      const n = rng.pick([undefined, 1, 2, 3, 6, 10, 0, 100]);
      assertParity("topMixes", JSON.stringify({ target, slots, n }), attempt(() => O.topMixes(target, slots, n)), attempt(() => topMixes(target, slots, n)));
      assertParity("bestMix", JSON.stringify({ target, slots }), attempt(() => O.bestMix(target, slots)), attempt(() => bestMix(target, slots)));
    }
  });
});

describe("transform parity", () => {
  it("parseTransform / applyTransform / composeTransform", () => {
    const rng = makeRng(PARITY_SEED, "transform");
    const N = 2500 * S;
    const num = () => rng.pick([genNumberStr(rng), genNumberStr(rng), "0", "1", "abc", "NaN", "Infinity", "1e999"]);
    const matrix = (): number[] => Array.from({ length: 12 }, () => rng.pick([0, 1, -1, rng.next() * 20 - 10, Math.round(rng.next() * 100) / 10]));
    for (let i = 0; i < N; i++) {
      const count = rng.pick([12, 12, 12, 11, 13, 0, 1]);
      const sep = () => rng.pick([" ", "  ", "\t", "\n", " \r\n "]);
      let s: string | null | undefined = Array.from({ length: count }, num).join(sep());
      if (rng.bool(0.3)) s = sep() + s + sep();
      if (rng.bool(0.05)) s = rng.pick([null, undefined, "", "   "]);
      assertParity("parseTransform", JSON.stringify(s), attempt(() => O.parseTransform(s)), attempt(() => parseTransform(s)));

      const t = rng.pick([null, undefined, matrix(), matrix(), O.parseTransform(s)]) as number[] | null | undefined;
      const [x, y, z] = [rng.next() * 100 - 50, rng.int(-5, 5), rng.pick([0, rng.next(), NaN, -0])];
      assertParity("applyTransform", JSON.stringify({ t, x, y, z }), attempt(() => O.applyTransform(t, x, y, z)), attempt(() => applyTransform(t, x, y, z)));

      const a = rng.pick([null, matrix()]), b = rng.pick([null, matrix()]);
      assertParity("composeTransform", JSON.stringify({ a, b }), attempt(() => OI.composeTransform(a, b)), attempt(() => composeTransform(a, b)));
    }
  });
});

describe("zip parity", () => {
  it("zipAll output is byte-identical and both readers agree", async () => {
    const rng = makeRng(PARITY_SEED, "zip");
    const N = 50 * S;
    let stored = 0, deflated = 0;
    for (let i = 0; i < N; i++) {
      const entries = genZipEntries(rng);
      const zo = await O.zipAll(entries);
      const zp = await zipAll(entries);
      assertParity("zipAll", `#${i} (${entries.length} entries)`, zo, zp);
      // Rough method statistics: how many entries were stored vs deflated
      const dv = new DataView(zo.buffer, zo.byteOffset, zo.byteLength);
      for (let off = 0; off < zo.length - 4; off++) {
        if (dv.getUint32(off, true) === 0x02014b50) { if (dv.getUint16(off + 10, true) === 0) stored++; else deflated++; }
      }

      assertParity("unzipAll", `#${i}`, await attemptAsync(() => O.unzipAll(zo)), await attemptAsync(() => unzipAll(zo)));
      // cross-feed: each reader on the other writer's bytes (identical here, but proves no hidden state)
      assertParity("unzipAll(cross)", `#${i}`, await attemptAsync(() => unzipAll(zo)), await attemptAsync(() => O.unzipAll(zp)));

      // sub-array with a non-zero byteOffset, and trailing bytes after the EOCD
      const pad = rng.int(1, 9);
      const shifted = new Uint8Array(pad + zo.length + rng.int(0, 30)).fill(0x41);
      shifted.set(zo, pad);
      const view = shifted.subarray(pad);
      assertParity("unzipAll(offset+trailer)", `#${i}`, await attemptAsync(() => O.unzipAll(view)), await attemptAsync(() => unzipAll(view)));

      // corrupted archives: same error or same (garbage) result
      if (zo.length > 30) {
        const bad = zo.slice();
        const flips = rng.int(1, 3);
        for (let f = 0; f < flips; f++) bad[rng.int(Math.max(0, bad.length - 120), bad.length - 1)] ^= 1 << rng.int(0, 7);
        assertParity("unzipAll(corrupt tail)", `#${i}`, await attemptAsync(() => O.unzipAll(bad)), await attemptAsync(() => unzipAll(bad)));
        const bad2 = zo.slice();
        bad2[rng.int(0, bad2.length - 1)] ^= 1 << rng.int(0, 7);
        assertParity("unzipAll(corrupt anywhere)", `#${i}`, await attemptAsync(() => O.unzipAll(bad2)), await attemptAsync(() => unzipAll(bad2)));
      }

      const crcInput = rng.bytes(rng.int(0, 500), rng.bool());
      assertParity("crc32", `#${i}`, OI.crc32(crcInput), crc32(crcInput));
    }
    for (let i = 0; i < 20 * S; i++) {
      const junk = rng.bytes(rng.int(0, 120));
      assertParity("unzipAll(random bytes)", `#${i}`, await attemptAsync(() => O.unzipAll(junk)), await attemptAsync(() => unzipAll(junk)));
    }
    const empty = await attemptAsync(() => unzipAll(new Uint8Array(0)));
    expect("threw" in empty && (empty.threw as { code: string }).code).toBe("ERR_NO_EOCD");
    assertParity("zipAll", "no entries", await O.zipAll([]), await zipAll([]));
    bump("zip entries stored", stored);
    bump("zip entries deflated", deflated);
    expect(stored).toBeGreaterThan(0);
    expect(deflated).toBeGreaterThan(0);
  }, 120_000);
});

describe("XML parser parity", () => {
  it("parseAttrs / parseModelXML on generated model files", async () => {
    const rng = makeRng(PARITY_SEED, "xml");
    const N = 120 * S;
    for (let i = 0; i < N; i++) {
      const sc = genScenario(rng, O);
      for (const f of sc.files) {
        if (!f.name.endsWith(".model")) continue;
        const xml = new TextDecoder().decode(f.data);
        assertParity("parseModelXML", `#${i} ${sc.label} ${f.name}`, attempt(() => OI.parseModelXML(xml)), attempt(() => parseModelXML(xml)));
        const tag = xml.slice(0, rng.int(0, 400));
        assertParity("parseAttrs", `#${i}`, attempt(() => OI.parseAttrs(tag)), attempt(() => parseAttrs(tag)));
      }
    }
  });
});

describe("3MF load/build parity", () => {
  it("load3MF and build3MF agree on synthetic archives for every target", async () => {
    const rng = makeRng(PARITY_SEED, "threemf");
    const N = 250 * S;
    const variants: ModelVariant[] = ["same", "same", "same", "noParts", "partsUndefined", "unprintable", "noDialect", "noIdentity", "identity"];
    let loadErr = 0;
    for (let i = 0; i < N; i++) {
      const sc = genScenario(rng, O);
      const bytes = await O.zipAll(sc.files);
      // INTENDED DIVERGENCE (volume-types fix): for a part subtype that is a prototype key
      // ("constructor", "toString", "__proto__") the original yields a non-string volume type,
      // the port treats it like any unknown subtype (ModelPart). To keep everything else under
      // strict equality, the original is fed an archive in which those subtypes are replaced by
      // an unknown one ("mystery"), which the original already maps to ModelPart. The raw
      // archive is additionally checked below.
      const settingsFile = sc.files.find((f) => f.name === "Metadata/model_settings.config");
      const settingsText = settingsFile ? new TextDecoder().decode(settingsFile.data) : "";
      const hasProto = PROTO_SUBTYPE.test(settingsText);
      const classicBytes = hasProto
        ? await O.zipAll(sc.files.map((f) => (f === settingsFile
          ? { name: f.name, data: new TextEncoder().encode(settingsText.replace(PROTO_SUBTYPE_ALL, 'subtype="mystery"')) }
          : f)))
        : bytes;
      const lo = await attemptAsync(() => O.load3MF(classicBytes));
      const lp = await attemptAsync(() => load3MF(bytes));
      assertParity("load3MF", `#${i} ${sc.label}${hasProto ? " (proto subtype normalized for classic)" : ""}`, lo, lp);
      if ("ok" in lp) {
        const types = new Set(Object.values(VOLUME_TYPES));
        for (const o of lp.ok.objects) for (const part of o.parts) expect(types.has(part.type), `part type ${String(part.type)}`).toBe(true);
      }
      if (hasProto) {
        bump("archives with prototype-key subtypes");
        const raw = await attemptAsync(() => O.load3MF(bytes));
        // The raw original may differ from its normalized self only through the leak: either
        // the model carries a non-string part type, or (leaked parts skip the statistics pass)
        // a different paint string is the first to fail.
        if (firstDiff(norm(raw), norm(lo)) === null) {
          bump("... of which unaffected");
        } else {
          const leaks = "ok" in raw && raw.ok.objects.some((o) => o.parts.some((part) => typeof part.type !== "string"));
          const code = (r: typeof raw) => ("threw" in r ? (r.threw as { code?: string }).code ?? "" : "");
          const paintErrors = "threw" in raw && "threw" in lo && code(raw).startsWith("ERR_PAINT_") && code(lo).startsWith("ERR_PAINT_");
          expect(leaks || paintErrors, `#${i} ${sc.label}: unexplained divergence`).toBe(true);
          bump(leaks ? "... of which the original leaks a non-string type" : "... of which a leaked part hides an earlier paint error");
        }
      }
      if (!("ok" in lo) || !("ok" in lp)) {
        loadErr++;
        const code = (("threw" in lo ? lo.threw : null) as { code?: string } | null)?.code ?? "other";
        bump(`load error: ${code}`);
        continue;
      }
      const m = lo.ok;
      bump("models loaded");
      if (m.specialVolumes) bump("models with special volumes");
      if (m.paintDialect === "prusa") bump("models: prusa dialect"); else bump("models: bbs dialect");
      if (m.usedExtruders.some((s) => s > 16)) bump("models with states > 16");
      if (m.objects.some((o) => o.parts.some((p) => p.type !== "ModelPart"))) bump("models with non-ModelPart ranges");
      if (m.objects.length > 1) bump("models with several objects");
      if (m.sourceIdentity) bump("models with sourceIdentity");
      if (m.objects.some((o) => o.printable === false)) bump("models with unprintable items");
      if (m.objects.some((o) => o.transform)) bump("models with item transform");

      for (let j = 0; j < 6; j++) {
        const spec = genPlan(rng, m);
        const variant = rng.pick(variants);
        const info = `#${i} ${sc.label} plan[${spec.label}] variant=${variant}`;
        const eo = attempt(() => O.build3MF(variantOf(m, variant), spec.make()));
        const ep = attempt(() => build3MF(variantOf(lp.ok, variant), spec.make()));
        assertParity("build3MF", info, eo, ep);
        if ("ok" in eo) {
          bump("builds ok");
          bump(`builds ok: ${spec.label.split(" ")[0]}`);
          if (eo.ok.mmVersion === 2) bump("builds with MmPaintingVersion 2");
          if (eo.ok.entries.some((e) => e.name.includes("full_spectrum"))) bump("builds with full_spectrum.json");
          const ps = eo.ok.entries.find((e) => e.name === "Metadata/project_settings.config");
          if (ps && new TextDecoder().decode(ps.data).includes("mixed_filament_definitions")) bump("builds with snapmaker mix definitions");
          if (ps && new TextDecoder().decode(ps.data).includes("filament_is_mixed")) bump("builds with bambu mix arrays");
          if (new TextDecoder().decode(eo.ok.entries[2].data).includes("<components>")) bump("builds with composite objects");

          // archive level, and a re-import of the export through both loaders
          if (j === 0 && i % 3 === 0) {
            const zo = await O.zipAll(eo.ok.entries);
            assertParity("zipAll(build output)", info, zo, await zipAll((ep as { ok: typeof eo.ok }).ok.entries));
            // To keep everything else under strict equality, the port re-imports the archive
            // without those members, and the classic tool is shown to ignore them (it loads
            // the full and the stripped archive identically). The extension itself is covered
            // by src/core/threemf/prusaProject.test.ts, including the round trip of these
            // exports. The full archive must still load.
            const hasPrusaMeta = eo.ok.entries.some((e) => PRUSA_PROJECT_MEMBERS.has(e.name));
            let zpIn = zo;
            if (hasPrusaMeta) {
              zpIn = await zipAll(eo.ok.entries.filter((e) => !PRUSA_PROJECT_MEMBERS.has(e.name)));
              assertParity("load3MF(re-import): classic ignores Prusa project members", info, await attemptAsync(() => O.load3MF(zo)), await attemptAsync(() => O.load3MF(zpIn)));
              const classicFull = await attemptAsync(() => O.load3MF(zo));
              if ("ok" in classicFull) expect("ok" in (await attemptAsync(() => load3MF(zo))), `${info}: re-import with Prusa project members`).toBe(true);
              bump("re-imported exports with Prusa project members");
            }
            assertParity("load3MF(re-import)", info, await attemptAsync(() => O.load3MF(zo)), await attemptAsync(() => load3MF(zpIn)));
            bump("re-imported exports");
          }
        } else {
          const code = (eo.threw as { code?: string }).code ?? (eo.threw as Error).name;
          bump(`build error: ${code}`);
        }
        // legacy alias; a bambu target in the plan must be overridden to prusa
        if (j === 1) {
          const p1 = spec.make(), p2 = spec.make();
          assertParity("buildPrusa3MF", info, attempt(() => O.buildPrusa3MF(m, p1)), attempt(() => buildPrusa3MF(lp.ok, p2)));
        }
      }
    }
    bump("archives that failed to load", loadErr);
    // sanity: the generator must keep exercising the interesting paths
    const need = (k: string, min: number) => expect(coverage[k] ?? 0, k).toBeGreaterThanOrEqual(min);
    need("models loaded", N * 0.6);
    need("builds ok", N);
    need("models with special volumes", N / 20);
    need("models with states > 16", N / 40);
    need("builds with composite objects", N / 40);
    need("builds with snapmaker mix definitions", N / 40);
    need("builds with bambu mix arrays", N / 40);
    need("builds with full_spectrum.json", N / 20);
    need("builds with MmPaintingVersion 2", 1);
    need("re-imported exports with Prusa project members", 1);
    need("build error: ERR_BBS_NO_MIX", 1);
    need("archives with prototype-key subtypes", 5);
    need("... of which the original leaks a non-string type", 1);
  }, 600_000);

  it("deterministic error paths throw the same codes", async () => {
    const te = new TextEncoder();
    const wrap = (unit: string, body: string, build: string) =>
      `<model ${unit} xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="x"><resources>${body}</resources><build>${build}</build></model>`;
    const tri = '<object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>';
    const cases: [string, [string, string][], string][] = [
      ["missing model", [["Metadata/x.config", "<a/>"]], "ERR_NO_MODEL"],
      ["empty model file", [["3D/3dmodel.model", ""]], "ERR_NO_MODEL"],
      ["inch", [["3D/3dmodel.model", wrap('unit="inch"', tri, '<item objectid="1"/>')]], "ERR_UNIT"],
      ["micron", [["3D/3dmodel.model", wrap('unit="micron"', tri, '<item objectid="1"/>')]], "ERR_UNIT"],
      ["missing external", [["3D/3dmodel.model", wrap('unit="millimeter"', '<object id="1" type="model"><components><component p:path="/3D/Objects/o.model" objectid="1"/></components></object>', '<item objectid="1"/>')]], "ERR_MISSING_REF"],
      ["no build items", [["3D/3dmodel.model", wrap('unit="millimeter"', tri, "")]], "ERR_NO_OBJECTS"],
      ["item to missing object", [["3D/3dmodel.model", wrap('unit="millimeter"', tri, '<item objectid="7"/>')]], "ERR_NO_OBJECTS"],
      ["assembly without resolvable parts", [["3D/3dmodel.model", wrap('unit="millimeter"', '<object id="1" type="model"><components><component objectid="9"/></components></object>', '<item objectid="1"/>')]], "ERR_NO_OBJECTS"],
      ["bad paint string", [["3D/3dmodel.model", wrap('unit="millimeter"', tri.replace('v3="2"', 'v3="2" paint_color="ZZ"'), '<item objectid="1"/>')]], "ERR_PAINT_CHAR"],
      ["short paint string", [["3D/3dmodel.model", wrap('unit="millimeter"', tri.replace('v3="2"', 'v3="2" paint_color="C"'), '<item objectid="1"/>')]], "ERR_PAINT_SHORT"],
      ["trailing paint nibbles", [["3D/3dmodel.model", wrap('unit="millimeter"', tri.replace('v3="2"', 'v3="2" paint_color="48"'), '<item objectid="1"/>')]], "ERR_PAINT_TRAIL"],
    ];
    for (const [name, files, code] of cases) {
      const bytes = await O.zipAll(files.map(([n, d]) => ({ name: n, data: te.encode(d) })));
      const eo = await attemptAsync(() => O.load3MF(bytes));
      const ep = await attemptAsync(() => load3MF(bytes));
      assertParity("load3MF error paths", name, eo, ep);
      expect("threw" in ep && (ep.threw as { code: string }).code, name).toBe(code);
    }
    // not a zip at all
    assertParity("load3MF error paths", "not a zip", await attemptAsync(() => O.load3MF(te.encode("hello"))), await attemptAsync(() => load3MF(te.encode("hello"))));
  });
});
