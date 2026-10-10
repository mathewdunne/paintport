import { DoubleSide, MeshLambertMaterial } from "three";
import type { ColorTable } from "./colorTable";
import type { TreeAtlas } from "./treeAtlas";

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
  return "attribute float state;\nattribute float highlight;\nattribute float tree;\nuniform sampler2D ppColorTable;\n" + TREE_VARYINGS_GLSL + SRGB_TO_LINEAR_GLSL + vertexShader.replace(
    "#include <color_vertex>",
    `#ifdef USE_COLOR
	int ppState = int( state + 0.5 );
	vec3 ppLinear = ppSrgbToLinear( texelFetch( ppColorTable, ivec2( ppState & 255, ppState >> 8 ), 0 ).rgb );
	float ppLuma = dot( ppLinear, vec3( 0.2126, 0.7152, 0.0722 ) );
	vColor = vec4( mix( ppLinear, ppLuma > 0.18 ? vec3( 0.02 ) : vec3( 0.95 ), ${highlight ? "highlight * 0.6" : "0.0"} ), 1.0 );
#endif
	vPpTree = uint( tree + 0.5 );
	vPpBase = uint( state + 0.5 );
	int ppCorner = gl_VertexID - ( gl_VertexID / 3 ) * 3; // non-indexed: vertex k of a slot is the triangle's corner k
	vPpBary = vec3( ppCorner == 0 ? 1.0 : 0.0, ppCorner == 1 ? 1.0 : 0.0, ppCorner == 2 ? 1.0 : 0.0 );`,
  );
}

/** What the vertex stage hands the fragment walk: the tree root + 1 (0 = none), the base state and the point's barycentrics. */
const TREE_VARYINGS_GLSL = /* glsl */ `
flat varying highp uint vPpTree;
flat varying highp uint vPpBase;
varying vec3 vPpBary;
`;

/**
 * The sub-triangle walk (spec Q12, docs/FORMAT.md 2a, word layout in treeAtlas.ts): from the
 * root, step into the child the point lies deepest inside, up to 24 levels, and return the leaf
 * word. The same walk runs on the CPU as `walkAtlas`.
 */
const TREE_WALK_GLSL = /* glsl */ `
uniform highp usampler2D ppTreeNodes;
uint ppNode( uint i ) { return texelFetch( ppTreeNodes, ivec2( int( i & 4095u ), int( i >> 12u ) ), 0 ).r; }
float ppMinLocal( vec3 p, vec3 a, vec3 b, vec3 c ) {
	vec2 v0 = b.yz - a.yz, v1 = c.yz - a.yz, q = p.yz - a.yz;
	float den = v0.x * v1.y - v1.x * v0.y;
	float u = ( q.x * v1.y - v1.x * q.y ) / den, w = ( v0.x * q.y - q.x * v0.y ) / den;
	return min( min( 1.0 - u - w, u ), w );
}
uint ppTreeLeaf( uint root, vec3 p ) {
	uint word = ppNode( root );
	vec3 A = vec3( 1.0, 0.0, 0.0 ), B = vec3( 0.0, 1.0, 0.0 ), C = vec3( 0.0, 0.0, 1.0 );
	for ( int depth = 0; depth < 24; depth ++ ) {
		if ( ( word & 0x80000000u ) == 0u ) break;
		uint sides = ( word >> 29u ) & 3u, special = ( word >> 27u ) & 3u, first = word & 0x7FFFFFFu;
		vec3 r0 = special == 0u ? A : special == 1u ? B : C;
		vec3 r1 = special == 0u ? B : special == 1u ? C : A;
		vec3 r2 = special == 0u ? C : special == 1u ? A : B;
		vec3 ca[4], cb[4], cc[4];
		int n;
		if ( sides == 1u ) {
			vec3 m = ( r1 + r2 ) * 0.5;
			ca[0] = r0; cb[0] = r1; cc[0] = m;
			ca[1] = m;  cb[1] = r2; cc[1] = r0;
			n = 2;
		} else if ( sides == 2u ) {
			vec3 m1 = ( r0 + r1 ) * 0.5, m2 = ( r0 + r2 ) * 0.5;
			ca[0] = r0; cb[0] = m1; cc[0] = m2;
			ca[1] = m1; cb[1] = r1; cc[1] = m2;
			ca[2] = r1; cb[2] = r2; cc[2] = m2;
			n = 3;
		} else {
			vec3 m01 = ( r0 + r1 ) * 0.5, m12 = ( r1 + r2 ) * 0.5, m20 = ( r2 + r0 ) * 0.5;
			ca[0] = r0;  cb[0] = m01; cc[0] = m20;
			ca[1] = m01; cb[1] = r1;  cc[1] = m12;
			ca[2] = m12; cb[2] = r2;  cc[2] = m20;
			ca[3] = m01; cb[3] = m12; cc[3] = m20;
			n = 4;
		}
		int best = 0;
		float bestMin = -1e9;
		for ( int i = 0; i < 4; i ++ ) {
			if ( i >= n ) break;
			float m = ppMinLocal( p, ca[i], cb[i], cc[i] );
			if ( m > bestMin ) { bestMin = m; best = i; }
		}
		A = ca[best]; B = cb[best]; C = cc[best];
		word = ppNode( first + uint( best ) );
	}
	return word;
}
`;

/**
 * Returns the patched fragment shader; throws if three.js no longer includes color_fragment.
 * A triangle with a tree (`vPpTree` > 0) is colored per piece: the leaf's state, or the base
 * state for an unpainted leaf, looked up in the color table like the vertex path, with the leaf's
 * highlight bit mixed in like the `highlight` attribute.
 */
export function patchFragmentShader(fragmentShader: string, highlight = true): string {
  if (!fragmentShader.includes("#include <color_fragment>")) throw new Error("fragment shader has no color_fragment include");
  return "uniform sampler2D ppColorTable;\n" + TREE_VARYINGS_GLSL + SRGB_TO_LINEAR_GLSL + TREE_WALK_GLSL + fragmentShader.replace(
    "#include <color_fragment>",
    `#include <color_fragment>
	if ( vPpTree > 0u ) {
		uint ppWord = ppTreeLeaf( vPpTree - 1u, vPpBary );
		uint ppLeaf = ppWord & 0xFFFFu;
		uint ppPiece = ppLeaf == 0u ? vPpBase : ppLeaf;
		vec3 ppPieceLinear = ppSrgbToLinear( texelFetch( ppColorTable, ivec2( int( ppPiece & 255u ), int( ppPiece >> 8u ) ), 0 ).rgb );
		float ppPieceLuma = dot( ppPieceLinear, vec3( 0.2126, 0.7152, 0.0722 ) );
		float ppLit = ${highlight ? "( ppWord & 0x40000000u ) != 0u ? 0.6 : 0.0" : "0.0"};
		diffuseColor.rgb = diffuse * mix( ppPieceLinear, ppPieceLuma > 0.18 ? vec3( 0.02 ) : vec3( 0.95 ), ppLit );
	}`,
  );
}

/**
 * Flat-shaded Lambert surface whose per-triangle color comes from `table`. Flat shading
 * derives the normal from screen-space derivatives, so no normal attribute is needed.
 * `highlight: false` ignores the fill-preview highlight (for the image AI Paint sends to SAM).
 */
export function createSurfaceMaterial(table: ColorTable, atlas: TreeAtlas, options: { highlight?: boolean } = {}): MeshLambertMaterial {
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
    shader.fragmentShader = patchFragmentShader(shader.fragmentShader, highlight);
    shader.uniforms.ppColorTable = table.uniform;
    shader.uniforms.ppTreeNodes = atlas.uniform;
  };
  material.customProgramCacheKey = () => (highlight ? "paintport-state-tree-highlight" : "paintport-state-tree");
  return material;
}
