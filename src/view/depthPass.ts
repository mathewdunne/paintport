import {
  Color, DoubleSide, NearestFilter, NoBlending, NoColorSpace, RGBAFormat, ShaderMaterial, UnsignedByteType,
  WebGLRenderTarget, type Camera, type Scene, type WebGLRenderer,
} from "three";
import type { DepthFrame } from "./visibility";

/** Layer of the model meshes; the depth pass draws this layer only (grid and cursor are on layer 1). */
export const MODEL_LAYER = 0;
export const OVERLAY_LAYER = 1;

const VERTEX = /* glsl */ `
varying float vDepth;
void main() {
	vec4 mv = modelViewMatrix * vec4( position, 1.0 );
	vDepth = -mv.z;
	gl_Position = projectionMatrix * mv;
}
`;

// Packs the linear view depth into three bytes (see encodeDepth in visibility.ts) and the
// facing of the surface into alpha (255 front, 128 back); alpha 0 stays "nothing drawn".
const FRAGMENT = /* glsl */ `
uniform float uNear;
uniform float uRange;
varying float vDepth;
void main() {
	float v = floor( clamp( ( vDepth - uNear ) / uRange, 0.0, 1.0 ) * 16777215.0 + 0.5 );
	float r = floor( v / 65536.0 );
	float rest = v - r * 65536.0;
	float g = floor( rest / 256.0 );
	float b = rest - g * 256.0;
	gl_FragColor = vec4( r / 255.0, g / 255.0, b / 255.0, gl_FrontFacing ? 1.0 : 128.0 / 255.0 );
}
`;

/** Largest side of the depth image; bigger viewports are rendered smaller. */
const MAX_SIDE = 2048;

/**
 * Renders the model meshes' depth into an offscreen RGBA8 image and reads it back, for the
 * visible-only brush. The image depends on the camera and the scene only, not on paint, so
 * the viewer renders it once per camera pose and reuses it for every dab of a stroke.
 */
export class DepthPass {
  private target: WebGLRenderTarget | null = null;
  private pixels = new Uint8Array(0);
  private readonly material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { uNear: { value: 0 }, uRange: { value: 1 } },
    side: DoubleSide,
    blending: NoBlending,
    transparent: false,
  });
  private readonly clear = new Color();

  /** Draws the scene's model layer from `camera` at about `cssWidth` x `cssHeight` and returns the image. */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera & { near: number; far: number }, cssWidth: number, cssHeight: number): DepthFrame {
    const scale = Math.min(1, MAX_SIDE / Math.max(cssWidth, cssHeight));
    const width = Math.max(1, Math.round(cssWidth * scale)), height = Math.max(1, Math.round(cssHeight * scale));
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(width, height, {
        type: UnsignedByteType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
        depthBuffer: true, generateMipmaps: false, colorSpace: NoColorSpace,
      });
      this.pixels = new Uint8Array(width * height * 4);
    }
    const { near, far } = camera;
    this.material.uniforms.uNear.value = near;
    this.material.uniforms.uRange.value = far - near;

    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousMask = camera.layers.mask;
    renderer.getClearColor(this.clear);
    const previousOverride = scene.overrideMaterial;
    try {
      scene.overrideMaterial = this.material;
      camera.layers.set(MODEL_LAYER);
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, width, height, this.pixels);
    } finally {
      scene.overrideMaterial = previousOverride;
      camera.layers.mask = previousMask;
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(this.clear, previousAlpha);
    }
    return { width, height, data: this.pixels, near, far };
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
  }
}
