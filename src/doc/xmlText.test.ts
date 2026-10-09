import { describe, expect, it } from "vitest";
import { cubeMesh, makeModel } from "../../test/support/docFixtures";
import { createProject } from "./project";
import { unescapeXml } from "./xmlText";

describe("unescapeXml", () => {
  it("decodes the five predefined entities", () => {
    expect(unescapeXml("&lt;b&gt; &amp; &quot;x&quot; &apos;y&apos;")).toBe(`<b> & "x" 'y'`);
  });

  it("decodes decimal and hexadecimal character references, including astral ones", () => {
    expect(unescapeXml("&#65;&#x42;&#x63;&#128512;&#x1F600;")).toBe("ABc\u{1F600}\u{1F600}");
    expect(unescapeXml("caf&#233; &#xE9;")).toBe("café é");
  });

  it("decodes exactly once", () => {
    expect(unescapeXml("&amp;lt;")).toBe("&lt;");
    expect(unescapeXml("&amp;amp;")).toBe("&amp;");
    expect(unescapeXml("&amp;#65;")).toBe("&#65;");
  });

  it("leaves malformed or invalid references as they are", () => {
    for (const s of ["&", "a & b", "&;", "&foo;", "&amp", "&#;", "&#x;", "&#xZZ;", "&#12a;", "&#0;", "&#x0;", "&#1;", "&#xD800;", "&#55296;", "&#x110000;", "&#99999999999;", "&#xFFFFFFFFF;", "&AMP;", "&Lt;"]) {
      expect(unescapeXml(s), s).toBe(s);
    }
    expect(unescapeXml("&#65;&bogus;&#66;")).toBe("A&bogus;B");
  });

  it("keeps tab, newline and carriage return references and rejects other control characters", () => {
    expect(unescapeXml("&#9;&#10;&#13;")).toBe("\t\n\r");
    expect(unescapeXml("&#8;&#x1F;")).toBe("&#8;&#x1F;");
  });

  it("returns plain text unchanged", () => {
    expect(unescapeXml("")).toBe("");
    expect(unescapeXml("Ünï cödé <x>")).toBe("Ünï cödé <x>");
  });
});

describe("names in the document import", () => {
  it("unescapes object and part names once", () => {
    const model = makeModel(cubeMesh(), {
      parts: [
        { firstTri: 0, triCount: 6, extruder: 1, type: "ModelPart", name: "Left &amp;lt; arm" },
        { firstTri: 6, triCount: 6, extruder: 1, type: "NegativeVolume", name: "&lt;hole&gt;" },
      ],
    });
    model.objects[0].name = "Tom &amp; Jerry &#x3C;3";
    const project = createProject(model);
    expect(project.objects[0].name).toBe("Tom & Jerry <3");
    expect(project.objects[0].parts.map((p) => p.name)).toEqual(["Left &lt; arm", "<hole>"]);
  });

  it("leaves the names of an STL or OBJ model alone (plainNames)", () => {
    const model = makeModel(cubeMesh());
    model.objects[0].name = "R&amp;D &lt;v2&gt;";
    expect(createProject(model, { plainNames: true }).objects[0].name).toBe("R&amp;D &lt;v2&gt;");
  });

  it("keeps a part without a name null", () => {
    const project = createProject(makeModel(cubeMesh()));
    expect(project.objects[0].parts[0].name).toBeNull();
  });
});
