// Session setup, render loop and mode switching.
//
// The camera lives inside a `player` rig. On desktop the rig sits on the ground and
// the camera is lifted to eye height. In VR the headset pose is relative to the rig
// (local-floor), so the rig sits on the ground under the head and the user's real
// height does the rest.
import * as THREE from 'three';
import { loadSite, buildTerrain } from './terrain.js';
import { loadSettings, saveSettings } from './settings.js';
import { DesktopInput, XRInput } from './input.js';
import { Locomotion } from './locomotion.js';
import { Footfalls } from './footfalls.js';
import { createVignette } from './vignette.js';
import { buildSettingsPanel, setupVRButton } from './ui.js';
import { gridAzimuth } from './coords.js';

const params = new URLSearchParams(location.search);
const siteId = params.get('site') || 'demo-synthetic';
const debug = params.has('debug');

const settings = loadSettings();
const hud = document.getElementById('hud');
const status = document.getElementById('status');
const help = document.getElementById('help');
const panel = document.getElementById('settings');
const vrButton = document.getElementById('vr');

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
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(1); // fixed foveated rendering (spec section 11)
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xaec6dc);
scene.background = SKY;

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 9000);
camera.rotation.order = 'YXZ';
const player = new THREE.Group();
player.name = 'player';
player.add(camera);
scene.add(player);

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
const xrInput = new XRInput(renderer, settings);
const loco = new Locomotion(settings);
const footfalls = new Footfalls(settings);
const vignette = createVignette();
camera.add(vignette.mesh);

let fly = false;
let terrain = null;
let boundaryWarning = '';

// ---- Controllers: simple stand-ins at the grip pose ----

const debugPanel = debug ? createDebugPanel() : null;
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.022, 0.11, 12).rotateX(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x2b2e33 }),
  );
  grip.add(body);
  grip.addEventListener('connected', (e) => {
    grip.userData.handedness = e.data.handedness;
    if (debugPanel && e.data.handedness === 'left') grip.add(debugPanel.mesh);
  });
  player.add(grip);
}

// ---- Desktop controls ----

input.on('toggleFly', () => {
  if (renderer.xr.isPresenting) return;
  fly = !fly;
  // Keep the eye where it was: the camera offset moves between rig and camera.
  if (fly) player.position.y += settings.eyeHeight;
  placeDesktopCamera();
  if (!fly && terrain) snapPlayerToGround();
});
input.on('togglePreset', () => {
  settings.preset = settings.preset === 'woods' ? 'open' : 'woods';
  applyPreset();
  saveSettings(settings);
});
input.on('help', () => { help.hidden = !help.hidden; });
addEventListener('keydown', (e) => {
  footfalls.unlock();
  if (e.code === 'KeyP' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) togglePanel();
});
renderer.domElement.addEventListener('click', () => footfalls.unlock());
document.getElementById('settings-button').addEventListener('click', togglePanel);

function togglePanel() {
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    help.hidden = true; // they share the right edge
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
buildSettingsPanel(panel, settings, (key) => {
  if (key === 'paceCountPer100m') loco.pace.reset();
});

function placeDesktopCamera() {
  camera.position.set(0, fly ? 0 : settings.eyeHeight, 0);
}

function snapPlayerToGround() {
  const s = terrain.size;
  player.position.x = THREE.MathUtils.clamp(player.position.x, 0, s);
  player.position.z = THREE.MathUtils.clamp(player.position.z, 0, s);
  player.position.y = terrain.heightAt(player.position.x, player.position.z);
}

function updateBoundaryWarning(x, z) {
  const edge = Math.min(x, z, terrain.size - x, terrain.size - z);
  boundaryWarning = edge <= settings.boundaryWarn
    ? (edge <= 0.01 ? 'Boundary. You cannot go farther.' : 'Approaching the boundary.')
    : '';
}

// ---- Per-frame update ----

const fwd = new THREE.Vector3();
const head = new THREE.Vector3();
const lastHeading = new THREE.Vector3(0, 0, -1);
let snapArmed = true;

function playFeet(feet, haptics) {
  for (const foot of feet) footfalls.play(foot, haptics);
}

function updateDesktop(dt) {
  camera.rotation.set(input.pitch, input.yaw, 0);
  const axes = input.moveAxes();
  // Heading from yaw only, so looking down doesn't slow you down.
  const fx = -Math.sin(input.yaw), fz = -Math.cos(input.yaw);
  const rx = -fz, rz = fx;
  const dirX = fx * axes.z + rx * axes.x;
  const dirZ = fz * axes.z + rz * axes.x;

  if (fly) {
    const speed = settings.flySpeed * (input.isDown('fast') ? settings.flyFastMultiplier : 1);
    const len = Math.hypot(dirX, dirZ) || 1;
    player.position.x += (dirX / len) * speed * dt * Math.min(1, Math.hypot(dirX, dirZ));
    player.position.z += (dirZ / len) * speed * dt * Math.min(1, Math.hypot(dirX, dirZ));
    player.position.y += axes.y * speed * dt;
    const floor = terrain.heightAt(player.position.x, player.position.z) + 0.5;
    if (player.position.y < floor) player.position.y = floor;
    boundaryWarning = '';
    return;
  }

  const step = loco.step(dt, terrain, player.position.x, player.position.z, dirX, dirZ, 1);
  player.position.x += step.dx;
  player.position.z += step.dz;
  player.position.y = terrain.heightAt(player.position.x, player.position.z);
  playFeet(step.feet);
  updateBoundaryWarning(player.position.x, player.position.z);
}

function updateXR(dt) {
  xrInput.update();

  // Head position and horizontal facing from last frame's pose.
  camera.getWorldPosition(head);
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() > 1e-4) lastHeading.copy(fwd.normalize());
  else fwd.copy(lastHeading); // looking straight down: keep the previous heading

  // Left stick moves in the direction the head is facing.
  const stick = xrInput.stick('left');
  const rx = -fwd.z, rz = fwd.x;
  const dirX = fwd.x * stick.y + rx * stick.x;
  const dirZ = fwd.z * stick.y + rz * stick.x;
  const step = loco.step(dt, terrain, head.x, head.z, dirX, dirZ, stick.mag);
  player.position.x += step.dx;
  player.position.z += step.dz;
  head.x += step.dx;
  head.z += step.dz;
  playFeet(step.feet, (hand, strength, ms) => xrInput.pulse(hand, strength, ms));

  // Physical walking in the room can carry the head past the edge; push the rig back.
  const s = terrain.size;
  const cx = THREE.MathUtils.clamp(head.x, 0, s);
  const cz = THREE.MathUtils.clamp(head.z, 0, s);
  player.position.x += cx - head.x;
  player.position.z += cz - head.z;
  head.x = cx;
  head.z = cz;

  // Stand on the ground under the head.
  player.position.y = terrain.heightAt(head.x, head.z);

  // Snap turn (off by default): rotate the rig about the head.
  if (settings.snapTurn) {
    const sx = xrInput.stick('right').x;
    if (snapArmed && Math.abs(sx) > 0.7) {
      snapArmed = false;
      const a = THREE.MathUtils.degToRad(settings.snapTurnDeg) * (sx > 0 ? -1 : 1);
      const ox = player.position.x - head.x, oz = player.position.z - head.z;
      const c = Math.cos(a), sn = Math.sin(a);
      player.position.x = head.x + ox * c + oz * sn;
      player.position.z = head.z - ox * sn + oz * c;
      player.rotation.y += a;
    } else if (Math.abs(sx) < 0.3) {
      snapArmed = true;
    }
  }

  const full = settings.baseSpeed * settings.timeScale;
  vignette.update(settings.vignette * Math.min(1, loco.lastSpeed / full), dt);
  updateBoundaryWarning(head.x, head.z);
}

// ---- VR session ----

async function enterVR() {
  footfalls.unlock();
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    // Face the way the desktop camera was facing; the headset supplies pitch.
    player.rotation.set(0, input.yaw, 0);
    fly = false;
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
    snapPlayerToGround();
    session.addEventListener('end', exitVR);
    await renderer.xr.setSession(session);
    vrButton.textContent = 'Exit VR';
  } catch (err) {
    console.error(err);
    setStatus(`Could not start VR: ${err.message}`, true);
    setTimeout(() => setStatus(''), 4000);
  }
}

function exitVR() {
  // Carry the head's position and heading back into desktop mode.
  camera.getWorldPosition(head);
  camera.getWorldDirection(fwd);
  input.yaw = Math.atan2(-fwd.x, -fwd.z);
  input.pitch = 0;
  player.rotation.set(0, 0, 0);
  player.position.x = head.x;
  player.position.z = head.z;
  placeDesktopCamera();
  snapPlayerToGround();
  vignette.update(0, 1);
  vrButton.textContent = 'Enter VR';
}

vrButton.addEventListener('click', () => {
  const session = renderer.xr.getSession();
  if (session) session.end();
});

// ---- HUD ----

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
  const mode = fly ? 'FLY' : 'WALK';
  const lines = [
    `${mode}  ${settings.preset}  ${fps.toFixed(0)} fps  ${info.calls} calls  ${(info.triangles / 1000).toFixed(0)}k tris`,
  ];
  // Never show the true position or the pace count during a run. Debug only.
  if (debug) {
    const p = player.position;
    const heading = gridAzimuth(-Math.sin(input.yaw), -Math.cos(input.yaw));
    lines.push(`x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}  ground ${p.y.toFixed(1)}  grid az ${heading.toFixed(1)}`);
    lines.push(`walked ${loco.pace.distance.toFixed(1)} m  paces ${loco.pace.leftCount}  grade ${(loco.lastGrade * 100).toFixed(0)}%`);
  }
  if (boundaryWarning) lines.push(boundaryWarning);
  if (!input.locked && !renderer.xr.isPresenting) lines.push('Click to look around. H for help, P for settings.');
  hud.textContent = lines.join('\n');
  debugPanel?.update(loco, boundaryWarning);
}

// Debug-only wrist readout in VR, so the pace acceptance test can be checked in the headset.
function createDebugPanel() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.12, 0.045),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  );
  mesh.position.set(0, 0.035, 0.03);
  mesh.rotation.x = -Math.PI / 3;
  let last = '';
  return {
    mesh,
    update(l, warn) {
      const text = `${l.pace.distance.toFixed(1)} m  ${l.pace.leftCount} paces|${warn || `grade ${(l.lastGrade * 100).toFixed(0)}%`}`;
      if (text === last) return;
      last = text;
      const [a, b] = text.split('|');
      ctx.fillStyle = 'rgba(15,17,20,0.85)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffd27a';
      ctx.font = 'bold 64px system-ui, sans-serif';
      ctx.fillText(a, 20, 80);
      ctx.fillStyle = '#ddd';
      ctx.font = '44px system-ui, sans-serif';
      ctx.fillText(b, 20, 155);
      tex.needsUpdate = true;
    },
  };
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

  // Start on the ground in the middle of the area, facing grid north.
  // (Courses supply a start point from M3.)
  const s = terrain.size;
  player.position.set(s / 2, 0, s / 2);
  if (debug && params.get('start')) {
    const [x, z] = params.get('start').split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(z)) player.position.set(x, 0, z);
  }
  placeDesktopCamera();
  snapPlayerToGround();
  setStatus('');
  setupVRButton(vrButton, { onRequest: () => { if (!renderer.xr.isPresenting) enterVR(); } });

  const timer = new THREE.Timer();
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);
    if (renderer.xr.isPresenting) updateXR(dt);
    else updateDesktop(dt);
    renderer.render(scene, camera);
    updateHud(dt);
  });

  // Exposed for automated checks and console poking. Not a gameplay API.
  window.__landnav = { camera, player, terrain, site: data.site, renderer, scene, settings, loco, input };
}

start().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err.message}`, true);
});
