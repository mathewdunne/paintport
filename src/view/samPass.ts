import {
  Color, NearestFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType, WebGLRenderTarget, type Camera, type Material, type Scene, type WebGLRenderer,
} from "three";
import { flipRows } from "../sam/image";
import type { SamImage } from "../sam/types";
import { MODEL_LAYER } from "./depthPass";

/** Background behind the model in the SAM image (chosen in the spike). */
const BACKGROUND = 0xffffff;

/**
 * Renders the model meshes (no grid, cursor, marks or highlight) offscreen at the size SAM
 * takes and reads the image back as sRGB bytes, top row first.
 */
export class SamPass {
  private target: WebGLRenderTarget | null = null;
  private readonly clear = new Color();

  constructor(private readonly material: Material) {}

  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, width: number, height: number): SamImage {
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.dispose();
      this.target = new WebGLRenderTarget(width, height, {
        type: UnsignedByteType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter,
        depthBuffer: true, generateMipmaps: false, colorSpace: SRGBColorSpace,
      });
    }
    const pixels = new Uint8Array(width * height * 4);
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousMask = camera.layers.mask;
    const previousOverride = scene.overrideMaterial;
    renderer.getClearColor(this.clear);
    try {
      scene.overrideMaterial = this.material;
      camera.layers.set(MODEL_LAYER);
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(BACKGROUND, 1);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(this.target, 0, 0, width, height, pixels);
    } finally {
      scene.overrideMaterial = previousOverride;
      camera.layers.mask = previousMask;
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(this.clear, previousAlpha);
    }
    return flipRows(pixels, width, height);
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.material.dispose();
  }
}
