import {
  Box3, DirectionalLight, GridHelper, HemisphereLight, Mesh, MOUSE, PerspectiveCamera, Scene, Sphere, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createGrid, setGridTheme } from "./grid";
import { createSurfaceMaterial } from "./material";
import { buildObjectGeometry, paletteToBytes, updateTriangleColors, type ObjectGeometry } from "./objectGeometry";
import type { ViewScene } from "./viewScene";

const MAX_PIXEL_RATIO = 2;
const FOV = 45;

/**
 * three.js viewport. Owns the renderer, camera and controls; the document owns the data.
 * Renders on demand (control change, resize, data change), never in a loop. No React.
 *
 * Mouse mapping: the left button is reserved for tools and does nothing here. Right drag
 * orbits, middle drag and Shift+right drag pan, the wheel zooms toward the cursor, and
 * Alt+left drag orbits (trackpads).
 */
export class ModelViewer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.1, 1000);
  private readonly controls: OrbitControls;
  private readonly material = createSurfaceMaterial();
  private readonly resizeObserver: ResizeObserver;
  private readonly canvas: HTMLCanvasElement;

  private data: ViewScene | null = null;
  private paletteBytes: Uint8Array = new Uint8Array(0);
  private objects: { index: number; mesh: Mesh; geo: ObjectGeometry }[] = [];
  private grid: GridHelper | null = null;
  private dark = false;
  private raf = 0;
  private disposed = false;

  /** `onError` is called when building or drawing a model fails after construction. */
  constructor(private readonly container: HTMLElement, private readonly onError: (error: unknown) => void = () => {}) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0); // the container's CSS background shows through
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    container.appendChild(this.canvas);

    // 3MF is Z-up. Must be set before the controls are created.
    this.camera.up.set(0, 0, 1);
    this.scene.add(this.camera);

    // Soft sky/ground light plus a headlight that follows the camera (a child of it).
    const hemi = new HemisphereLight(0xffffff, 0xbbbbbb, Math.PI * 0.6);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const headlight = new DirectionalLight(0xffffff, Math.PI * 0.55);
    headlight.position.set(-0.35, 0.6, 1);
    this.camera.add(headlight, headlight.target);

    // Alt+left must orbit, plain left must not. Decided per press, before OrbitControls
    // (listening on the canvas) sees the event, so there is no key state to get stuck.
    container.addEventListener("pointerdown", this.onPointerDownCapture, true);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }; // Shift+RIGHT pans (OrbitControls swaps the action)
    this.controls.zoomToCursor = true;
    this.controls.addEventListener("change", this.requestRender);

    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.requestRender);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  /** Replaces the displayed model (disposing the previous one) and frames it. Null clears. */
  setScene(data: ViewScene | null): void {
    try {
      this.buildScene(data);
    } catch (error) {
      this.clearObjects();
      this.data = null;
      this.onError(error);
    }
  }

  private buildScene(data: ViewScene | null): void {
    this.clearObjects();
    this.data = data;
    if (!data) {
      this.requestRender();
      return;
    }
    this.paletteBytes = paletteToBytes(data.palette);
    const bounds = new Box3();
    data.objects.forEach((obj, index) => {
      const geo = buildObjectGeometry(obj, this.paletteBytes);
      if (geo.slotCount === 0) {
        geo.geometry.dispose();
        return;
      }
      const mesh = new Mesh(geo.geometry, this.material);
      this.scene.add(mesh);
      this.objects.push({ index, mesh, geo });
      bounds.union(geo.geometry.boundingBox!);
    });
    if (!bounds.isEmpty()) {
      this.grid = createGrid(bounds, this.dark);
      this.scene.add(this.grid);
      this.frame(bounds);
    }
    this.requestRender();
  }

  /**
   * Re-reads the given triangles' states from the scene and recolors them. `objectIndex`
   * and the triangle indices are document indices (as in `ViewScene.objects`).
   */
  updateTriangleColors(objectIndex: number, triIndices: ArrayLike<number>): void {
    if (!this.data) return;
    const obj = this.objects.find((o) => o.index === objectIndex);
    if (!obj) return;
    updateTriangleColors(obj.geo, this.data.objects[objectIndex].states, triIndices, this.paletteBytes);
    this.requestRender();
  }

  setDark(dark: boolean): void {
    this.dark = dark;
    if (this.grid) setGridTheme(this.grid, dark);
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.container.removeEventListener("pointerdown", this.onPointerDownCapture, true);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.requestRender);
    this.controls.dispose();
    this.clearObjects();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // free the GPU context now (StrictMode/HMR remount the viewer)
    this.canvas.remove();
  }

  // --- internals -----------------------------------------------------------------

  private clearObjects(): void {
    for (const o of this.objects) {
      this.scene.remove(o.mesh);
      o.geo.geometry.dispose();
    }
    this.objects = [];
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as { dispose(): void }).dispose();
      this.grid = null;
    }
  }

  private frame(bounds: Box3): void {
    const sphere = bounds.getBoundingSphere(new Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    // Fit the bounding sphere into the narrower of the vertical and horizontal fields of view.
    const halfV = (FOV * Math.PI) / 360;
    const half = Math.min(halfV, Math.atan(Math.tan(halfV) * this.camera.aspect));
    const distance = (r / Math.sin(half)) * 1.1;
    const dir = new Vector3(0.7, -1, 0.65).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(dir, distance);
    this.camera.near = r * 0.01;
    this.camera.far = r * 200;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.minDistance = r * 0.05;
    this.controls.maxDistance = r * 50;
    this.controls.update();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private readonly requestRender = (): void => {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.disposed) return;
      try {
        this.renderer.render(this.scene, this.camera);
      } catch (error) {
        this.onError(error);
      }
    });
  };

  private readonly onPointerDownCapture = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    this.controls.mouseButtons.LEFT = e.altKey ? MOUSE.ROTATE : null;
  };

  private readonly onContextMenu = (e: Event): void => e.preventDefault();

  private readonly onContextLost = (e: Event): void => e.preventDefault(); // allow restore
}
