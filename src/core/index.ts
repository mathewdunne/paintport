// PaintPort core: DOM-free 3MF/paint-codec/color logic. Runs in browsers and Node >= 18.
import { applyTransform, parseTransform } from "./threemf/transform";
import { build3MF, buildPrusa3MF } from "./threemf/build";
import { load3MF } from "./threemf/load";
import { bestMix, predictMix, topMixes } from "./mix";
import { deltaE, hexToRgb, normalizeHex } from "./color";
import { PAINTPORT_VERSION } from "./version";
import { collectStates, emitPaintTree, parsePaintTree, remapPaintString } from "./paint/codec";
import { unzipAll, zipAll } from "./zip";

export { PAINTPORT_VERSION } from "./version";
export { CORE_ERRORS, CoreError, coreError, type CoreErrorCode } from "./errors";
export { crc32, unzipAll, zipAll, type ZipEntry } from "./zip";
export {
  collectStates, emitPaintTree, parsePaintTree, remapPaintString,
  type PaintDialect, type PaintLeaf, type PaintNode, type PaintSplit,
} from "./paint/codec";
export { parseAttrs, parseModelXML } from "./threemf/xml";
export type { Attrs, ParsedModelXml, XmlBuildItem, XmlComponent, XmlObject } from "./threemf/xml";
export { applyTransform, composeTransform, parseTransform, type Transform } from "./threemf/transform";
export { VOLUME_TYPES, load3MF } from "./threemf/load";
export { build3MF, buildPrusa3MF } from "./threemf/build";
export { deltaE, hexToRgb, linearToSrgb, normalizeHex, rgbToHex, rgbToLab, srgbToLinear, type Lab, type Rgb } from "./color";
export { bestMix, predictMix, topMixes, type MixCandidate, type MixComponent, type MixInput, type MixSlot } from "./mix";
export type {
  Build3MFPlan, Build3MFResult, BuildTarget, Filament, MixComponentRef, MixFormat, Model, ModelObject,
  PartRange, PhysicalSlot, SourceIdentity, VirtualExtruder, VolumeType,
} from "./types";

/** Same keys, same order as the classic tool's `globalThis.PaintPortCore`. */
export const PaintPortCore = {
  version: PAINTPORT_VERSION,
  unzipAll, zipAll, load3MF, build3MF, buildPrusa3MF,
  remapPaintString, parsePaintTree, emitPaintTree, collectStates,
  deltaE, bestMix, topMixes, predictMix, normalizeHex,
  parseTransform, applyTransform, hexToRgb,
};
