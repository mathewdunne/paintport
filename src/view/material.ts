import { DoubleSide, MeshLambertMaterial } from "three";
import type { ColorTable } from "./colorTable";

// The color table holds sRGB bytes. three.js treats vertex colors as linear light, so the
// vertex shader converts them; a #FF0000 swatch then renders as that red under neutral
// light (the renderer's sRGB output encoding converts back).
export const SRGB_TO_LINEAR_GLSL = /* glsl */ `
vec3 ppSrgbToLinear( vec3 c ) {
	return mix( pow( c * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), c * 0.0773993808, vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) );
}
`;

/**
 * Returns the patched vertex shader; throws if three.js no longer includes color_vertex.
 *
 * The vertex color is not read from a color attribute: the `state` attribute (the
 * triangle's design state, equal on its 3 vertices, so the color stays flat) indexes the
 * `ppColorTable` texture (256 texels per row, see colorTable.ts) and the texel is
 * linearized.
 *
 * Also adds the `highlight` attribute (0..1 per vertex) that marks the region a fill would
 * paint: the color is mixed toward near-black on light surfaces and toward white on dark
 * ones, so the preview stands out on any color. `highlight` false leaves the highlight attribute out of the color.
 */
export function patchVertexShader(vertexShader: string, highlight = true): string {
  if (!vertexShader.includes("#include <color_vertex>")) throw new Error("vertex shader has no color_vertex include");
  return "attribute float state;\nattribute float highlight;\nuniform sampler2D ppColorTable;\n" + SRGB_TO_LINEAR_GLSL + vertexShader.replace(
    "#include <color_vertex>",
    `#ifdef USE_COLOR
	int ppState = int( state + 0.5 );
	vec3 ppLinear = ppSrgbToLinear( texelFetch( ppColorTable, ivec2( ppState & 255, ppState >> 8 ), 0 ).rgb );
	float ppLuma = dot( ppLinear, vec3( 0.2126, 0.7152, 0.0722 ) );
	vColor = vec4( mix( ppLinear, ppLuma > 0.18 ? vec3( 0.02 ) : vec3( 0.95 ), ${highlight ? "highlight * 0.6" : "0.0"} ), 1.0 );
#endif`,
  );
}

/**
 * Flat-shaded Lambert surface whose per-triangle color comes from `table`. Flat shading
 * derives the normal from screen-space derivatives, so no normal attribute is needed.
 * `highlight: false` ignores the fill-preview highlight (for the image AI Paint sends to SAM).
 */
export function createSurfaceMaterial(table: ColorTable, options: { highlight?: boolean } = {}): MeshLambertMaterial {
  const highlight = options.highlight ?? true;
  const material = new MeshLambertMaterial({
    vertexColors: true, // enables the vColor path; the values come from the table, not a color attribute
    flatShading: true,
    side: DoubleSide, // tolerate open or inverted-normal meshes
    // Push the surface back a little so the ground grid wins where they touch.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = patchVertexShader(shader.vertexShader, highlight);
    shader.uniforms.ppColorTable = table.uniform;
  };
  material.customProgramCacheKey = () => (highlight ? "paintport-state-color-table-highlight" : "paintport-state-color-table");
  return material;
}
