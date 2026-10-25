import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const isMobile = matchMedia('(pointer: coarse)').matches;

// ---- scene ----
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 2 : 3));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
camera.add(sun);
scene.add(camera);

const bgs = [0x0f1115, 0x2b2f38, 0xeeeeee, 0x000000];
let bgIdx = 0;
scene.background = new THREE.Color(bgs[0]);

let model = null;       // THREE.Group (rotated for Z-up)
let object = null;      // Points or Mesh
let zUp = true;
let radius = 1;
let dirty = true;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dirty = true;
}
addEventListener('resize', resize);
resize();
controls.addEventListener('change', () => (dirty = true));
(function loop() {
  requestAnimationFrame(loop);
  if (controls.update() || dirty) { renderer.render(scene, camera); dirty = false; }
})();

function resetView() {
  const d = radius * 2.4;
  camera.position.set(d * 0.6, d * 0.45, d * 0.8);
  camera.near = radius / 500;
  camera.far = radius * 50;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
  dirty = true;
}

function applyUp() {
  if (model) model.rotation.x = zUp ? -Math.PI / 2 : 0;
  $('up').textContent = zUp ? 'Z-up' : 'Y-up';
  dirty = true;
}

function heightColors(positions, bbox) {
  const c = new Uint8Array(positions.length);
  const z0 = bbox.min[2], dz = Math.max(1e-9, bbox.max[2] - z0);
  for (let i = 0; i < positions.length; i += 3) {
    const t = (positions[i + 2] - z0) / dz; // blue -> green -> yellow -> red
    const h = (1 - t) * 240 / 360;
    const k = (n) => (n + h * 6) % 6;
    const f = (n) => 0.9 - 0.9 * 0.85 * Math.max(0, Math.min(k(n), 4 - k(n), 1));
    c[i] = f(5) * 255 + 25; c[i + 1] = f(3) * 255 + 25; c[i + 2] = f(1) * 255 + 25;
  }
  return c;
}

function showModel(res) {
  if (model) {
    scene.remove(model);
    object.geometry.dispose();
    object.material.dispose();
  }
  const { bbox } = res;
  const center = bbox.min.map((v, i) => (v + bbox.max[i]) / 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(res.positions, 3));
  const colors = res.colors || heightColors(res.positions, bbox);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  geo.translate(-center[0], -center[1], -center[2]);
  radius = Math.max(1e-6, Math.hypot(...bbox.max.map((v, i) => v - bbox.min[i])) / 2);
  if (res.indices && res.indices.length) {
    geo.setIndex(new THREE.BufferAttribute(res.indices, 1));
    geo.computeVertexNormals();
    object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: res.hasColor, color: res.hasColor ? 0xffffff : 0xb8c4d6, roughness: 0.85, metalness: 0,
      side: THREE.DoubleSide,
    }));
  } else {
    object = new THREE.Points(geo, new THREE.PointsMaterial({
      size: +$('size').value, sizeAttenuation: false, vertexColors: true,
    }));
  }
  model = new THREE.Group();
  model.add(object);
  scene.add(model);
  $('size').hidden = object.isMesh;
  applyUp();
  resetView();
}

// ---- loading ----
let worker = null;
const fmtN = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + ' M' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' k' : '' + n;
const fmtB = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(0) + ' MB';

function load(input, label) {
  $('err').textContent = '';
  $('progress').hidden = false;
  $('bar').style.width = '0%';
  $('status').textContent = 'Starting…';
  if (worker) worker.terminate();
  worker = new Worker('./ply-worker.js', { type: 'module' });
  const budget = +$('budget').value;
  const opts = { budget, meshVertexLimit: Math.min(budget, 4e6), meshFaceLimit: Math.min(budget * 2, 8e6) };
  const t0 = performance.now();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      $('bar').style.width = (m.f * 100).toFixed(0) + '%';
      $('status').textContent = `${label} — ${m.msg} ${(m.f * 100).toFixed(0)}%`;
    } else if (m.type === 'done') {
      const r = m.res;
      showModel(r);
      $('menu').hidden = true;
      $('hud').style.display = 'flex';
      const kind = r.indices ? `mesh, ${fmtN(r.indices.length / 3)} triangles` : 'points';
      $('info').style.display = 'block';
      $('info').textContent = `${label} · ${fmtB(m.fileSize)} · ${fmtN(r.shownVertices)} of ${fmtN(r.totalVertices)} vertices` +
        (r.step > 1 ? ` (every ${r.step}th)` : '') + ` · ${kind} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      worker.terminate(); worker = null;
    } else {
      fail(m.message);
    }
  };
  worker.onerror = (e) => fail(e.message || 'Worker failed (is this page served over http(s)?)');
  worker.postMessage(input.file ? { file: input.file, opts } : { url: input.url, opts });
}

function fail(msg) {
  $('err').textContent = msg + (/memory|allocation|array/i.test(msg) ? '\nTry a lower "Max points" value.' : '');
  $('progress').hidden = true;
  if (worker) { worker.terminate(); worker = null; }
}

$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) load({ file: f }, f.name);
  e.target.value = '';
});
$('loadUrl').onclick = () => {
  const u = $('url').value.trim();
  if (u) load({ url: u }, u.split('/').pop().split('?')[0] || 'remote file');
};
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) load({ file: f }, f.name);
});

// ---- hud ----
$('budget').value = isMobile ? '2000000' : '8000000';
$('open').onclick = () => { $('menu').hidden = false; $('progress').hidden = true; };
$('up').onclick = () => { zUp = !zUp; applyUp(); resetView(); };
$('bg').onclick = () => { bgIdx = (bgIdx + 1) % bgs.length; scene.background.set(bgs[bgIdx]); dirty = true; };
$('reset').onclick = resetView;
$('size').oninput = (e) => {
  if (object && object.isPoints) { object.material.size = +e.target.value; dirty = true; }
};

// ?url=https://... auto-load (for sharing a model hosted elsewhere)
const qurl = new URLSearchParams(location.search).get('url');
if (qurl) { $('url').value = qurl; $('loadUrl').click(); }
