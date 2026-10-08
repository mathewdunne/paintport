import { LinearMipmapLinearFilter, NearestFilter, NoColorSpace } from "three";
import { describe, expect, it } from "vitest";
import { ColorTable, TABLE_WIDTH } from "./colorTable";

/** The texel of `state` as the shader fetches it: column `state % 256`, row `state / 256`. */
function texel(table: ColorTable, state: number): number[] {
  const { data, width } = table.texture.image as { data: Uint8Array; width: number };
  const o = ((state >> 8) * width + (state & 255)) * 4;
  return Array.from(data.slice(o, o + 4));
}

describe("ColorTable", () => {
  it("holds the design palette as sRGB bytes, one texel per state", () => {
    const table = new ColorTable();
    table.setDesign(["#000000", "#FF0000", "#00FF80"]);
    expect(texel(table, 1)).toEqual([255, 0, 0, 255]);
    expect(texel(table, 2)).toEqual([0, 255, 128, 255]);
    expect(table.texture.image.width).toBe(TABLE_WIDTH);
    expect(table.printing).toBe(false);
  });

  it("is raw data that texelFetch reads as is: no color space, no flip, nearest, no mipmaps", () => {
    const table = new ColorTable();
    table.setDesign(Array.from({ length: 300 }, () => "#123456")); // also holds for a regrown texture
    const t = table.texture;
    expect(t.colorSpace).toBe(NoColorSpace);
    expect(t.flipY).toBe(false);
    expect(t.minFilter).toBe(NearestFilter);
    expect(t.magFilter).toBe(NearestFilter);
    expect(t.minFilter).not.toBe(LinearMipmapLinearFilter);
    expect(t.generateMipmaps).toBe(false);
  });

  it("shows neutral gray for junk colors and states beyond the palette", () => {
    const table = new ColorTable();
    table.setDesign(["#000000", "nope"]);
    expect(texel(table, 1)).toEqual([128, 128, 128, 255]);
    expect(texel(table, 40)).toEqual([128, 128, 128, 255]);
  });

  it("bumps the texture version on every change, and replaces nothing while it fits", () => {
    const table = new ColorTable();
    const texture = table.texture;
    const v = texture.version;
    table.setDesign(["#000000", "#FF0000"]);
    expect(table.texture).toBe(texture);
    expect(texture.version).toBeGreaterThan(v);
  });

  it("clears stale entries when the palette shrinks", () => {
    const table = new ColorTable();
    table.setDesign(["#000000", "#FF0000", "#00FF00"]);
    table.setDesign(["#000000", "#FF0000"]);
    expect(texel(table, 2)).toEqual([128, 128, 128, 255]);
  });

  it("shows print colors where given and the design color where an entry is missing or undefined", () => {
    const table = new ColorTable();
    table.setDesign(["#000000", "#FF0000", "#00FF00", "#0000FF"]);
    table.setPrint([undefined, "#101010", undefined, "#FFFF00"]);
    expect(table.printing).toBe(true);
    expect(texel(table, 1)).toEqual([16, 16, 16, 255]);
    expect(texel(table, 2)).toEqual([0, 255, 0, 255]); // undefined entry: design color
    expect(texel(table, 3)).toEqual([255, 255, 0, 255]);
    table.setPrint(["#000000", "#202020"]); // shorter array: missing entries are design colors
    expect(texel(table, 1)).toEqual([32, 32, 32, 255]);
    expect(texel(table, 3)).toEqual([0, 0, 255, 255]);
    table.setPrint(null);
    expect(table.printing).toBe(false);
    expect(texel(table, 1)).toEqual([255, 0, 0, 255]);
  });

  it("treats an empty print entry as missing", () => {
    const table = new ColorTable();
    table.setDesign(["#000000", "#FF0000"]);
    table.setPrint(["", ""]);
    expect(texel(table, 1)).toEqual([255, 0, 0, 255]);
  });

  it("follows design edits made while the print view is shown", () => {
    const table = new ColorTable();
    table.setDesign(["#000000", "#FF0000", "#00FF00"]);
    table.setPrint([undefined, "#101010"]);
    table.setDesign(["#000000", "#FF0000", "#0000FF"]);
    expect(texel(table, 1)).toEqual([16, 16, 16, 255]);
    expect(texel(table, 2)).toEqual([0, 0, 255, 255]);
  });

  it("grows past 256 states by moving to a taller texture", () => {
    const table = new ColorTable();
    const small = table.texture;
    expect(small.image.height).toBe(1);
    const palette = Array.from({ length: 600 }, (_, i) => "#" + i.toString(16).padStart(6, "0"));
    table.setDesign(palette);
    expect(table.texture).not.toBe(small);
    expect(table.uniform.value).toBe(table.texture); // the shader's uniform follows
    expect(table.texture.image.height).toBe(3);
    expect(texel(table, 255)).toEqual([0, 0, 255, 255]);
    expect(texel(table, 256)).toEqual([0, 1, 0, 255]);
    expect(texel(table, 599)).toEqual([0, 2, 87, 255]);
    expect(texel(table, 600)).toEqual([128, 128, 128, 255]);
  });

  it("sizes the table for a print array longer than the palette", () => {
    const table = new ColorTable();
    table.setDesign(["#000000"]);
    const print: (string | undefined)[] = [];
    print[299] = "#123456";
    table.setPrint(print);
    expect(table.texture.image.height).toBe(2);
    expect(texel(table, 299)).toEqual([0x12, 0x34, 0x56, 255]);
  });
});
