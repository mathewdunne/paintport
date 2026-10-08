import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType } from "three";
import { hexToRgb } from "../core";

/** Texels per row of the table texture; the shader fetches state `s` at (s % 256, s / 256). */
export const TABLE_WIDTH = 256;
const GRAY = 128;

function createTexture(rows: number): DataTexture {
  const texture = new DataTexture(new Uint8Array(TABLE_WIDTH * rows * 4), TABLE_WIDTH, rows, RGBAFormat, UnsignedByteType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/**
 * The color table the surface shader looks states up in: one RGBA8 texel per design state,
 * holding the sRGB bytes (the shader linearizes them). It shows either the Design colors
 * (the project palette) or the Print colors (what each state becomes on the printer, with
 * the design color where no print color is known). Changing either is one small texture
 * upload; no geometry attribute is touched. States beyond the table read as neutral gray.
 */
export class ColorTable {
  /** The shader uniform. Its `value` is replaced when the table outgrows the texture. */
  readonly uniform: { value: DataTexture };
  private design: readonly string[] = [];
  private print: readonly (string | undefined)[] | null = null;

  constructor() {
    this.uniform = { value: createTexture(1) };
    this.upload();
  }

  get texture(): DataTexture {
    return this.uniform.value;
  }

  /** True while the Print colors are shown. */
  get printing(): boolean {
    return this.print !== null;
  }

  /** Sets the Design colors ("#RRGGBB" per state). */
  setDesign(palette: readonly string[]): void {
    this.design = palette;
    this.upload();
  }

  /** Shows `colors` (indexed by design state; missing entries keep the design color) or, for null, the Design colors. */
  setPrint(colors: readonly (string | undefined)[] | null): void {
    this.print = colors;
    this.upload();
  }

  dispose(): void {
    this.uniform.value.dispose();
  }

  private upload(): void {
    const { design, print } = this;
    const size = Math.max(design.length, print?.length ?? 0);
    const rows = Math.max(1, Math.ceil(size / TABLE_WIDTH));
    let texture = this.uniform.value;
    if (rows > texture.image.height) {
      texture.dispose();
      texture = createTexture(rows);
      this.uniform.value = texture;
    }
    const data = texture.image.data as Uint8Array;
    for (let i = 0; i < data.length; i += 4) { data[i] = GRAY; data[i + 1] = GRAY; data[i + 2] = GRAY; data[i + 3] = 255; }
    for (let s = 0; s < size; s++) {
      const hex = print?.[s] || design[s]; // an empty entry is no color either
      if (!hex) continue;
      const [r, g, b] = hexToRgb(hex);
      data[s * 4] = Math.round(r * 255);
      data[s * 4 + 1] = Math.round(g * 255);
      data[s * 4 + 2] = Math.round(b * 255);
    }
    texture.needsUpdate = true;
  }
}
