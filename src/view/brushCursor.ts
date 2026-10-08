import { Mesh, PlaneGeometry, Quaternion, ShaderMaterial, Vector3 } from "three";
import { OVERLAY_LAYER } from "./depthPass";

const VERTEX = /* glsl */ `
varying vec2 vPos;
void main() {
	vPos = position.xy;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

// A white ring with a dark outline, a faint white disc and a center dot, all of constant
// pixel width (fwidth), so it reads on any surface color in both themes. The eraser's ring
// is dashed. vPos spans -1..1 across the quad; uRing is the ring's radius in those units.
const FRAGMENT = /* glsl */ `
uniform float uRing;
uniform float uDashed;
varying vec2 vPos;

vec4 over( vec4 top, vec4 bottom ) {
	float a = top.a + bottom.a * ( 1.0 - top.a );
	return a <= 0.0 ? vec4( 0.0 ) : vec4( ( top.rgb * top.a + bottom.rgb * bottom.a * ( 1.0 - top.a ) ) / a, a );
}

void main() {
	float d = length( vPos );
	float px = max( fwidth( d ), 1e-5 ); // one pixel in d units
	float fromRing = abs( d - uRing ) / px; // distance to the ring line in pixels
	float dash = uDashed > 0.5 ? step( 0.0, sin( atan( vPos.y, vPos.x ) * 16.0 ) ) : 1.0;
	float core = ( 1.0 - smoothstep( 0.8, 1.6, fromRing ) ) * dash;
	float halo = 1.0 - smoothstep( 1.8, 2.8, fromRing );
	float fill = d < uRing ? 0.1 : 0.0;
	float dotPx = d / px;
	float dotCore = 1.0 - smoothstep( 1.5, 2.5, dotPx );
	float dotHalo = 1.0 - smoothstep( 3.0, 4.0, dotPx );

	vec4 c = vec4( 1.0, 1.0, 1.0, fill );
	c = over( vec4( 0.02, 0.02, 0.02, halo * 0.75 ), c );
	c = over( vec4( 1.0, 1.0, 1.0, core ), c );
	c = over( vec4( 0.02, 0.02, 0.02, dotHalo * 0.75 ), c );
	c = over( vec4( 1.0, 1.0, 1.0, dotCore ), c );
	if ( c.a <= 0.003 ) discard;
	gl_FragColor = c;
}
`;

const FORWARD = new Vector3(0, 0, 1);

/**
 * The brush cursor: a flat ring on the surface at the hit point, facing along the surface
 * normal and as wide as the brush. Drawn over everything (no depth test) on the overlay
 * layer, so it never takes part in picking or the depth pass.
 */
export class BrushCursor {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly quaternion = new Quaternion();

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uRing: { value: 0.9 }, uDashed: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.mesh.layers.set(OVERLAY_LAYER);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /**
   * Shows the ring at `point` (world), facing `normal`, `radius` wide. `pixelSize` is the
   * world size of one screen pixel there: the quad is never smaller than a few pixels, so a
   * tiny brush still gets a visible dot.
   */
  show(point: Vector3, normal: Vector3, radius: number, pixelSize: number, erase: boolean): void {
    const half = Math.max(radius + pixelSize * 5, pixelSize * 6); // room for the outline around the ring
    this.material.uniforms.uRing.value = radius / half;
    this.material.uniforms.uDashed.value = erase ? 1 : 0;
    this.quaternion.setFromUnitVectors(FORWARD, normal);
    this.mesh.quaternion.copy(this.quaternion);
    this.mesh.position.copy(point).addScaledVector(normal, pixelSize); // a hair off the surface
    this.mesh.scale.setScalar(half);
    this.mesh.visible = true;
  }

  hide(): boolean {
    const was = this.mesh.visible;
    this.mesh.visible = false;
    return was;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
