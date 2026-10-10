// Phase 5 spike: three ways to draw sub-triangle paint, on a real file.
//   dominant: today's view (one state per triangle);
//   tree:     triangles keep their 3 vertices, the fragment shader walks the split tree (flatten.ts);
//   leaves:   every leaf becomes a real triangle (only with ?leaves=1, it can be large).
// http://localhost:5180/spike/subtri/?file=/@fs/D:/Downloads/goldfish_colormix_4t.3mf
import {
  BufferAttribute, BufferGeometry, DataTexture, GLSL3, Mesh, PerspectiveCamera, RedIntegerFormat, RGBAFormat,
  Scene, ShaderMaterial, UnsignedByteType, UnsignedIntType, Vector3, WebGLRenderer, Color,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { applyTransform, hexToRgb, load3MF, parseTransform } from "../../src/core";
import { parsePaintTree } from "../../src/core/paint/codec";
import { appendTree } from "./flatten";
import { leaves, PRUSA, type Bary } from "./splitGeometry";

const log = (s: string) => { document.getElementById("log")!.textContent += s + "\n"; console.log(s); };
const params = new URLSearchParams(location.search);
const TREE_TAG = 65536;

const vertexShader = /* glsl */ `
in float tag;
flat out uint vTag;
out vec3 vBary;
out vec3 vViewPos;
void main() {
  vTag = uint(tag + 0.5);
  int k = gl_VertexID % 3;
  vBary = vec3(k == 0 ? 1.0 : 0.0, k == 1 ? 1.0 : 0.0, k == 2 ? 1.0 : 0.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const fragmentShader = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D nodes;
uniform sampler2D palette;
flat in uint vTag;
in vec3 vBary;
in vec3 vViewPos;
out vec4 outColor;

uint node(uint i) { return texelFetch(nodes, ivec2(int(i & 4095u), int(i >> 12u)), 0).r; }

// Smallest barycentric coordinate of p in triangle abc (all in the root's barycentrics, y/z as a plane).
float minLocal(vec3 p, vec3 a, vec3 b, vec3 c) {
  vec2 v0 = b.yz - a.yz, v1 = c.yz - a.yz, q = p.yz - a.yz;
  float den = v0.x * v1.y - v1.x * v0.y;
  float u = (q.x * v1.y - v1.x * q.y) / den, w = (v0.x * q.y - q.x * v0.y) / den;
  return min(min(1.0 - u - w, u), w);
}

void main() {
  uint state = vTag;
  if (vTag >= ${TREE_TAG}u) {
    uint word = node(vTag - ${TREE_TAG}u);
    vec3 A = vec3(1, 0, 0), B = vec3(0, 1, 0), C = vec3(0, 0, 1);
    for (int depth = 0; depth < 24; depth++) {
      if ((word & 0x80000000u) == 0u) break;
      uint sides = (word >> 29u) & 3u, special = (word >> 27u) & 3u, first = word & 0x7FFFFFFu;
      vec3 r0 = special == 0u ? A : special == 1u ? B : C;
      vec3 r1 = special == 0u ? B : special == 1u ? C : A;
      vec3 r2 = special == 0u ? C : special == 1u ? A : B;
      vec3 ca[4], cb[4], cc[4];
      int n;
      if (sides == 1u) {
        vec3 m = (r1 + r2) * 0.5;
        ca[0] = r0; cb[0] = r1; cc[0] = m;
        ca[1] = m;  cb[1] = r2; cc[1] = r0;
        n = 2;
      } else if (sides == 2u) {
        vec3 m1 = (r0 + r1) * 0.5, m2 = (r0 + r2) * 0.5;
        ca[0] = r0; cb[0] = m1; cc[0] = m2;
        ca[1] = m1; cb[1] = r1; cc[1] = m2;
        ca[2] = r1; cb[2] = r2; cc[2] = m2;
        n = 3;
      } else {
        vec3 m01 = (r0 + r1) * 0.5, m12 = (r1 + r2) * 0.5, m20 = (r2 + r0) * 0.5;
        ca[0] = r0;  cb[0] = m01; cc[0] = m20;
        ca[1] = m01; cb[1] = r1;  cc[1] = m12;
        ca[2] = m12; cb[2] = r2;  cc[2] = m20;
        ca[3] = m01; cb[3] = m12; cc[3] = m20;
        n = 4;
      }
      int best = 0;
      float bestMin = -1e9;
      for (int i = 0; i < 4; i++) {
        if (i >= n) break;
        float m = minLocal(vBary, ca[i], cb[i], cc[i]);
        if (m > bestMin) { bestMin = m; best = i; }
      }
      A = ca[best]; B = cb[best]; C = cc[best];
      word = node(first + uint(best));
    }
    state = word;
  }
  vec3 col = texelFetch(palette, ivec2(int(state & 255u), 0), 0).rgb;
  vec3 nrm = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  float light = 0.35 + 0.65 * abs(dot(nrm, normalize(vec3(0.3, 0.5, 1.0))));
  outColor = vec4(col * light, 1.0);
}`;

async function main() {
  const file = params.get("file");
  if (!file) { log("?file=/@fs/<path to a .3mf>"); return; }
  const t0 = performance.now();
  const bytes = new Uint8Array(await (await fetch(file)).arrayBuffer());
  const model = await load3MF(bytes);
  log(`${file}: ${model.totalTris} tris, load ${(performance.now() - t0).toFixed(0)} ms`);

  // Palette: state -> color; 0 shows the first object's base color.
  const pal = new Uint8Array(256 * 4).fill(255);
  model.filaments.forEach((f) => { const [r, g, b] = hexToRgb(f.color); pal.set([r * 255, g * 255, b * 255, 255], f.index * 4); });
  const base = model.objects[0].defaultExtruder;
  pal.set(pal.slice(base * 4, base * 4 + 4), 0);
  const palette = new DataTexture(pal, 256, 1, RGBAFormat, UnsignedByteType);
  palette.needsUpdate = true;

  // Positions (world), dominant tags and tree tags for the same non-indexed triangles.
  const t1 = performance.now();
  let n = 0;
  for (const o of model.objects) n += o.tris.length / 3;
  const position = new Float32Array(n * 9), dominant = new Float32Array(n * 3), treeTag = new Float32Array(n * 3);
  const nodes: number[] = [];
  const leafTris: { o: number; t: number }[] = [];
  const splitSlots: [number, number][] = []; // slot, leaf count
  let slot = 0, splitCount = 0;
  model.objects.forEach((o, oi) => {
    const tf = parseTransform(o.transform);
    for (let t = 0; t < o.tris.length / 3; t++, slot++) {
      for (let k = 0; k < 3; k++) {
        const v = o.tris[t * 3 + k];
        position.set(applyTransform(tf, o.vertices[v * 3], o.vertices[v * 3 + 1], o.vertices[v * 3 + 2]), slot * 9 + k * 3);
      }
      dominant.fill(o.triState[t], slot * 3, slot * 3 + 3);
      const p = o.paints[t];
      let tag = o.triState[t];
      if (p && p.length > 1) {
        const tree = parsePaintTree(p, model.paintDialect);
        if ("children" in tree) { tag = TREE_TAG + appendTree(nodes, tree); splitCount++; leafTris.push({ o: oi, t }); splitSlots.push([slot, leaves(tree, PRUSA).length]); }
      }
      treeTag.fill(tag, slot * 3, slot * 3 + 3);
    }
  });
  const width = 4096, height = Math.max(1, Math.ceil(nodes.length / width));
  const nodeData = new Uint32Array(width * height);
  nodeData.set(nodes);
  const nodeTex = new DataTexture(nodeData, width, height, RedIntegerFormat, UnsignedIntType);
  nodeTex.internalFormat = "R32UI";
  nodeTex.needsUpdate = true;
  log(`geometry + flatten ${(performance.now() - t1).toFixed(0)} ms: ${splitCount} split tris, ${nodes.length} nodes (${(nodeData.byteLength / 1e6).toFixed(1)} MB texture ${width}x${height})`);

  const material = new ShaderMaterial({ glslVersion: GLSL3, vertexShader, fragmentShader, uniforms: { nodes: { value: nodeTex }, palette: { value: palette } } });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  const tagAttr = new BufferAttribute(treeTag, 1);
  geometry.setAttribute("tag", tagAttr);
  geometry.computeBoundingSphere();

  let leafGeometry: BufferGeometry | null = null;
  if (params.get("leaves")) {
    const t2 = performance.now();
    const tris: number[] = [];
    const tags: number[] = [];
    // Unsplit triangles as they are, split ones as their leaves.
    const splitSet = new Set(leafTris.map(({ o, t }) => `${o}:${t}`));
    let s = 0;
    model.objects.forEach((o, oi) => {
      for (let t = 0; t < o.tris.length / 3; t++, s++) {
        const corner = (k: number) => [position[s * 9 + k * 3], position[s * 9 + k * 3 + 1], position[s * 9 + k * 3 + 2]];
        if (!splitSet.has(`${oi}:${t}`)) { for (let k = 0; k < 3; k++) tris.push(...corner(k)); tags.push(o.triState[t], o.triState[t], o.triState[t]); continue; }
        const c = [corner(0), corner(1), corner(2)];
        const at = (b: Bary) => [0, 1, 2].map((d) => c[0][d] * b[0] + c[1][d] * b[1] + c[2][d] * b[2]);
        for (const l of leaves(parsePaintTree(o.paints[t]!, model.paintDialect), PRUSA)) {
          for (const b of l.tri) tris.push(...at(b));
          tags.push(l.state, l.state, l.state);
        }
      }
    });
    leafGeometry = new BufferGeometry();
    leafGeometry.setAttribute("position", new BufferAttribute(new Float32Array(tris), 3));
    leafGeometry.setAttribute("tag", new BufferAttribute(new Float32Array(tags), 1));
    leafGeometry.computeBoundingSphere();
    log(`leaf mesh ${(performance.now() - t2).toFixed(0)} ms: ${tags.length / 3} triangles (${((tris.length * 4 + tags.length * 4) / 1e6).toFixed(0)} MB)`);
  }

  const view = document.getElementById("view")!;
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(view.clientWidth, view.clientHeight);
  view.appendChild(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(0x202020);
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  const sphere = geometry.boundingSphere!;
  const camera = new PerspectiveCamera(40, view.clientWidth / view.clientHeight, sphere.radius / 100, sphere.radius * 20);
  camera.position.copy(sphere.center).add(new Vector3(0, -sphere.radius * 2.6, sphere.radius * 0.8));
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(sphere.center);
  controls.update();
  let mode = "tree";
  const setMode = (m: string) => {
    mode = m;
    if (m === "leaves") {
      if (!leafGeometry) { log("leaf mesh needs ?leaves=1"); return; }
      mesh.geometry = leafGeometry;
    } else {
      mesh.geometry = geometry;
      tagAttr.array = m === "dominant" ? dominant : treeTag;
      tagAttr.needsUpdate = true;
    }
    log(`mode ${m}`);
  };
  document.querySelectorAll<HTMLButtonElement>("button[data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode!)));
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  const bench = () => {
    // Synchronous frames (readPixels waits for the GPU), orbiting once around the model.
    const start = camera.position.clone(), frames = 60;
    const times: number[] = [];
    for (let i = 0; i < frames; i++) {
      const a = (i / frames) * Math.PI * 2;
      const off = start.clone().sub(sphere.center);
      camera.position.set(sphere.center.x + off.x * Math.cos(a) - off.y * Math.sin(a), sphere.center.y + off.x * Math.sin(a) + off.y * Math.cos(a), start.z);
      camera.lookAt(sphere.center);
      const f0 = performance.now();
      renderer.render(scene, camera);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      times.push(performance.now() - f0);
    }
    camera.position.copy(start);
    camera.lookAt(sphere.center);
    times.sort((x, y) => x - y);
    log(`bench ${mode} at ${renderer.domElement.width}x${renderer.domElement.height}: median ${times[frames >> 1].toFixed(1)} ms, p90 ${times[Math.floor(frames * 0.9)].toFixed(1)} ms per frame`);
  };
  document.getElementById("bench")!.addEventListener("click", bench);
  // Looks straight at the split triangle with the rank-th most leaves, from `dist` (world mm).
  const ranked = [...splitSlots].sort((x, y) => y[1] - x[1]);
  const focus = (rank: number, dist: number) => {
    const [s, count] = ranked[rank];
    const c = [0, 1, 2].map((k) => new Vector3(position[s * 9 + k * 3], position[s * 9 + k * 3 + 1], position[s * 9 + k * 3 + 2]));
    const center = c[0].clone().add(c[1]).add(c[2]).multiplyScalar(1 / 3);
    const normal = c[1].clone().sub(c[0]).cross(c[2].clone().sub(c[0])).normalize();
    camera.position.copy(center).addScaledVector(normal, dist);
    controls.target.copy(center);
    controls.update();
    sphere.center.copy(center); // the benchmark orbits around this
    return `slot ${s}: ${count} leaves, edge ${c[0].distanceTo(c[1]).toFixed(2)} mm`;
  };
  // Share of pixels that differ (any channel by more than 2/255) between two modes, same camera.
  const grab = (m: string) => {
    setMode(m);
    renderer.render(scene, camera);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const compare = (a: string, b: string) => {
    const x = grab(a), y = grab(b);
    let diff = 0;
    for (let i = 0; i < x.length; i += 4) {
      if (Math.abs(x[i] - y[i]) > 2 || Math.abs(x[i + 1] - y[i + 1]) > 2 || Math.abs(x[i + 2] - y[i + 2]) > 2) diff++;
    }
    return `${a} vs ${b}: ${diff} of ${x.length / 4} pixels differ (${((diff / (x.length / 4)) * 100).toFixed(3)}%)`;
  };
  (window as unknown as { spike: unknown }).spike = { bench, setMode, camera, controls, sphere, focus, compare };
  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  log("ready");
}

main().catch((e) => log(String(e?.stack ?? e)));
