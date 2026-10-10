// Session setup, render loop and mode switching.
//
// M0 scope: load a site, render terrain and skirt, fly or walk over it in desktop mode.
import * as THREE from 'three';
import { loadSite, buildTerrain } from './terrain.js';
import { loadSettings, saveSettings } from './settings.js';
import { DesktopInput } from './input.js';
import { gridAzimuth } from './coords.js';

const params = new URLSearchParams(location.search);
const siteId = params.get('site') || 'demo-synthetic';
const debug = params.has('debug');

const settings = loadSettings();
const hud = document.getElementById('hud');
const status = document.getElementById('status');
const help = document.getElementById('help');

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('error', isError);
  status.hidden = !text;
}

// WebGLRenderer is the proven WebXR path on the Quest Browser. The spec allows
// WebGPURenderer, but nothing here needs it; revisit once XR is verified on-device.
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xaec6dc);
scene.background = SKY;

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 9000);
camera.rotation.order = 'YXZ';

scene.add(new THREE.HemisphereLight(0xdfe9f3, 0x3a3626, 0.55));
// Low-ish sun from the south-west so slopes read clearly. No shadows in v1.
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.position.set(-0.55, 0.55, 0.62).multiplyScalar(1000);
scene.add(sun);

function applyPreset() {
  scene.fog = settings.preset === 'woods'
    ? new THREE.Fog(SKY, settings.woodsVisibility * 0.15, settings.woodsVisibility)
    : null;
}
applyPreset();

const input = new DesktopInput(renderer.domElement, settings);
let fly = true;
let terrain = null;
let boundaryWarning = '';

input.on('toggleFly', () => {
  fly = !fly;
  if (!fly && terrain) clampToBoundary();
});
input.on('togglePreset', () => {
  settings.preset = settings.preset === 'woods' ? 'open' : 'woods';
  applyPreset();
  saveSettings(settings);
});
input.on('help', () => { help.hidden = !help.hidden; });

function clampToBoundary() {
  const s = terrain.size;
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, 0, s);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, 0, s);
}

const forward = new THREE.Vector3();
const right = new THREE.Vector3();

function update(dt) {
  camera.rotation.set(input.pitch, input.yaw, 0);
  const axes = input.moveAxes();

  // Horizontal heading from yaw only, so looking down doesn't slow you down.
  forward.set(-Math.sin(input.yaw), 0, -Math.cos(input.yaw));
  right.set(-forward.z, 0, forward.x);

  if (fly) {
    const speed = settings.flySpeed * (input.isDown('fast') ? settings.flyFastMultiplier : 1);
    camera.position.addScaledVector(forward, axes.z * speed * dt);
    camera.position.addScaledVector(right, axes.x * speed * dt);
    camera.position.y += axes.y * speed * dt;
    const floor = terrain.heightAt(camera.position.x, camera.position.z) + 0.5;
    if (camera.position.y < floor) camera.position.y = floor;
    boundaryWarning = '';
  } else {
    const len = Math.hypot(axes.x, axes.z);
    if (len > 0) {
      const speed = settings.baseSpeed * settings.timeScale * (input.isDown('fast') ? 4 : 1);
      camera.position.addScaledVector(forward, (axes.z / len) * speed * dt);
      camera.position.addScaledVector(right, (axes.x / len) * speed * dt);
    }
    clampToBoundary();
    const { x, z } = camera.position;
    camera.position.y = terrain.heightAt(x, z) + settings.eyeHeight;
    const edge = Math.min(x, z, terrain.size - x, terrain.size - z);
    boundaryWarning = edge <= settings.boundaryWarn
      ? (edge <= 0.01 ? 'Boundary. You cannot go farther.' : 'Approaching the boundary.')
      : '';
  }
}

let frames = 0;
let fpsTime = 0;
let fps = 0;

function updateHud(dt) {
  frames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    fps = frames / fpsTime;
    frames = 0;
    fpsTime = 0;
  }
  const info = renderer.info.render;
  const lines = [
    `${fly ? 'FLY' : 'WALK'}  ${settings.preset}  ${fps.toFixed(0)} fps  ${info.calls} calls  ${(info.triangles / 1000).toFixed(0)}k tris`,
  ];
  // Never show the true position during a run. Debug builds only.
  if (debug) {
    const p = camera.position;
    const heading = gridAzimuth(-Math.sin(input.yaw), -Math.cos(input.yaw));
    lines.push(`x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}  y ${p.y.toFixed(1)}  grid az ${heading.toFixed(1)}`);
  }
  if (boundaryWarning) lines.push(boundaryWarning);
  if (!input.locked) lines.push('Click to look around. H for help.');
  hud.textContent = lines.join('\n');
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

async function start() {
  setStatus(`Loading site "${siteId}" ...`);
  const data = await loadSite(`sites/${encodeURIComponent(siteId)}`);
  terrain = buildTerrain(renderer, data);
  scene.add(terrain.group);
  document.title = `${data.site.name} | Land Nav`;

  // Start above the south edge, looking north across the area.
  const s = terrain.size;
  camera.position.set(s / 2, 0, s + 400);
  camera.position.y = data.site.elev_max - data.site.elev_ref + 350;
  input.pitch = -0.32;
  setStatus('');

  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);
    update(dt);
    renderer.render(scene, camera);
    updateHud(dt);
  });

  // Exposed for automated checks and console poking. Not a gameplay API.
  window.__landnav = { camera, terrain, site: data.site, renderer, scene, settings };
}

start().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err.message}`, true);
});
