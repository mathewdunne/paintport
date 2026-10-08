// Focused parsing of slicer-written 3MF XML: regexes instead of a DOM, so the core
// stays DOM-free and fast on multi-hundred-thousand-triangle meshes.

/**
 * Attribute map. A missing attribute reads as undefined; the file content decides, so
 * every attribute-derived field is typed `string | undefined`.
 */
export type Attrs = Record<string, string | undefined>;

export interface XmlComponent {
  /** The production extension's p:path (external model file), if any. */
  path: string | null;
  objectid: string | undefined;
  transform: string | null;
}

interface XmlObjectBase {
  /** Undefined for an <object> without an id attribute (it is then keyed under undefined). */
  id: string | undefined;
  type: string;
  components: XmlComponent[];
  name: string | null;
}
/** An object with a <mesh>. */
export interface XmlMeshObject extends XmlObjectBase {
  hasMesh: true;
  vertices: Float64Array;
  tris: Int32Array;
  paints: (string | null)[];
}
/** An object without a mesh; it only groups <component> references. */
export interface XmlGroupObject extends XmlObjectBase {
  hasMesh: false;
  vertices: null;
  tris: null;
  paints: null;
}
export type XmlObject = XmlMeshObject | XmlGroupObject;

export interface XmlBuildItem {
  objectid: string | undefined;
  transform: string | null;
  printable: boolean;
}

export interface ParsedModelXml {
  objects: Map<string | undefined, XmlObject>;
  buildItems: XmlBuildItem[];
  /** True if any triangle carries slic3rpe:mmu_segmentation (PrusaSlicer paint dialect). */
  sawMmuSeg: boolean;
  unit: string;
}

export function parseAttrs(tag: string): Attrs {
  const attrs: Attrs = {};
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

export function parseModelXML(xml: string): ParsedModelXml {
  const objects = new Map<string | undefined, XmlObject>();
  let sawMmuSeg = false; // dialect hint, handed back to load3MF through the return value
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let om;
  while ((om = objRe.exec(xml)) !== null) {
    const oAttrs = parseAttrs(om[1]);
    const id = oAttrs.id;
    const body = om[2];
    const type = oAttrs.type || "model";
    const name = oAttrs.name || null;
    const components: XmlComponent[] = [];
    let obj: XmlObject;
    const meshM = /<mesh\b[^>]*>([\s\S]*?)<\/mesh>/.exec(body);
    if (meshM) {
      const mesh = meshM[1];
      // Vertices: fast path when the attributes come in x,y,z order, tolerant otherwise
      const verts: number[] = [];
      const vFast = /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\s*\/>/g;
      let vm; let fastCount = 0;
      while ((vm = vFast.exec(mesh)) !== null) { verts.push(+vm[1], +vm[2], +vm[3]); fastCount++; }
      const tagCount = (mesh.match(/<vertex\b/g) || []).length;
      if (fastCount !== tagCount) {
        verts.length = 0;
        const vAny = /<vertex\b[^>]*\/>/g;
        let va;
        while ((va = vAny.exec(mesh)) !== null) {
          const a = parseAttrs(va[0]);
          verts.push(Number(a.x), Number(a.y), Number(a.z)); // missing -> NaN, as with unary plus
        }
      }
      // Triangles
      const tris: number[] = [];
      const paints: (string | null)[] = [];
      const tAny = /<triangle\b[^>]*\/>/g;
      let tm;
      while ((tm = tAny.exec(mesh)) !== null) {
        const a = parseAttrs(tm[0]);
        tris.push(Number(a.v1), Number(a.v2), Number(a.v3));
        if (a["slic3rpe:mmu_segmentation"]) sawMmuSeg = true;
        paints.push(a["slic3rpe:mmu_segmentation"] || a.paint_color || null);
      }
      obj = { id, type, vertices: new Float64Array(verts), tris: new Int32Array(tris), paints, components, hasMesh: true, name };
    } else {
      obj = { id, type, vertices: null, tris: null, paints: null, components, hasMesh: false, name };
    }
    const compRe = /<component\b[^>]*\/>/g;
    let cm;
    while ((cm = compRe.exec(body)) !== null) {
      const a = parseAttrs(cm[0]);
      components.push({ path: a["p:path"] || null, objectid: a.objectid, transform: a.transform || null });
    }
    objects.set(id, obj);
  }
  const buildItems: XmlBuildItem[] = [];
  const buildM = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
  if (buildM) {
    const iRe = /<item\b[^>]*\/>/g;
    let im;
    while ((im = iRe.exec(buildM[1])) !== null) {
      const a = parseAttrs(im[0]);
      buildItems.push({ objectid: a.objectid, transform: a.transform || null, printable: a.printable !== "0" });
    }
  }
  const unitM = /<model\b[^>]*?\bunit="([^"]*)"/.exec(xml);
  return { objects, buildItems, sawMmuSeg, unit: unitM ? unitM[1] : "millimeter" };
}
