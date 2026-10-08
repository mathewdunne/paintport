// Core regressions on synthetic in-memory 3MFs. Ported from test/test_regression.mjs (the
// sections that exercise the core; its static HTML/UI checks only apply to classic and keep
// running via `npm run test:classic`) and from the bbs assertions of test/test_paintport.mjs,
// here run against a synthetic model instead of a real fixture.
import { describe, expect, it } from "vitest";
import {
  bestMix, build3MF, buildPrusa3MF, collectStates, emitPaintTree, load3MF, topMixes, unzipAll, zipAll,
  type Build3MFPlan, type Model, type PaintDialect, type VirtualExtruder,
} from "./index";

const enc = new TextEncoder(), dec = new TextDecoder();

/** tris: one paint attribute string per triangle, all on the same 3 vertices. */
const xml = ({ tris = ['paint_color="4"'], unit = 'unit="millimeter"', printable = "1", name = "reg" } = {}) =>
  `<?xml version="1.0"?><model ${unit} xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"><resources><object id="1" type="model" name="${name}"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles>${tris.map((p) => `<triangle v1="0" v2="1" v3="2" ${p}/>`).join("")}</triangles></mesh></object></resources><build><item objectid="1" printable="${printable}"/></build></model>`;
const COLORS = { name: "Metadata/project_settings.config", data: enc.encode(JSON.stringify({ filament_colour: ["#FF0000", "#00FF00"] })) };
const load = async (opts: Parameters<typeof xml>[0] = {}, extra = [COLORS]) =>
  load3MF(await zipAll([{ name: "3D/3dmodel.model", data: enc.encode(xml(opts)) }, ...extra]));
const entry = (built: { entries: { name: string; data: Uint8Array }[] }, name: string) => {
  const e = built.entries.find((x) => x.name === name);
  return e ? dec.decode(e.data) : undefined;
};
const modelXml = (built: { entries: { name: string; data: Uint8Array }[] }) => entry(built, "3D/3dmodel.model") as string;
const plan = (target: "prusa" | "bambu", stateMap: [number, number][], virtuals: VirtualExtruder[] = []): Build3MFPlan => ({
  target, stateMap: new Map(stateMap), virtuals,
  physical: [{ slot: 1, color: "#FF0000" }, { slot: 2, color: "#00FF00" }],
  title: "reg", date: "2026-01-01",
  ...(target === "bambu" ? { bbsApp: "BambuStudio-02.07.01.62", mixFormat: "bambu" as const } : {}),
});

describe("1) Prusa import (mmu_segmentation)", () => {
  it("loads a file with mmu_segmentation attributes (v0.8.3 threw a ReferenceError on sawMmuSeg)", async () => {
    const m = await load({ tris: ['slic3rpe:mmu_segmentation="4"', 'slic3rpe:mmu_segmentation="8"'] });
    expect(m.paintDialect).toBe("prusa");
    expect(m.usedExtruders).toEqual([1, 2]);
  });
  it("keeps the bbs dialect for paint_color sources", async () => {
    expect((await load()).paintDialect).toBe("bbs");
  });
});

describe("2) Export -> re-import (Prusa target, including state >= 17)", () => {
  it("maps filament 2 to virtual extruder 20, above the 16 boundary where the dialects split", async () => {
    const src = await load({ tris: ['paint_color="4"', 'paint_color="8"'] });
    const built = build3MF(src, plan("prusa", [[1, 1], [2, 20]],
      [{ id: 20, color: "#808000", components: [{ extruder: 1, ratio: 1 }, { extruder: 2, ratio: 1 }] }]));
    expect(modelXml(built)).toContain("mmu_segmentation");
    const re = await load3MF(await zipAll(built.entries));
    expect(re.paintDialect).toBe("prusa");
    expect(re.usedExtruders).toEqual([1, 20]);
    expect(built.mmVersion).toBe(2);
  });
});

describe("3) Units", () => {
  it("rejects inch with ERR_UNIT instead of silently rescaling", async () => {
    await expect(load({ unit: 'unit="inch"' })).rejects.toMatchObject({ code: "ERR_UNIT", detail: "inch" });
  });
  it("treats a missing unit attribute as millimeter (3MF default)", async () => {
    await expect(load({ unit: "" })).resolves.toBeDefined();
  });
});

describe("4) printable is preserved", () => {
  it.each(["prusa", "bambu"] as const)("%s target passes printable through", async (target) => {
    const off = await load({ printable: "0" });
    expect(modelXml(build3MF(off, plan(target, [[1, 1]])))).toMatch(/<item\b[^>]*printable="0"/);
    const on = await load();
    expect(modelXml(build3MF(on, plan(target, [[1, 1]])))).toMatch(/<item\b[^>]*printable="1"/);
  });
});

describe("5) statistics shares (audit: used to exceed 100 %)", () => {
  it("reports shares in triangle equivalents and keeps paintedTris as a leaf count", async () => {
    const split = emitPaintTree({ splitSides: 1, special: 0, children: [{ state: 1 }, { state: 2 }] }, "bbs");
    const m = await load({ tris: [`paint_color="${split}"`, "", 'paint_color="4"'] });
    const f1 = m.filaments[0], f2 = m.filaments[1];
    expect(m.totalTris).toBe(3);
    expect(f1.paintedShare).toBeCloseTo(1.5, 9);
    expect(f2.paintedShare).toBeCloseTo(0.5, 9);
    const sum = m.filaments.reduce((a, f) => a + f.paintedShare + f.baseShare, 0);
    expect(sum).toBeCloseTo(m.totalTris, 9);
    expect(f1.paintedTris).toBe(2);
  });
});

describe("6) hardening against file content", () => {
  it("neutralizes non-hex filament colors and escapes names on export", async () => {
    const inj = "<img src=x onerror=alert(1)>";
    const ms = { name: "Metadata/model_settings.config", data: enc.encode(`<config><object id="1"><metadata key="name" value="${inj}"/></object></config>`) };
    const ps = { name: "Metadata/project_settings.config", data: enc.encode(JSON.stringify({ filament_colour: ['"><b>x', "#12ab34"] })) };
    const m = await load({}, [ms, ps]);
    expect(m.filaments[0].color).toMatch(/^#[0-9A-F]{6}$/);
    expect(m.filaments[1].color).toBe("#12AB34");
    // The core passes names through raw; export escapes them and the UI must too (React text nodes).
    expect(m.objects[0].name).toBe(inj);
    expect(modelXml(build3MF(m, plan("prusa", [[1, 1]])))).not.toContain("<img");
  });
});

describe("error codes", () => {
  it("throws typed errors with a stable code and optional detail", async () => {
    const err = await load({ unit: 'unit="inch"' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ERR_UNIT");
    expect(err.detail).toBe("inch");
    expect(err.message).toBe("Unsupported model unit (only millimeter is supported): inch");
    await expect(load3MF(await zipAll([{ name: "x.txt", data: enc.encode("x") }]))).rejects.toMatchObject({ code: "ERR_NO_MODEL" });
    await expect(unzipAll(enc.encode("not a zip"))).rejects.toMatchObject({ code: "ERR_NO_EOCD" });
  });
});

describe("paint codec", () => {
  it("round-trips bbs states beyond 16 with the unary F extension and prusa states with the 8-bit escape", () => {
    const cases: [PaintDialect, number, string][] = [["bbs", 17, "EC"], ["bbs", 18, "0FC"], ["bbs", 31, "DFC"], ["prusa", 17, "00EC"], ["prusa", 272, "FFEC"]];
    for (const [d, state, str] of cases) {
      expect(emitPaintTree({ state }, d)).toBe(str);
      const counter = new Map<number, number>();
      collectStates(str, counter, d);
      expect([...counter]).toEqual([[state, 1]]);
    }
  });
});

describe("topMixes / bestMix (from test_paintport.mjs)", () => {
  const slots5 = [{ slot: 1, color: "#FFFFFF" }, { slot: 2, color: "#000000" }, { slot: 3, color: "#00FFFF" }, { slot: 4, color: "#FF00FF" }, { slot: 5, color: "#FFFF00" }];
  it("returns sorted, de-duplicated candidates and bestMix is the first one", () => {
    const tm = topMixes("#0000FF", slots5, 6);
    expect(tm).toHaveLength(6);
    expect(tm.every((m, i, a) => !i || a[i - 1].deltaE <= m.deltaE)).toBe(true);
    expect(new Set(tm.map((m) => m.predicted)).size).toBe(tm.length);
    expect(bestMix("#0000FF", slots5)).toEqual(tm[0]);
  });
  it("returns null without slots", () => {
    expect(bestMix("#123456", [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// bbs export assertions (test_paintport.mjs, "Stufe 1"), on a synthetic model with a
// painted flat object and a composite object that has a negative part.
// ---------------------------------------------------------------------------------------
async function syntheticBambuModel(): Promise<Model> {
  const verts = '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="1" y="1" z="1"/></vertices>';
  const tri = (p = "") => `<triangle v1="0" v2="1" v3="2"${p ? ` paint_color="${p}"` : ""}/>`;
  const split = emitPaintTree({ splitSides: 1, special: 0, children: [{ state: 1 }, { state: 3 }] }, "bbs");
  const main = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
    <object id="1" type="model" name="Figure"><mesh>${verts}<triangles>${tri("4")}${tri("8")}${tri(split)}${tri()}</triangles></mesh></object>
    <object id="11" type="model"><mesh>${verts}<triangles>${tri(emitPaintTree({ state: 3 }, "bbs"))}${tri()}</triangles></mesh></object>
    <object id="12" type="model"><mesh>${verts}<triangles>${tri()}</triangles></mesh></object>
    <object id="10" type="model"><components><component objectid="11"/><component objectid="12"/></components></object>
  </resources><build><item objectid="1"/><item objectid="10"/></build></model>`;
  const settings = `<config>
    <object id="1"><metadata key="name" value="Figure"/><metadata key="extruder" value="1"/></object>
    <object id="10"><metadata key="name" value="Assembly"/><metadata key="extruder" value="2"/>
      <part id="11" subtype="normal_part"><metadata key="name" value="Body"/></part>
      <part id="12" subtype="negative_part"><metadata key="name" value="Hole"/></part>
    </object></config>`;
  const colors = { name: "Metadata/project_settings.config", data: enc.encode(JSON.stringify({ filament_colour: ["#FF0000", "#00FF00", "#0000FF"] })) };
  return load3MF(await zipAll([
    { name: "3D/3dmodel.model", data: enc.encode(main) },
    { name: "Metadata/model_settings.config", data: enc.encode(settings) },
    colors,
  ]));
}

describe("bbs export assertions", () => {
  const PRINTER = 8;
  const virtuals: VirtualExtruder[] = [
    { id: PRINTER + 1, color: "#888888", components: [{ extruder: 1, ratio: 1 }, { extruder: 2, ratio: 1 }] },
    { id: PRINTER + 2, color: "#777777", components: [{ extruder: 1, ratio: 1 }, { extruder: 2, ratio: 1 }, { extruder: 3, ratio: 1 }] },
  ];
  const physical = Array.from({ length: PRINTER }, (_, i) => ({ slot: i + 1, color: ["#FF0000", "#00FF00", "#0000FF"][i] ?? "#808080" }));
  const virtualPlan = (m: Model, mixFormat: "snapmaker" | "bambu", extra: Partial<Build3MFPlan> = {}): Build3MFPlan => ({
    target: "bambu", mixFormat, physical, virtuals,
    stateMap: new Map([[1, 1], [2, 2], [m.filaments.length, PRINTER + 1]]),
    title: "PaintPort Test", date: "2026-07-05", ...extra,
  });

  it("loads the synthetic model as expected", async () => {
    const m = await syntheticBambuModel();
    expect(m.paintDialect).toBe("bbs");
    expect(m.filaments).toHaveLength(3);
    expect(m.specialVolumes).toBe(1);
    expect(m.objects).toHaveLength(2);
    expect(m.objects[1].parts.map((p) => p.type)).toEqual(["ModelPart", "NegativeVolume"]);
  });

  it.each(["snapmaker", "bambu"] as const)("%s: file set, header, paint-all, config and round trip", async (mix) => {
    const model = await syntheticBambuModel();
    const p = virtualPlan(model, mix);
    const built = build3MF(model, p);
    const names = built.entries.map((e) => e.name);
    expect(names).toContain("Metadata/model_settings.config");
    expect(names).not.toContain("Metadata/Slic3r_PE_model.config");
    expect(names.some((n) => n.includes("full_spectrum"))).toBe(false);
    expect(names).toContain("Metadata/project_settings.config");

    const ps = JSON.parse(entry(built, "Metadata/project_settings.config") as string);
    const wantColors = physical.map((s) => s.color).concat(mix === "bambu" ? virtuals.map((v) => v.color) : []);
    expect(ps.filament_colour).toEqual(wantColors);
    expect(typeof ps.version).toBe("string");
    expect(ps.version.startsWith("BambuStudio")).toBe(false);
    const okKeys = new Set(["version", "from", "filament_colour", "mixed_filament_definitions", "filament_is_mixed",
      "filament_mixed_components", "filament_mixed_sublayer_ratios", "filament_mixed_gradient", "filament_mixed_gradient_curve",
      "filament_mixed_gradient_per_part", "filament_mixed_gradient_range", "printer_settings_id", "printer_model", "printer_variant",
      "nozzle_diameter", "print_settings_id", "filament_settings_id", "filament_type"]);
    expect(Object.keys(ps).filter((k) => !okKeys.has(k))).toEqual([]);
    if (mix === "snapmaker") {
      // MixedFilament.cpp v2.3.5: two components -> m2 + percent, three -> g/w + m0, cm0
      expect(ps.mixed_filament_definitions).toBe(
        "1,2,1,1,50,0,g,w,m2,z0,xa0,xb0,d0,o0,u1,cm0;1,2,1,1,50,0,g1/2/3,w1/1/1,m0,z0,xa0,xb0,d0,o0,u2,cm0");
    } else {
      const pad0 = Array(PRINTER).fill("0"), padE = Array(PRINTER).fill("");
      expect(ps.filament_is_mixed).toEqual([...pad0, "1", "1"]);
      expect(ps.filament_mixed_components).toEqual([...padE, "1,2", "1,2,3"]);
      expect(ps.filament_mixed_sublayer_ratios).toEqual([...padE, "0.5000,0.5000", "0.3333,0.3333,0.3334"]);
      expect(ps.filament_mixed_gradient).toEqual([...pad0, "0", "0"]);
      expect(ps.filament_mixed_gradient_per_part).toEqual([...pad0, "0", "0"]);
      expect(ps.filament_mixed_gradient_curve).toEqual([...padE, "", ""]);
      expect(ps.filament_mixed_gradient_range).toEqual([...padE, "", ""]);
      expect("enable_mixed_color_sublayer" in ps).toBe(false);
    }

    // Header: BambuStudio marker, no Prusa namespace, no MmPaintingVersion (an import error when > 0)
    const x = modelXml(built);
    expect(x).toContain('xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"');
    expect(x).toMatch(/<metadata name="Application">BambuStudio-/);
    expect(x).toContain('<metadata name="BambuStudio:3mfVersion">1</metadata>');
    expect(x).toContain("PaintPort");
    expect(x).not.toContain("xmlns:slic3rpe");
    expect(x).not.toContain("slic3rpe:Version3mf");
    expect(x).not.toContain("MmPaintingVersion");
    expect(x).not.toContain("mmu_segmentation");

    // Paint-all: every ModelPart triangle carries paint_color; the leaf statistics match the remap
    const expLeaf = new Map<number, number>();
    const bumpLeaf = (s: number, c: number) => expLeaf.set(s, (expLeaf.get(s) || 0) + c);
    let expModelPartTris = 0;
    for (const o of model.objects) {
      for (const part of o.parts) {
        if (part.type !== "ModelPart") continue;
        expModelPartTris += part.triCount;
        for (let i = part.firstTri; i < part.firstTri + part.triCount; i++) {
          const paint = o.paints[i];
          if (paint) {
            const cnt = new Map<number, number>();
            collectStates(paint, cnt, model.paintDialect);
            for (const [s, c] of cnt) if (s !== 0) bumpLeaf(p.stateMap.get(s) ?? s, c);
          } else bumpLeaf(p.stateMap.get(part.extruder) ?? part.extruder, 1);
        }
      }
    }
    const gotLeaf = new Map<number, number>();
    for (const mm of x.matchAll(/paint_color="([0-9A-F]+)"/g)) collectStates(mm[1], gotLeaf, "bbs");
    gotLeaf.delete(0);
    expect((x.match(/paint_color="/g) || []).length).toBe(expModelPartTris);
    expect([...gotLeaf].sort((a, b) => a[0] - b[0])).toEqual([...expLeaf].sort((a, b) => a[0] - b[0]));

    // Config: bbs subtypes only, component parts (no dead range parts), mesh_stat, ids match model objects
    const cfg = entry(built, "Metadata/model_settings.config") as string;
    expect(cfg).toContain('subtype="normal_part"');
    expect(cfg).toContain('subtype="negative_part"');
    expect(cfg).not.toMatch(/ModelPart|NegativeVolume|ParameterModifier|SupportBlocker|SupportEnforcer/);
    expect(cfg).not.toContain('firstid="');
    expect(cfg).toContain("<mesh_stat ");
    expect(cfg).toContain('key="extruder"');
    const objIds = new Set([...x.matchAll(/<object id="(\d+)"/g)].map((mm) => mm[1]));
    const partIds = [...cfg.matchAll(/<part id="(\d+)"/g)].map((mm) => mm[1]);
    expect(partIds.length).toBeGreaterThan(0);
    expect(partIds.every((id) => objIds.has(id))).toBe(true);
    expect(x).toContain("<components>");
    expect(x).toContain("<component objectid=");

    // Re-import of PaintPort's own bbs export
    const re = await load3MF(await zipAll(built.entries));
    expect(re.totalTris).toBe(model.totalTris);
    expect(re.specialVolumes).toBe(model.specialVolumes);
    for (const [s] of expLeaf) expect(re.filaments.find((f) => f.index === s)?.paintedTris, `state ${s}`).toBeGreaterThan(0);
  });

  it("bbsApp override drives both the Application metadata and the version key", async () => {
    const model = await syntheticBambuModel();
    const built = build3MF(model, virtualPlan(model, "bambu", { virtuals: [], bbsApp: "BambuStudio-02.07.01.62" }));
    expect(modelXml(built)).toContain('<metadata name="Application">BambuStudio-02.07.01.62</metadata>');
    expect(JSON.parse(entry(built, "Metadata/project_settings.config") as string).version).toBe("02.07.01.62");
  });

  it("virtual extruders without a bbs mixFormat throw ERR_BBS_NO_MIX", async () => {
    const model = await syntheticBambuModel();
    const { mixFormat: _drop, ...noFormat } = virtualPlan(model, "bambu");
    void _drop;
    expect(() => build3MF(model, noFormat)).toThrowError(expect.objectContaining({ code: "ERR_BBS_NO_MIX" }));
  });

  it("Bambu Studio is capped at 16 filaments (physical + blends)", async () => {
    const model = await syntheticBambuModel();
    const p = virtualPlan(model, "bambu");
    const phys16 = Array.from({ length: 15 }, (_, i) => ({ slot: i + 1, color: "#808080" }));
    expect(() => build3MF(model, { ...p, physical: phys16, virtuals: virtuals.map((v, k) => ({ ...v, id: 16 + k })) }))
      .toThrowError(expect.objectContaining({ code: "ERR_BBS_MAX16" }));
  });

  it("blend ids must follow the physical slots without gaps", async () => {
    const model = await syntheticBambuModel();
    const gap = virtuals.map((v, k) => ({ ...v, id: PRINTER + 2 + k }));
    expect(() => build3MF(model, virtualPlan(model, "bambu", { virtuals: gap }))).toThrowError(/Mix-ID-Lücke/);
    expect(() => build3MF(model, virtualPlan(model, "snapmaker", { virtuals: gap }))).toThrowError(/Mix-ID-Lücke/);
  });

  it("Prusa target: full_spectrum.json lists physical and virtual extruders; legacy alias forces prusa", async () => {
    const model = await syntheticBambuModel();
    const { target: _t, mixFormat: _m, ...rest } = virtualPlan(model, "bambu");
    void _t; void _m;
    const built = buildPrusa3MF(model, rest);
    const fs = JSON.parse(entry(built, "Metadata/Prusa_Slicer_full_spectrum.json") as string);
    expect(fs.physical_extruders).toHaveLength(PRINTER);
    expect(fs.virtual_extruders.map((v: { id: number }) => v.id)).toEqual([9, 10]);
    expect(modelXml(built)).toContain("slic3rpe:MmPaintingVersion");
    // virtual id 9 stays <= 16 here, so version 1
    expect(built.mmVersion).toBe(1);
    expect(modelXml(buildPrusa3MF(model, { ...rest, target: "bambu" } as Build3MFPlan))).toContain("mmu_segmentation");
  });

  it("with ColorMix absent, project_settings carries no mixed_* keys", async () => {
    const model = await syntheticBambuModel();
    for (const mix of ["snapmaker", "bambu"] as const) {
      const built = build3MF(model, virtualPlan(model, mix, { virtuals: [], stateMap: new Map([[1, 1], [2, 2], [3, 3]]) }));
      const ps = JSON.parse(entry(built, "Metadata/project_settings.config") as string);
      expect(Object.keys(ps).some((k) => k.includes("mixed"))).toBe(false);
    }
  });
});

describe("part subtype lookup ignores prototype keys (volume-types fix)", () => {
  // The classic tool looked subtypes up in a plain object, so "constructor" & co. came back as
  // a function/object and the part turned into a bogus volume type. They now behave like any
  // unknown subtype: a ModelPart.
  const archive = async (subtype: string) => {
    const verts = '<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>';
    const mesh = (id: number) => `<object id="${id}" type="model"><mesh>${verts}<triangles><triangle v1="0" v2="1" v3="2" paint_color="4"/></triangles></mesh></object>`;
    const main = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${mesh(11)}${mesh(12)}<object id="10" type="model"><components><component objectid="11"/><component objectid="12"/></components></object></resources><build><item objectid="10"/></build></model>`;
    const settings = `<config><object id="10"><metadata key="name" value="Assembly"/><part id="11" subtype="normal_part"></part><part id="12" subtype="${subtype}"></part></object></config>`;
    return zipAll([
      { name: "3D/3dmodel.model", data: enc.encode(main) },
      { name: "Metadata/model_settings.config", data: enc.encode(settings) },
    ]);
  };

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])("subtype %s loads as ModelPart, like an unknown subtype", async (subtype) => {
    const m = await load3MF(await archive(subtype));
    expect(m.objects[0].parts.map((p) => p.type)).toEqual(["ModelPart", "ModelPart"]);
    expect(m.specialVolumes).toBe(0);
    expect(m.totalTris).toBe(2);
    const unknown = await load3MF(await archive("not_a_real_subtype"));
    expect(m).toEqual(unknown);
  });

  it("a Prusa export of such a part writes a valid volume_type", async () => {
    const m = await load3MF(await archive("constructor"));
    const built = build3MF(m, { ...plan("prusa", [[1, 1]]) });
    const cfg = entry(built, "Metadata/Slic3r_PE_model.config") as string;
    const types = [...cfg.matchAll(/key="volume_type" value="([^"]*)"/g)].map((x) => x[1]);
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((t) => ["ModelPart", "NegativeVolume", "ParameterModifier", "SupportBlocker", "SupportEnforcer"].includes(t))).toBe(true);
    expect(cfg).not.toMatch(/native code|\[object/);
  });

  it("real subtypes still map to their volume types", async () => {
    const m = await load3MF(await archive("negative_part"));
    expect(m.objects[0].parts.map((p) => p.type)).toEqual(["ModelPart", "NegativeVolume"]);
    expect(m.specialVolumes).toBe(1);
  });
});
