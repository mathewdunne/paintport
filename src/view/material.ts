import { DoubleSide, MeshLambertMaterial } from "three";

// Vertex colors hold sRGB bytes. three.js treats vertex colors as linear light, so the
// vertex shader converts them; a #FF0000 swatch then renders as that red under neutral
// light (the renderer's sRGB output encoding converts back).
export const SRGB_TO_LINEAR_GLSL = /* glsl */ `
vec3 ppSrgbToLinear( vec3 c ) {
	return mix( pow( c * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), c * 0.0773993808, vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) );
}
`;

/** Returns the patched vertex shader; throws if three.js no longer includes color_vertex. */
export function patchVertexShader(vertexShader: string): string {
  if (!vertexShader.includes("#include <color_vertex>")) throw new Error("vertex shader has no color_vertex include");
  return SRGB_TO_LINEAR_GLSL + vertexShader.replace(
    "#include <color_vertex>",
    "#include <color_vertex>\n#ifdef USE_COLOR\n\tvColor.rgb = ppSrgbToLinear( color );\n#endif",
  );
}

/**
 * Flat-shaded Lambert surface with per-vertex sRGB colors. Flat shading derives the
 * normal from screen-space derivatives, so no normal attribute is needed.
 */
export function createSurfaceMaterial(): MeshLambertMaterial {
  const material = new MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    side: DoubleSide, // tolerate open or inverted-normal meshes
    // Push the surface back a little so the ground grid wins where they touch.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = patchVertexShader(shader.vertexShader);
  };
  material.customProgramCacheKey = () => "paintport-srgb-vertex-colors";
  return material;
}
