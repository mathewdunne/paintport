import { BufferAttribute, BufferGeometry, Points, ShaderMaterial } from "three";
import type { ViewMark } from "../tools/types";
import { OVERLAY_LAYER } from "./depthPass";

/** Diameter of a mark in CSS pixels. */
const MARK_PX = 16;

const VERTEX = /* glsl */ `
attribute float aInside;
uniform float uSize;
varying float vInside;
void main() {
	vInside = aInside;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	gl_PointSize = uSize;
}
`;

// A round badge with a dark outline: green with a white plus for inside marks, red with a white
// minus for outside ones, so the two read apart without relying on color.
const FRAGMENT = /* glsl */ `
varying float vInside;
void main() {
	vec2 c = gl_PointCoord * 2.0 - 1.0;
	float d = length( c );
	if ( d > 1.0 ) discard;
	bool inside = vInside > 0.5;
	vec3 color = inside ? vec3( 0.13, 0.66, 0.33 ) : vec3( 0.86, 0.2, 0.2 );
	bool bar = abs( c.y ) < 0.13 && abs( c.x ) < 0.48;
	bool post = inside && abs( c.x ) < 0.13 && abs( c.y ) < 0.48;
	if ( bar || post ) color = vec3( 1.0 );
	if ( d > 0.78 ) color = vec3( 0.04 );
	gl_FragColor = vec4( color, 1.0 );
}
`;

/**
 * The guided fill marks: constant-size badges at points on the surface. Drawn over everything
 * (no depth test) on the overlay layer, like the brush cursor, so a mark stays visible from
 * any side and never takes part in picking or the depth pass.
 */
export class Markers {
  readonly points: Points;
  private readonly material: ShaderMaterial;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uSize: { value: MARK_PX } },
      depthTest: false,
      depthWrite: false,
    });
    this.points = new Points(new BufferGeometry(), this.material);
    this.points.layers.set(OVERLAY_LAYER);
    this.points.renderOrder = 11;
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  /** Replaces the marks. Returns true if anything was or is shown (a redraw is needed). */
  set(marks: readonly ViewMark[]): boolean {
    const was = this.points.visible;
    this.points.geometry.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(Float32Array.from(marks.flatMap((m) => m.point)), 3));
    geometry.setAttribute("aInside", new BufferAttribute(Float32Array.from(marks, (m) => (m.inside ? 1 : 0)), 1));
    this.points.geometry = geometry;
    this.points.visible = marks.length > 0;
    return was || this.points.visible;
  }

  /** Device pixels per CSS pixel, so the marks keep their size on high-density screens. */
  setPixelRatio(ratio: number): void {
    this.material.uniforms.uSize.value = MARK_PX * ratio;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
