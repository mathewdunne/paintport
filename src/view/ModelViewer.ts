import {
  Box3, DirectionalLight, GridHelper, HemisphereLight, Mesh, MOUSE, PerspectiveCamera, Raycaster, Scene, Sphere, Vector2, Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BrushTarget, PaintView, PickHit } from "../tools/types";
import { BrushCursor } from "./brushCursor";
import { DepthPass, MODEL_LAYER, OVERLAY_LAYER } from "./depthPass";
import { createGrid, setGridTheme } from "./grid";
import { ColorSurface } from "./colorSurface";
import { createSurfaceMaterial } from "./material";
import { buildObjectGeometry, isTriangleHighlighted, setTriangleHighlight, type ObjectGeometry } from "./objectGeometry";
import { ObjectPicker, TriangleList } from "./picking";
import { VisibilityTest } from "./visibility";
import type { ViewScene } from "./viewScene";

const MAX_PIXEL_RATIO = 2;
const FOV = 45;

interface ViewObjectEntry {
  /** Index into `ViewScene.objects`, which is the document's object index. */
  index: number;
  mesh: Mesh;
  geo: ObjectGeometry;
  /** Built a moment after the scene is shown (see `buildPickers`). */
  picker: ObjectPicker | null;
}

/**
 * three.js viewport. Owns the renderer, camera and controls; the document owns the data.
 * Renders on demand (control change, resize, data change), never in a loop. No React.
 *
 * Mouse mapping: the left button is reserved for tools and does nothing here. Right drag
 * orbits, middle drag and Shift+right drag pan, the wheel zooms toward the cursor, and
 * Alt+left drag orbits (trackpads).
 *
 * It also answers the paint tools' questions (`PaintView`): what surface is under the
 * cursor, which triangles a brush sphere may paint (with optional visibility), and it
 * draws their feedback (brush ring, fill preview).
 */
export class ModelViewer implements PaintView {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.1, 1000);
  private readonly controls: OrbitControls;
  private readonly colors = new ColorSurface();
  private readonly material = createSurfaceMaterial(this.colors.table);
  private readonly resizeObserver: ResizeObserver;
  private readonly canvas: HTMLCanvasElement;
  private readonly raycaster = new Raycaster();
  private readonly depthPass = new DepthPass();
  private readonly brushCursor = new BrushCursor();
  private readonly candidates = new TriangleList();
  private readonly viewListeners = new Set<() => void>();
  private objects: ViewObjectEntry[] = [];
  private grid: GridHelper | null = null;
  private highlighted: { entry: ViewObjectEntry; tris: Uint32Array } | null = null;
  private depth: VisibilityTest | null = null;
  /** The pose the cached `depth` was rendered for: camera matrix, projection, viewport size, scene epoch. */
  private readonly depthPose = new Float64Array(35);
  /** Bumped when the drawn scene changes in a way that invalidates the depth image. */
  private sceneEpoch = 0;
  private pickerToken = 0;
  private pickerTimer = 0;
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
    this.camera.layers.enable(OVERLAY_LAYER); // grid and brush cursor; the depth pass draws the model layer only
    this.scene.add(this.camera);

    // Soft sky/ground light plus a headlight that follows the camera (a child of it).
    const hemi = new HemisphereLight(0xffffff, 0xbbbbbb, Math.PI * 0.6);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const headlight = new DirectionalLight(0xffffff, Math.PI * 0.55);
    headlight.position.set(-0.35, 0.6, 1);
    this.camera.add(headlight, headlight.target);

    this.scene.add(this.brushCursor.mesh);

    // Alt+left must orbit, plain left must not. Decided per press, before OrbitControls
    // (listening on the canvas) sees the event, so there is no key state to get stuck.
    container.addEventListener("pointerdown", this.onPointerDownCapture, true);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }; // Shift+RIGHT pans (OrbitControls swaps the action)
    this.controls.zoomToCursor = true;
    this.controls.addEventListener("change", this.onControlsChange);
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
      this.onError(error);
    }
  }

  private buildScene(data: ViewScene | null): void {
    this.clearObjects();
    if (!data) {
      this.requestRender();
      this.notifyViewChange();
      return;
    }
    this.colors.setScene(data);
    const bounds = new Box3();
    data.objects.forEach((obj, index) => {
      const geo = buildObjectGeometry(obj);
      if (geo.slotCount === 0) {
        geo.geometry.dispose();
        return;
      }
      const mesh = new Mesh(geo.geometry, this.material);
      mesh.layers.set(MODEL_LAYER);
      this.scene.add(mesh);
      this.colors.add(index, geo);
      this.objects.push({ index, mesh, geo, picker: null });
      bounds.union(geo.geometry.boundingBox!);
    });
    if (!bounds.isEmpty()) {
      this.grid = createGrid(bounds, this.dark);
      this.grid.layers.set(OVERLAY_LAYER);
      this.scene.add(this.grid);
      this.frame(bounds);
    }
    this.requestRender();
    this.notifyViewChange();
    this.buildPickersSoon();
  }

  /**
   * Re-reads the given triangles' states from the scene and rewrites them in the state
   * attribute. `objectIndex` and the triangle indices are document indices (as in
   * `ViewScene.objects`).
   */
  updateTriangleStates(objectIndex: number, triIndices: ArrayLike<number>): void {
    if (this.colors.updateTriangleStates(objectIndex, triIndices)) this.requestRender();
  }

  /**
   * Re-reads every triangle's state from the scene (after states were merged or
   * renumbered; the scene's `states` must already be up to date) and rewrites the whole
   * state attribute of every object.
   */
  refreshStates(): void {
    if (this.colors.refreshStates()) this.requestRender();
  }

  /**
   * Installs the Design colors ("#RRGGBB" per state). A texture upload only: no geometry
   * attribute is written, whatever changed. Shown while no Print colors are set.
   */
  setPalette(palette: string[]): void {
    if (this.colors.setPalette(palette)) this.requestRender();
  }

  /**
   * Chooses the color table the surface is drawn with. Null shows the Design colors (the
   * palette, the default). An array shows the Print view: `colors[state]` ("#RRGGBB") for
   * each design state, where an entry that is missing or undefined keeps that state's
   * design color. A texture upload only, so it is cheap to call on every mapping or spool
   * edit. It survives `setScene`: the caller owns it and resets it for a new project.
   *
   * The viewer does not follow the project: entries derived from design colors (an Auto
   * mapping's nearest spool or blend) must be recomputed and set again by the caller on
   * every palette event and every mapping event, or the Print view goes stale.
   */
  setPrintColors(colors: readonly (string | undefined)[] | null): void {
    this.colors.setPrintColors(colors);
    this.requestRender();
  }

  /** Shows or hides an object (it is then neither drawn nor picked nor painted). */
  setObjectVisible(objectIndex: number, visible: boolean): void {
    const obj = this.objects.find((o) => o.index === objectIndex);
    if (!obj || obj.mesh.visible === visible) return;
    obj.mesh.visible = visible;
    if (!visible && this.highlighted?.entry === obj) this.setRegionHighlight(objectIndex, null);
    this.sceneEpoch++;
    this.requestRender();
    this.notifyViewChange();
  }

  setDark(dark: boolean): void {
    this.dark = dark;
    if (this.grid) setGridTheme(this.grid, dark);
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.pickerTimer);
    this.pickerToken++;
    this.viewListeners.clear();
    this.resizeObserver.disconnect();
    this.container.removeEventListener("pointerdown", this.onPointerDownCapture, true);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.requestRender);
    this.controls.dispose();
    this.clearObjects();
    this.brushCursor.dispose();
    this.depthPass.dispose();
    this.material.dispose();
    this.colors.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss(); // free the GPU context now (StrictMode/HMR remount the viewer)
    this.canvas.remove();
  }

  // --- PaintView -----------------------------------------------------------------

  get element(): HTMLElement {
    return this.canvas;
  }

  pick(clientX: number, clientY: number): PickHit | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    let best: { entry: ViewObjectEntry; hit: NonNullable<ReturnType<ObjectPicker["raycast"]>> } | null = null;
    for (const entry of this.objects) {
      if (!entry.picker || !entry.mesh.visible) continue;
      const hit = entry.picker.raycast(this.raycaster.ray);
      if (hit && (!best || hit.distance < best.hit.distance)) best = { entry, hit };
    }
    if (!best) return null;
    const { entry, hit } = best;
    return {
      object: entry.index,
      tri: hit.tri,
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
      distance: hit.distance,
    };
  }

  brushCandidates(hit: PickHit, radius: number, visibleOnly: boolean): BrushTarget[] {
    const visibility = visibleOnly ? this.visibility() : null;
    const center = new Vector3(hit.point[0], hit.point[1], hit.point[2]);
    const out: BrushTarget[] = [];
    for (const entry of this.objects) {
      if (!entry.picker || !entry.mesh.visible) continue;
      this.candidates.clear();
      entry.picker.collectSphere(center, radius, visibility, entry.index === hit.object ? hit.tri : -1, this.candidates);
      if (this.candidates.length > 0) out.push({ object: entry.index, tris: this.candidates.toArray() });
    }
    return out;
  }

  pixelSizeAt(distance: number): number {
    return (2 * distance * Math.tan((FOV * Math.PI) / 360)) / Math.max(1, this.container.clientHeight);
  }

  showBrushCursor(hit: PickHit, radius: number, erase: boolean): void {
    this.brushCursor.show(new Vector3(...hit.point), new Vector3(...hit.normal), radius, this.pixelSizeAt(hit.distance), erase);
    this.requestRender();
  }

  hideBrushCursor(): void {
    if (this.brushCursor.hide()) this.requestRender();
  }

  setRegionHighlight(objectIndex: number, tris: Uint32Array | null): void {
    const previous = this.highlighted;
    if (previous) setTriangleHighlight(previous.entry.geo, previous.tris, false);
    this.highlighted = null;
    const entry = tris && tris.length > 0 ? this.objects.find((o) => o.index === objectIndex) : undefined;
    if (entry && tris) {
      setTriangleHighlight(entry.geo, tris, true);
      this.highlighted = { entry, tris };
    }
    if (previous || this.highlighted) this.requestRender();
  }

  isRegionHighlighted(objectIndex: number, tri: number): boolean {
    const h = this.highlighted;
    return !!h && h.entry.index === objectIndex && isTriangleHighlighted(h.entry.geo, tri);
  }

  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => { this.viewListeners.delete(listener); };
  }

  setCursor(cursor: string): void {
    this.canvas.style.cursor = cursor;
  }

  // --- internals -----------------------------------------------------------------

  /**
   * The visibility test for the current camera pose. The depth image is rendered once per
   * pose and scene change and reused, so a stroke pays for it once, not per dab.
   */
  private visibility(): VisibilityTest {
    this.camera.updateMatrixWorld(true);
    if (this.depth && this.poseUnchanged()) return this.depth;
    const frame = this.depthPass.render(this.renderer, this.scene, this.camera, Math.max(1, this.container.clientWidth), Math.max(1, this.container.clientHeight));
    const p = this.camera.position;
    const test = new VisibilityTest(frame, {
      view: Array.from(this.camera.matrixWorldInverse.elements),
      proj: Array.from(this.camera.projectionMatrix.elements),
      eye: [p.x, p.y, p.z],
    });
    this.depth = test;
    this.storePose();
    return test;
  }

  /** Compares the current pose with the cached one without allocating (this runs on every dab). */
  private poseUnchanged(): boolean {
    const pose = this.depthPose, m = this.camera.matrixWorld.elements, p = this.camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) if (pose[i] !== m[i] || pose[16 + i] !== p[i]) return false;
    return pose[32] === this.container.clientWidth && pose[33] === this.container.clientHeight && pose[34] === this.sceneEpoch;
  }

  private storePose(): void {
    const pose = this.depthPose, m = this.camera.matrixWorld.elements, p = this.camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) { pose[i] = m[i]; pose[16 + i] = p[i]; }
    pose[32] = this.container.clientWidth;
    pose[33] = this.container.clientHeight;
    pose[34] = this.sceneEpoch;
  }

  /** Builds the spatial indexes one object per task, after the first frame, so loading does not stall on them. */
  private buildPickersSoon(): void {
    const token = ++this.pickerToken;
    clearTimeout(this.pickerTimer);
    const pending = [...this.objects];
    const next = () => {
      if (this.disposed || token !== this.pickerToken) return;
      const entry = pending.shift();
      if (!entry) return;
      try {
        entry.picker = new ObjectPicker(entry.geo.geometry, entry.geo.slotOfTri, entry.geo.slotCount);
      } catch (error) {
        this.onError(error);
      }
      this.pickerTimer = window.setTimeout(next, 0);
    };
    // A short delay lets the browser paint the model before the first (blocking) build.
    this.pickerTimer = window.setTimeout(next, 50);
  }

  private clearObjects(): void {
    this.pickerToken++;
    clearTimeout(this.pickerTimer);
    this.highlighted = null;
    this.depth = null;
    this.sceneEpoch++;
    for (const o of this.objects) {
      this.scene.remove(o.mesh);
      o.geo.geometry.dispose();
    }
    this.objects = [];
    this.colors.setScene(null);
    this.brushCursor.hide();
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
    this.notifyViewChange();
  }

  private notifyViewChange(): void {
    for (const l of [...this.viewListeners]) l();
  }

  private readonly onControlsChange = (): void => {
    this.requestRender();
    this.notifyViewChange();
  };

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
