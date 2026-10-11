// Session setup, render loop and mode switching.
//
// The camera lives inside a `player` rig. On desktop the rig sits on the ground and
// the camera is lifted to eye height. In VR the headset pose is relative to the rig
// (local-floor), so the rig sits on the ground under the head and the user's real
// height does the rest.
import * as THREE from 'three';
import { loadSite, buildTerrain } from './terrain.js';
import { loadSettings, saveSettings, storage } from './settings.js';
import { DesktopInput, XRInput } from './input.js';
import { Locomotion } from './locomotion.js';
import { Footfalls } from './footfalls.js';
import { createVignette } from './vignette.js';
import { buildSettingsPanel, setupVRButton } from './ui.js';
import { gridAzimuth, gridToMagnetic } from './coords.js';
import { Tools } from './tools.js';
import { loadMapTexture } from './map.js';
import { CourseRun, loadCourse, loadCourseIndex, formatClock } from './course.js';
import { generateCourse, validateCourse } from './course-logic.js';
import { createBeadsModel, createScoreCard } from './wrist.js';
import { Vegetation, VEGETATION_QUALITY } from './vegetation.js';
import { forestCover, hashString } from './vegetation-logic.js';
import { createSky, SKY } from './sky.js';
import { loadFeatures, buildFeatures } from './features.js';
import { LandCover, landcoverCover, NLCD_NAMES } from './landcover.js';
import { FeatureIndex, stakeAvoider } from './features-logic.js';
import { resolveCollisions } from './collision.js';
import { analyzeRun, buildRunExport } from './aar-logic.js';
import { drawReview, createReviewBoard, downloadRun } from './aar.js';
import { createVrMenu, cycle } from './vr-menu.js';
import { Teleporter } from './teleport.js';
import { rayGround } from './teleport-logic.js';
import { NIGHT_SKY, RED_LIGHT, NO_LIGHT, tintUnlit, createHeadlamp, HEADLAMP_INTENSITY } from './night.js';
import { dataUrl } from './data-url.js';

const params = new URLSearchParams(location.search);
// The site comes from ?site=, else the first entry in sites/index.json (see start()).
let siteId = params.get('site');
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
scene.background = SKY.horizon;
const sky = createSky();
scene.add(sky);

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 9000);
camera.rotation.order = 'YXZ';
const player = new THREE.Group();
player.name = 'player';
player.add(camera);
scene.add(player);

// Sky light plus warm bounce from the ground, so tree undersides and trunks aren't black.
const hemi = new THREE.HemisphereLight(0xdfe9f3, 0x6b6250, 0.95);
scene.add(hemi);
// Low-ish sun from the south-west so slopes read clearly. No shadows in v1.
const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
sun.position.set(-0.55, 0.55, 0.62).multiplyScalar(1000);
scene.add(sun);

let vegetation = null;
const headlamp = createHeadlamp(camera);
let headlampOn = true;

// Woods: you see about 150 m. Open: light haze, so distant ridges fade like real air.
// Night: starlight under the canopy, tree silhouettes to about 60 m, and a headlamp.
function applyPreset() {
  const night = settings.night;
  const horizon = night ? NIGHT_SKY.horizon : SKY.horizon;
  if (night) scene.fog = new THREE.Fog(horizon, 2, settings.nightVisibility);
  else if (settings.preset === 'woods') scene.fog = new THREE.Fog(horizon, settings.woodsVisibility * 0.15, settings.woodsVisibility);
  else scene.fog = new THREE.Fog(horizon, 1500, 7000);
  scene.background = horizon;
  const u = sky.material.uniforms;
  u.top.value = night ? NIGHT_SKY.top : SKY.top;
  u.horizon.value = horizon;
  u.ground.value = night ? NIGHT_SKY.ground : SKY.ground;
  hemi.intensity = night ? 0.05 : 0.95;
  hemi.color.setHex(night ? 0x8a9cc8 : 0xdfe9f3);
  sun.intensity = night ? 0 : 2.2;
  headlamp.intensity = night && headlampOn ? HEADLAMP_INTENSITY : 0;
  tools?.compass.setNight(night);
  applyNightTint();
  if (vegetation) {
    vegetation.setPreset(settings.preset);
    vegetation.setNight(night);
    applyCanopyRange();
  }
}

// What you read by (src/night.js): red under the headlamp, near black without it.
function applyNightTint() {
  const tint = settings.night ? (headlampOn ? RED_LIGHT : NO_LIGHT) : null;
  for (const root of [tools?.compass.group, tools?.map.group, wrist.card.mesh, run?.group]) tintUnlit(root, tint);
}

function setNight(on) {
  settings.night = on;
  applyPreset();
}

function toggleHeadlamp() {
  headlampOn = !headlampOn;
  applyPreset();
  if (settings.night) showToast(headlampOn ? 'Headlamp on.' : 'Headlamp off: only luminous marks show.');
}

// The ground reads as canopy where drawn trees stop.
function applyCanopyRange() {
  if (!terrain) return;
  const q = VEGETATION_QUALITY[settings.vegetation] ?? VEGETATION_QUALITY.medium;
  terrain.setCanopyRange(q.far * 0.6, q.far * 1.05);
}
const input = new DesktopInput(renderer.domElement, settings);
const xrInput = new XRInput(renderer, settings);
const loco = new Locomotion(settings);
const footfalls = new Footfalls(settings);
const vignette = createVignette();
camera.add(vignette.mesh);

let fly = false;
let xrJog = false;    // VR: jog toggled with a tap on the left stick press
let xrStillSec = 0;
let terrain = null;
let tools = null;
let beacon = null;
let siteData = null;   // { site, field, ... } from loadSite
let featureIndex = null; // roads, buildings etc. from features.json, if the site has one
let landcover = null;    // NLCD tree cover (landcover.js), if the site has it
let mapImage = null;     // map.png, for the review board
let lastRun = null;      // the last finished run (buildRunExport), for the review
const reviewBoard = createReviewBoard();
scene.add(reviewBoard.mesh);
let run = null;        // the current CourseRun, if a course is loaded
const wrist = { beads: createBeadsModel(), card: createScoreCard(), cardShown: false };
applyPreset();
const coursePanel = document.getElementById('course');
let boundaryWarning = '';

// ---- Controllers: simple stand-ins at the grip pose, plus the pointing rays ----

const debugPanel = debug ? createDebugPanel() : null;
const hands = { left: {}, right: {} };
for (let i = 0; i < 2; i++) {
  const grip = renderer.xr.getControllerGrip(i);
  const ray = renderer.xr.getController(i);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.022, 0.11, 12).rotateX(Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x2b2e33 }),
  );
  grip.add(body);
  const onConnect = (e) => {
    const hand = e.data.handedness;
    if (hand !== 'left' && hand !== 'right') return;
    grip.userData.handedness = hand;
    hands[hand] = { grip, ray, body };
    tools?.attach(hand, hands[hand]);
    if (debugPanel && hand === 'left') grip.add(debugPanel.mesh);
  };
  grip.addEventListener('connected', onConnect);
  player.add(grip);
  player.add(ray);
}

// ---- Desktop controls ----

input.on('toggleFly', () => {
  if (renderer.xr.isPresenting) return;
  setFly(!fly);
});
input.on('togglePreset', () => {
  settings.preset = settings.preset === 'woods' ? 'open' : 'woods';
  applyPreset();
  saveSettings(settings);
});
input.on('help', () => { help.hidden = !help.hidden; });
input.on('map', () => {
  if (!tools || renderer.xr.isPresenting) return;
  const up = tools.toggleDesktopMap();
  // The mouse becomes the pencil while the map is up.
  input.lookEnabled = !up;
  if (up && document.pointerLockElement) document.exitPointerLock();
});
input.on('bead', () => {
  if (!run) return showToast('Load a course to use the pace beads (Course button).');
  const p = { x: player.position.x, z: player.position.z };
  if (input.isDown('fast')) {
    run.resetBeads(p);
    showToast('Beads reset.');
  } else {
    run.slideBead(p);
  }
});
input.on('punch', () => {
  if (!run) return showToast('Load a course first (Course button).');
  showToast(punchMessage(run.punch({ x: player.position.x, z: player.position.z })));
});
input.on('scoreCard', () => setCardShown(!wrist.cardShown));
input.on('compass', () => {
  if (!tools || renderer.xr.isPresenting) return;
  tools.toggleDesktopCompass();
});
function setPointer(e) {
  if (!tools?.desktopMap) return;
  const r = renderer.domElement.getBoundingClientRect();
  tools.pointer = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}
renderer.domElement.addEventListener('mousemove', setPointer);
const RULER_MESSAGES = {
  shown: 'Ruler laid along the last line, zero on its first dot. L again to take it away.',
  hidden: 'Ruler put away.',
  'no-line': 'Draw a line first (click two dots), then L lays the ruler along it.',
};

// What each map click did, in words, so a click is never silent.
const CLICK_MESSAGES = {
  dot: 'Dot placed. Click a dot, then another, to draw a line between them.',
  select: 'Dot selected. Now click another dot to draw a line from this one.',
  deselect: 'Dot deselected.',
  line: 'Line drawn.',
  outside: 'Dots go inside the grid area of the map.',
  miss: 'Click on the map.',
  protractor: 'Protractor centred on the dot, aligned to grid north. Right-click the dot again to remove it.',
  'protractor-off': 'Protractor removed.',
  'protractor-miss': 'Right-click on a dot to centre the protractor there.',
};
let toast = null;
function showToast(text) {
  toast = text ? { text, until: performance.now() + 3500 } : null;
}

renderer.domElement.addEventListener('mousedown', (e) => {
  setPointer(e);
  // Ctrl-click is a right-click on a Mac trackpad.
  const button = e.button === 0 && e.ctrlKey ? 2 : e.button;
  const result = tools?.desktopClick(button);
  if (result) showToast(CLICK_MESSAGES[result]);
});
renderer.domElement.addEventListener('contextmenu', (e) => { if (tools?.desktopMap) e.preventDefault(); });
renderer.domElement.addEventListener('wheel', (e) => {
  if (!tools?.desktopCompass && !tools?.desktopMap) return;
  e.preventDefault();
  tools.desktopWheel(e.deltaY);
}, { passive: false });
addEventListener('keydown', (e) => {
  footfalls.unlock();
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'KeyP') togglePanel();
  if (renderer.xr.isPresenting) return;
  if (e.code === 'Escape' && !reviewEl.hidden) hideReview();
  if (run && wrist.cardShown && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    e.preventDefault();
    run.selectRow(e.code === 'ArrowUp' ? -1 : 1);
  }
  if (e.code === 'Enter' && run && run.state !== 'ended') requestEndCourse();
  if (e.code === 'KeyK') showMyPosition();
  if (e.code === 'KeyT') toggleHeadlamp();
  if (e.code === 'KeyQ') teleportDesktop();
  if (e.code === 'KeyN') {
    if (run && run.state !== 'ended') showToast('Day or night is set when the course starts (Course panel).');
    else { setNight(!settings.night); showToast(settings.night ? 'Night. T switches the headlamp.' : 'Day.'); }
  }
  if (e.code === 'KeyL' && tools?.desktopMap) showToast(RULER_MESSAGES[tools.map.toggleRuler()]);
  if ((e.code === 'Delete' || e.code === 'Backspace') && tools?.desktopMap) {
    showToast(tools.desktopErase() ? 'Dot erased.' : 'Point at a dot, then press Delete to erase it.');
  }
});
renderer.domElement.addEventListener('click', () => footfalls.unlock());
document.getElementById('settings-button').addEventListener('click', togglePanel);

function togglePanel() {
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    help.hidden = true; // they share the right edge
    coursePanel.hidden = true;
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
function onSettingChange(key) {
  if (key === 'paceCountPer100m' || key === 'jogPaceCountPer100m') loco.pace.reset();
  if (key === 'vegetation') applyCanopyRange();
}
buildSettingsPanel(panel, settings, onSettingChange);

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

// ---- In-headset menu (hold X) ----

const courseRunning = () => run && run.state !== 'ended';
const onOff = (v) => (v ? 'On' : 'Off');
function changeSetting(key, value) {
  settings[key] = value;
  saveSettings(settings);
  onSettingChange(key);
  buildSettingsPanel(panel, settings, onSettingChange); // keep the page panel in step
}
function setFly(on) {
  if (on && courseRunning()) return showToast('Flying is off while a course is running.');
  fly = on;
  // Desktop: keep the eye where it was; the camera offset moves between rig and camera.
  if (!renderer.xr.isPresenting) {
    if (fly) player.position.y += settings.eyeHeight;
    placeDesktopCamera();
  }
  if (!fly && terrain) snapPlayerToGround();
}
const step = (key, lo, hi) => (dir) => changeSetting(key, Math.min(hi, Math.max(lo, settings[key] + dir)));
const MENU_ITEMS = [
  { label: 'Woods or open', value: () => (settings.preset === 'woods' ? 'Woods' : 'Open'),
    press: () => { settings.preset = settings.preset === 'woods' ? 'open' : 'woods'; applyPreset(); saveSettings(settings); } },
  { label: 'Day or night', value: () => (settings.night ? 'Night' : 'Day'), enabled: () => !courseRunning(),
    press: () => setNight(!settings.night) },
  { label: 'Headlamp', value: () => onOff(headlampOn), enabled: () => settings.night, press: () => toggleHeadlamp() },
  { label: 'Fly', value: () => onOff(fly), enabled: () => !courseRunning(), press: () => setFly(!fly) },
  { label: 'Teleport range', value: () => `${settings.teleportRange} m`,
    press: (d) => changeSetting('teleportRange', cycle([20, 40, 60, 100, 150], settings.teleportRange, d)) },
  { label: 'Trees', value: () => settings.vegetation[0].toUpperCase() + settings.vegetation.slice(1),
    press: (d) => changeSetting('vegetation', cycle(['off', 'low', 'medium', 'high'], settings.vegetation, d)) },
  { label: 'Trees and buildings block you', value: () => onOff(settings.collisions), press: () => changeSetting('collisions', !settings.collisions) },
  { label: 'Pace count per 100 m', value: () => String(settings.paceCountPer100m), repeat: true, press: step('paceCountPer100m', 30, 120) },
  { label: 'Jogging pace count', value: () => String(settings.jogPaceCountPer100m), repeat: true, press: step('jogPaceCountPer100m', 25, 100) },
  { label: 'Time compression', value: () => `${settings.timeScale}x`, press: (d) => changeSetting('timeScale', cycle([1, 2, 3], settings.timeScale, d)) },
  { label: 'Comfort vignette', value: () => `${Math.round(settings.vignette * 100)}%`,
    press: (d) => changeSetting('vignette', cycle([0, 0.25, 0.5, 0.75, 1], settings.vignette, d)) },
  { label: 'Turning (right stick)', value: () => ({ snap: 'Snap', smooth: 'Smooth', off: 'Off' })[settings.turn],
    press: (d) => changeSetting('turn', cycle(['snap', 'smooth', 'off'], settings.turn, d)) },
  { label: 'Snap angle', value: () => `${settings.snapTurnDeg}°`, enabled: () => settings.turn === 'snap',
    press: (d) => changeSetting('snapTurnDeg', cycle([15, 30, 45], settings.snapTurnDeg, d)) },
  { label: 'Smooth turn speed', value: () => `${settings.smoothTurnDegPerSec}°/s`, enabled: () => settings.turn === 'smooth',
    press: (d) => changeSetting('smoothTurnDegPerSec', cycle([45, 90, 135], settings.smoothTurnDegPerSec, d)) },
  { label: 'Compass lens', value: () => (settings.units === 'mils' ? 'Mils' : 'Degrees'),
    press: () => changeSetting('units', settings.units === 'mils' ? 'deg' : 'mils') },
  { label: 'Assisted map readout', value: () => onOff(settings.assisted), press: () => changeSetting('assisted', !settings.assisted) },
  { label: "Allow 'show my position'", value: () => onOff(settings.lostHelp), press: () => changeSetting('lostHelp', !settings.lostHelp) },
  { label: 'Close', press: () => vrMenu.hide() },
];
const vrMenu = createVrMenu(MENU_ITEMS, {
  title: 'Menu',
  hint: 'Point with the right controller, pull the trigger. Left or right side of a value steps it down or up. Hold X to close.',
});
scene.add(vrMenu.mesh);
// The right controller's pointer while the menu is open.
const menuPointer = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
  new THREE.LineBasicMaterial({ color: 0xffd27a }),
);
menuPointer.visible = false;

// ---- Turning with the right stick (VR) ----

// Rotate the rig about the head, so you turn on the spot.
function rotateRig(a) {
  camera.getWorldPosition(head);
  const ox = player.position.x - head.x, oz = player.position.z - head.z;
  const c = Math.cos(a), sn = Math.sin(a);
  player.position.x = head.x + ox * c + oz * sn;
  player.position.z = head.z - ox * sn + oz * c;
  player.rotation.y += a;
}

// Snap: one step per flick. Smooth: continuous while held. The compass's bezel
// and the teleport arc have the stick first. Returns how hard you're turning
// (0..1) for the comfort vignette.
function turnXR(dt, compassHeld) {
  if (settings.turn === 'off' || compassHeld || teleportAiming) return 0;
  const sx = xrInput.stick('right').x;
  if (settings.turn === 'smooth') {
    if (Math.abs(sx) < 0.05) return 0;
    rotateRig(-THREE.MathUtils.degToRad(settings.smoothTurnDegPerSec) * sx * dt);
    return Math.abs(sx);
  }
  if (snapArmed && Math.abs(sx) > 0.7) {
    snapArmed = false;
    rotateRig(THREE.MathUtils.degToRad(settings.snapTurnDeg) * (sx > 0 ? -1 : 1));
  } else if (Math.abs(sx) < 0.3) {
    snapArmed = true;
  }
  return 0;
}

// ---- Teleport (Explore mode: whenever no course is running) ----

const teleporter = new Teleporter(scene, camera);
let teleportAiming = false;
let teleportRefusedShown = false;
const rayPos = new THREE.Vector3(), rayDir = new THREE.Vector3();

// Move so the head (VR) or player (desktop) stands at `target`, with a blink.
function teleportTo(target) {
  teleporter.jump(() => {
    if (renderer.xr.isPresenting) {
      camera.getWorldPosition(head);
      player.position.x += target.x - head.x;
      player.position.z += target.z - head.z;
      camera.getWorldPosition(head);
      const c = collide(head.x, head.z); // don't land inside a trunk or a house
      player.position.x += c.x - head.x;
      player.position.z += c.z - head.z;
      player.position.y = terrain.heightAt(c.x, c.z);
    } else {
      const c = collide(target.x, target.z);
      player.position.set(c.x, 0, c.z);
      snapPlayerToGround();
    }
  }, settings.teleportFadeSec);
}

// VR: push the right stick forward to aim the arc, let go to jump.
function updateTeleportXR(compassHeld) {
  const sy = xrInput.stick('right').y;
  const can = !courseRunning() && !fly && !compassHeld && !vrMenu.open && hands.right.ray && !teleporter.fading;
  if (sy > 0.6 && !can) {
    if (courseRunning() && !teleportRefusedShown) {
      teleportRefusedShown = true;
      showToast('Teleport is off during a course (walk it, and count your paces).');
    }
    teleporter.hide();
    teleportAiming = false;
    return;
  }
  if (sy > 0.6) {
    teleportAiming = true;
    hands.right.ray.updateMatrixWorld(true);
    rayPos.setFromMatrixPosition(hands.right.ray.matrixWorld);
    rayDir.set(0, 0, -1).transformDirection(hands.right.ray.matrixWorld);
    teleporter.aim(rayPos, rayDir, { range: settings.teleportRange, heightAt: (x, z) => terrain.heightAt(x, z), size: terrain.size });
  } else if (teleportAiming && sy < 0.3) {
    teleportAiming = false;
    const target = teleporter.target;
    teleporter.hide();
    if (target) teleportTo(target);
    else xrInput.pulse('right', 0.3, 40); // nowhere valid to land
  }
  if (sy < 0.3) teleportRefusedShown = false;
}

// Desktop: Q jumps to the ground under the middle of the screen.
function teleportDesktop() {
  if (courseRunning()) return showToast('Teleport is off during a course.');
  camera.getWorldPosition(rayPos);
  camera.getWorldDirection(rayDir);
  const hit = rayGround(rayPos, rayDir, (x, z) => terrain.heightAt(x, z), 2000);
  const m = 1;
  if (!hit || hit.x < m || hit.z < m || hit.x > terrain.size - m || hit.z > terrain.size - m) {
    return showToast('Look at the ground inside the area to teleport there.');
  }
  if (fly) setFly(false);
  teleportTo(hit);
}

function toggleVrMenu() {
  if (vrMenu.open) { vrMenu.hide(); return; }
  camera.getWorldPosition(head);
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-4) fwd.copy(lastHeading);
  vrMenu.show(head, fwd.normalize());
  // Ride along with the rig, so walking or flying keeps it in front of you.
  player.attach(vrMenu.mesh);
}

function updateVrMenu() {
  const ray = hands.right.ray;
  if (!ray) return;
  if (menuPointer.parent !== ray) ray.add(menuPointer);
  const dist = vrMenu.update(ray, xrInput.isDown('right', 'trigger'), performance.now() / 1000);
  menuPointer.visible = vrMenu.open;
  menuPointer.scale.z = dist ?? 1.5;
}

// Keep the walker out of trunks, logs, rocks and buildings (slide along them).
const OBSTACLE_REACH_M = 4; // longest log half-length plus a margin
function collide(x, z) {
  if (!settings.collisions) return { x, z };
  const obstacles = vegetation ? vegetation.obstaclesNear(x, z, OBSTACLE_REACH_M) : [];
  if (featureIndex) {
    for (const b of featureIndex.buildingsNear(x, z, OBSTACLE_REACH_M)) obstacles.push({ type: 'poly', pts: b.pts });
  }
  return resolveCollisions(x, z, settings.collisionRadius, obstacles);
}

// What Locomotion walks on.
const ground = {
  slopeAt: (x, z, dx, dz) => terrain.slopeAt(x, z, dx, dz),
  get size() { return terrain.size; },
  collide,
};

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

  tools?.updateDesktop(dt, input.pitch);

  if (fly) {
    const speed = settings.flySpeed * (input.isDown('fast') ? settings.flyFastMultiplier : 1);
    const len = Math.hypot(dirX, dirZ) || 1;
    player.position.x += (dirX / len) * speed * dt * Math.min(1, Math.hypot(dirX, dirZ));
    player.position.z += (dirZ / len) * speed * dt * Math.min(1, Math.hypot(dirX, dirZ));
    player.position.y += axes.y * speed * dt;
    const floor = terrain.heightAt(player.position.x, player.position.z) + 0.5;
    if (player.position.y < floor) player.position.y = floor;
    boundaryWarning = '';
    courseTick(dt, player.position.x, player.position.z, false);
    return;
  }

  // Shift: fly faster when flying, jog when walking.
  const step = loco.step(dt, ground, player.position.x, player.position.z, dirX, dirZ, 1, input.isDown('fast'));
  player.position.x += step.dx;
  player.position.z += step.dz;
  player.position.y = terrain.heightAt(player.position.x, player.position.z);
  playFeet(step.feet);
  updateBoundaryWarning(player.position.x, player.position.z);
  courseTick(dt, player.position.x, player.position.z, step.dx !== 0 || step.dz !== 0);
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
  updateVrMenu();

  // Flying (from the menu): left stick moves, right stick up and down climbs and
  // descends. No footfalls, no collisions; never below the ground.
  if (fly) {
    const speed = settings.vrFlySpeed * dt;
    player.position.x += dirX * speed;
    player.position.z += dirZ * speed;
    const climb = tools?.compass.group.visible ? 0 : xrInput.stick('right').y;
    player.position.y += climb * speed;
    camera.getWorldPosition(head);
    const floor = terrain.heightAt(head.x, head.z);
    if (player.position.y < floor) player.position.y = floor;
    if (tools) tools.updateXR(dt, xrInput);
    updateXRCourseControls();
    courseTick(dt, head.x, head.z, false);
    const turning = turnXR(dt, !!tools?.compass.group.visible);
    const moving = Math.min(1, Math.hypot(stick.x, stick.y) + Math.abs(climb));
    vignette.update(settings.vignette * Math.max(moving, turning), dt);
    boundaryWarning = '';
    return;
  }
  // Jog (left stick press) lasts until you've let go of the stick for a moment.
  if (stick.mag > 0) xrStillSec = 0;
  else if ((xrStillSec += dt) > 1) xrJog = false;
  const step = loco.step(dt, ground, head.x, head.z, dirX, dirZ, stick.mag, xrJog);
  player.position.x += step.dx;
  player.position.z += step.dz;
  head.x += step.dx;
  head.z += step.dz;
  playFeet(step.feet, (hand, strength, ms) => xrInput.pulse(hand, strength, ms));

  // Physical walking in the room can carry the head into a tree or past the edge;
  // push the rig back.
  const s = terrain.size;
  const pushed = collide(head.x, head.z);
  const cx = THREE.MathUtils.clamp(pushed.x, 0, s);
  const cz = THREE.MathUtils.clamp(pushed.z, 0, s);
  player.position.x += cx - head.x;
  player.position.z += cz - head.z;
  head.x = cx;
  head.z = cz;

  // Stand on the ground under the head.
  player.position.y = terrain.heightAt(head.x, head.z);

  // Tools. While the compass is in hand the right stick turns its bezel.
  const compassHeld = tools ? tools.updateXR(dt, xrInput) : false;
  updateXRCourseControls();
  courseTick(dt, head.x, head.z, step.dx !== 0 || step.dz !== 0);

  // Snap turn (off by default): rotate the rig about the head.
  updateTeleportXR(compassHeld);
  const turning = turnXR(dt, compassHeld);

  const full = settings.baseSpeed * settings.timeScale;
  vignette.update(settings.vignette * Math.max(Math.min(1, loco.lastSpeed / full), turning), dt);
  updateBoundaryWarning(head.x, head.z);
}

// ---- Courses ----

const PUNCH_MESSAGES = {
  none: 'No stake within 2 m.',
  ended: 'The course is over.',
};
function punchMessage(r) {
  return r.kind === 'punch' ? `Punched ${r.code} into row ${r.row + 1}.` : PUNCH_MESSAGES[r.kind];
}

const HINTS = {
  desktop: 'E punch a stake within 2 m. Space bead, Shift+Space reset. Up/Down pick the row. Tab hides this. Enter twice to end (be back at the start).',
  vr: 'Trigger punches a stake within 2 m. A slides a bead, hold A to reset. Y picks the next row; hold Y to end (be back at the start). X hides this; hold X for the menu.',
};

function setCardShown(shown) {
  wrist.cardShown = shown;
  wrist.card.mesh.visible = shown;
}

// The wrist kit lives on the left controller in VR and in the corners of the screen on desktop.
function mountWrist() {
  const grip = hands.left.grip;
  if (renderer.xr.isPresenting && grip) {
    grip.add(wrist.beads.group);
    wrist.beads.group.position.set(-0.04, -0.06, 0.06);
    wrist.beads.group.rotation.set(0, 0, 0);
    wrist.beads.group.scale.setScalar(1);
    grip.add(wrist.card.mesh);
    wrist.card.mesh.position.set(0, 0.04, 0.12);
    wrist.card.mesh.rotation.set(-1.15, 0, 0);
    wrist.card.mesh.scale.setScalar(1);
  } else {
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.add(wrist.beads.group);
    wrist.beads.group.position.set(-t * camera.aspect * 0.4 * 0.88, -0.06, -0.4);
    wrist.beads.group.scale.setScalar(0.9);
    camera.add(wrist.card.mesh);
    wrist.card.mesh.position.set(t * camera.aspect * 0.45 * 0.68, -0.02, -0.45);
    wrist.card.mesh.rotation.set(0, 0, 0);
    wrist.card.mesh.scale.setScalar(1.4);
  }
  wrist.beads.group.visible = !!run;
}

async function startCourse(course, options = {}) {
  run?.dispose();
  hideReview();
  vegetation?.setExclusions([course.start, ...course.points, ...course.decoys]);
  run = new CourseRun({ scene, terrain, site: siteData.site, course, settings });
  const problems = validateCourse(course, siteData.site, siteData.field);
  if (problems.length) console.warn(`Course ${course.id} breaks the generator's rules:\n  ${problems.join('\n  ')}`);
  // The course sets the woods/open preset and day or night for this run (not saved).
  settings.preset = course.preset || settings.preset;
  settings.night = !!(course.night || options.night);
  headlampOn = true;
  applyPreset();
  tools?.map.clear();
  loco.pace.reset();
  if (fly) { fly = false; placeDesktopCamera(); }
  // Stand at the start, facing grid north.
  if (renderer.xr.isPresenting) {
    camera.getWorldPosition(head);
    player.position.x += course.start.x - head.x;
    player.position.z += course.start.z - head.z;
  } else {
    player.position.set(course.start.x, 0, course.start.z);
    input.yaw = 0;
    input.pitch = 0;
  }
  snapPlayerToGround();
  mountWrist();
  setCardShown(true);
  coursePanel.hidden = true;
  showToast(`${course.name}: plot your points from the score card. The clock starts when you move.`);
  return run;
}

// The lost lifeline: a brief "you are here" on the map. Never automatic, always
// counted when a course is running, and it can be switched off in Settings.
let revealUntil = 0;
function showMyPosition() {
  if (!tools) return;
  if (!settings.lostHelp) {
    showToast("Showing your position is switched off in Settings.");
    return;
  }
  const p = currentPos();
  let az;
  if (renderer.xr.isPresenting) {
    camera.getWorldDirection(fwd);
    az = gridAzimuth(fwd.x, fwd.z);
  } else {
    az = gridAzimuth(-Math.sin(input.yaw), -Math.cos(input.yaw));
    if (!tools.desktopMap) {
      tools.toggleDesktopMap();
      input.lookEnabled = false;
      if (document.pointerLockElement) document.exitPointerLock();
    }
  }
  tools.map.showPosition(p.x, p.z, az);
  revealUntil = performance.now() + settings.lostHelpSec * 1000;
  let msg = `You are here: the red arrow on the map, for ${settings.lostHelpSec} s.`;
  if (run && run.state !== 'ended') {
    run.revealPosition(p);
    msg += ` Used ${run.reveals} time${run.reveals === 1 ? '' : 's'} this course.`;
  }
  if (renderer.xr.isPresenting) msg += ' Hold the left grip to see the map.';
  showToast(msg);
}

let endConfirmUntil = 0;
function requestEndCourse() {
  if (performance.now() < endConfirmUntil) {
    endConfirmUntil = 0;
    finishCourse('ended');
  } else {
    endConfirmUntil = performance.now() + 3000;
    showToast('Press Enter again to end the course. Be back at the start first.');
  }
}

function currentPos() {
  if (renderer.xr.isPresenting) {
    camera.getWorldPosition(head);
    return { x: head.x, z: head.z };
  }
  return { x: player.position.x, z: player.position.z };
}

function finishCourse(reason) {
  if (!run || run.state === 'ended') return;
  const r = run.end(currentPos(), reason);
  setCardShown(true);
  showToast(`Course over: ${r.correct}/${r.total} correct, ${r.pass ? 'PASS' : 'FAIL'}.${reason === 'time' ? ' Out of time.' : ''}`);
  courseEnded();
}

// ---- After-action review ----

const LAST_RUN_KEY = 'landnav.lastrun.v1';
const reviewEl = document.getElementById('review');
const reviewCanvas = reviewEl.querySelector('canvas');

function courseEnded() {
  lastRun = buildRunExport({
    course: run.course, site: siteData.site, log: run.log, beads: run.beads.log, result: run.result, settings,
  });
  const s = storage();
  try { s?.setItem(LAST_RUN_KEY, JSON.stringify(lastRun)); } catch { /* too big or blocked: keep it in memory */ }
  showReview();
}

function loadLastRun(siteIdNow) {
  try {
    const r = JSON.parse(storage()?.getItem(LAST_RUN_KEY) || 'null');
    return r && r.format === 'land-nav-run' && r.site?.id === siteIdNow ? r : null;
  } catch {
    return null;
  }
}

function reviewArgs(hint) {
  return { site: siteData.site, mapImage, run: lastRun, analysis: analyzeRun(lastRun, siteData.site), hint };
}

// Desktop: a page overlay. VR: a table in front of you.
function showReview() {
  if (!lastRun) {
    showToast('No finished run to review yet.');
    return;
  }
  if (renderer.xr.isPresenting) {
    reviewBoard.draw(reviewArgs('B (map put away) hides or shows this table. Download the run from the Course panel after VR.'));
    camera.getWorldPosition(head);
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.copy(lastHeading);
    reviewBoard.placeBefore(head, fwd.normalize());
    return;
  }
  drawReview(reviewCanvas, reviewArgs('Esc or Close to return. Download saves the run as JSON.'));
  reviewEl.hidden = false;
  coursePanel.hidden = true;
  if (document.pointerLockElement) document.exitPointerLock();
}

function hideReview() {
  reviewEl.hidden = true;
  reviewBoard.mesh.visible = false;
}

document.getElementById('review-close').addEventListener('click', hideReview);
document.getElementById('review-download').addEventListener('click', () => lastRun && downloadRun(lastRun));

function courseTick(dt, x, z, moving) {
  if (revealUntil && performance.now() > revealUntil) {
    revealUntil = 0;
    tools?.map.hidePosition();
  }
  if (!run) return;
  const wasRunning = run.state === 'running';
  run.update(dt, { x, z }, { moving, mapOut: tools?.map.group.visible, compassOut: tools?.compass.group.visible, jog: moving && loco.lastGait === 'jog' });
  if (wasRunning && run.state === 'ended') {
    setCardShown(true);
    showToast(`Time is up: ${run.result.correct}/${run.result.total} correct, ${run.result.pass ? 'PASS' : 'FAIL'}.`);
    courseEnded();
  }
  wrist.beads.update(run.beads);
  if (wrist.cardShown) wrist.card.draw(run, renderer.xr.isPresenting ? HINTS.vr : HINTS.desktop);
}

// VR course controls: X card, Y row (hold: end), A bead (hold: reset), trigger punch.
const holds = {};
function holdButton(hand, button, holdSec, { onTap, onHold }) {
  const key = `${hand}:${button}`;
  const now = performance.now() / 1000;
  if (xrInput.justPressed(hand, button)) holds[key] = { t: now, fired: false };
  const h = holds[key];
  if (!h) return;
  if (xrInput.isDown(hand, button)) {
    if (!h.fired && now - h.t >= holdSec) { h.fired = true; onHold?.(); }
  } else {
    if (!h.fired) onTap?.();
    delete holds[key];
  }
}

function updateXRCourseControls() {
  // X: tap for the score card, hold for the menu.
  holdButton('left', 'primary', 0.8, {
    onTap: () => setCardShown(!wrist.cardShown),
    onHold: () => { toggleVrMenu(); xrInput.pulse('left', 0.4, 30); },
  });
  holdButton('left', 'stick', 1, {
    onTap: () => { xrJog = !xrJog; xrStillSec = 0; xrInput.pulse('left', xrJog ? 0.4 : 0.15, 20); },
    onHold: () => { showMyPosition(); xrInput.pulse('left', 0.6, 60); },
  });
  if (xrInput.justPressed('left', 'trigger') && settings.night) { toggleHeadlamp(); xrInput.pulse('left', 0.2, 15); }
  // B shows or hides the review table (with the map up, B is the protractor).
  if (xrInput.justPressed('right', 'secondary') && !tools?.map.group.visible && lastRun) {
    if (reviewBoard.mesh.visible) reviewBoard.mesh.visible = false;
    else showReview();
  }
  if (!run) return;
  const pos = { x: head.x, z: head.z };
  holdButton('right', 'primary', 1, {
    onTap: () => { run.slideBead(pos); xrInput.pulse('right', 0.3, 12); },
    onHold: () => { run.resetBeads(pos); xrInput.pulse('right', 0.8, 60); },
  });
  holdButton('left', 'secondary', 1.5, {
    onTap: () => { if (wrist.cardShown) run.selectRow(1); },
    onHold: () => { finishCourse('ended'); xrInput.pulse('left', 0.9, 120); },
  });
  // The trigger punches when the map isn't up (with the map up it's the pencil).
  if (xrInput.justPressed('right', 'trigger') && !tools?.map.group.visible && !vrMenu.open) {
    const r = run.punch(pos);
    if (r.kind === 'punch') xrInput.pulse('right', 1, 80);
    else xrInput.pulse('right', 0.2, 20);
  }
}

// Generated courses start at the site's default start (a trailhead) when it has one.
function genOptions() {
  const s = siteData?.site.default_start;
  const o = s ? { start: { x: s.x, z: s.z } } : {};
  if (featureIndex) o.avoid = stakeAvoider(featureIndex);
  return o;
}

// ---- Course panel (page UI) ----

function buildCoursePanel(index, sites = []) {
  coursePanel.replaceChildren();
  if (sites.length > 1) {
    const sh = document.createElement('h2');
    sh.textContent = 'Site';
    const sitePick = document.createElement('select');
    for (const s of sites) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      sitePick.append(o);
    }
    sitePick.value = siteId;
    // A site is a whole new world: reload with it.
    sitePick.addEventListener('change', () => {
      const q = new URLSearchParams(location.search);
      q.set('site', sitePick.value);
      q.delete('course');
      location.search = q.toString();
    });
    coursePanel.append(sh, sitePick);
  }
  const h = document.createElement('h2');
  h.textContent = 'Course';
  const select = document.createElement('select');
  for (const c of index) {
    const o = document.createElement('option');
    o.value = `file:${c.file}`;
    o.textContent = c.name;
    select.append(o);
  }
  const gen = document.createElement('option');
  gen.value = 'gen';
  gen.textContent = 'New random course';
  select.append(gen);
  const seedRow = document.createElement('label');
  seedRow.className = 'row';
  const seedLabel = document.createElement('span');
  seedLabel.textContent = 'Seed';
  const seed = document.createElement('input');
  seed.type = 'number';
  seed.value = String(Math.floor(Math.random() * 100000));
  seedRow.append(seedLabel, seed);
  const syncSeed = () => { seedRow.hidden = select.value !== 'gen'; };
  select.addEventListener('change', syncSeed);
  syncSeed();
  const nightRow = document.createElement('label');
  nightRow.className = 'row';
  const nightLabel = document.createElement('span');
  nightLabel.textContent = 'Run it at night';
  const nightBox = document.createElement('input');
  nightBox.type = 'checkbox';
  nightRow.append(nightLabel, nightBox);
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.textContent = 'Start course';
  startBtn.addEventListener('click', async () => {
    try {
      const v = select.value;
      const course = v === 'gen'
        ? generateCourse(siteData.site, siteData.field, Number(seed.value) || 1, genOptions())
        : await loadCourse(`sites/${encodeURIComponent(siteId)}`, v.slice(5));
      await startCourse(course, { night: nightBox.checked });
    } catch (err) {
      console.error(err);
      showToast(`Could not start: ${err.message}`);
    }
  });
  const endBtn = document.createElement('button');
  endBtn.type = 'button';
  endBtn.textContent = 'End course';
  endBtn.addEventListener('click', () => finishCourse('ended'));
  const reviewBtn = document.createElement('button');
  reviewBtn.type = 'button';
  reviewBtn.textContent = 'Review last run';
  reviewBtn.addEventListener('click', showReview);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = (siteData.site.default_start ? `The START flag is at ${siteData.site.default_start.name}. ` : '') + 'You start at the START flag. Plot the points from the score card, navigate to each, punch its stake, then come back to the start and end the course.';
  const builder = document.createElement('p');
  builder.className = 'note';
  const link = Object.assign(document.createElement('a'), { href: 'builder.html', textContent: 'Site builder' });
  link.style.color = '#ffd27a';
  builder.append(link, ': make a site anywhere in the US, or add courses.');
  coursePanel.append(h, select, seedRow, nightRow, startBtn, endBtn, reviewBtn, note, builder);
}

document.getElementById('course-button').addEventListener('click', () => {
  coursePanel.hidden = !coursePanel.hidden;
  if (!coursePanel.hidden) {
    panel.hidden = true;
    help.hidden = true;
    if (document.pointerLockElement) document.exitPointerLock();
  }
});

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
    if (tools) {
      tools.desktopMap = tools.desktopCompass = false;
      tools.mountDesktop();
      input.lookEnabled = true;
    }
    camera.position.set(0, 0, 0);
    camera.rotation.set(0, 0, 0);
    snapPlayerToGround();
    session.addEventListener('end', exitVR);
    await renderer.xr.setSession(session);
    mountWrist();
    vrButton.textContent = 'Exit VR';
  } catch (err) {
    console.error(err);
    setStatus(`Could not start VR: ${err.message}`, true);
    setTimeout(() => setStatus(''), 4000);
  }
}

function exitVR() {
  vrMenu.hide();
  menuPointer.visible = false;
  fly = false; // VR fly height doesn't carry over to the desktop camera
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
  tools?.mountDesktop();
  mountWrist();
  vrButton.textContent = 'Enter VR';
  reviewBoard.mesh.visible = false;
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
  const gait = fly ? 'FLY' : loco.lastSpeed > 0 && loco.lastGait === 'jog' ? 'JOG' : loco.tooSteepToJog ? 'WALK (too steep to jog)' : 'WALK';
  const mode = `${courseRunning() ? 'COURSE' : 'EXPLORE'}  ${gait}`;
  const lines = [
    `${mode}  ${settings.preset}${settings.night ? `  NIGHT (headlamp ${headlampOn ? 'on' : 'off'})` : ''}  ${fps.toFixed(0)} fps  ${info.calls} calls  ${(info.triangles / 1000).toFixed(0)}k tris`,
  ];
  // Never show the true position or the pace count during a run. Debug only.
  if (debug) {
    const p = player.position;
    const heading = gridAzimuth(-Math.sin(input.yaw), -Math.cos(input.yaw));
    lines.push(`x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}  ground ${p.y.toFixed(1)}  grid az ${heading.toFixed(1)}`);
    lines.push(`walked ${loco.pace.distance.toFixed(1)} m  paces ${loco.pace.leftCount}  grade ${(loco.lastGrade * 100).toFixed(0)}%`);
    if (vegetation) {
      const v = vegetation.stats;
      const surface = featureIndex?.surfaceAt(player.position.x, player.position.z);
      const lc = landcover ? `  ${NLCD_NAMES[landcover.classAt(player.position.x, player.position.z)] ?? 'no class'}` : '';
      lines.push(`trees ${v.near} near, ${v.cut} far, ${v.clutter} ground  cover ${vegetation.coverAt(player.position.x, player.position.z).toFixed(2)}${lc}${surface ? `  on ${surface}` : ''}`);
    }
    const c = compassDebug();
    if (c) lines.push(c);
    if (run) lines.push(`course ${run.course.id} ${run.state} ${formatClock(run.elapsed)} row ${run.row + 1} beads ${run.beads.metres} m`);
  }
  if (boundaryWarning) lines.push(boundaryWarning);
  if (!input.locked && !renderer.xr.isPresenting && !tools?.desktopMap) lines.push('Click to look around. M map, C compass, H help, P settings.');
  if (tools?.desktopMap && !renderer.xr.isPresenting) {
    lines.push('Map: click for a dot, click two dots for a line, right-click a dot for the protractor, wheel to zoom, M to put away.');
  }
  if (toast && performance.now() < toast.until) lines.push(`> ${toast.text}`);
  hud.textContent = lines.join('\n');
  debugPanel?.update(loco, boundaryWarning, compassDebug());
}

// Debug: what the dial says against the truth, and the true bearing to the test beacon.
function compassDebug() {
  if (!tools?.compass.group.visible) return '';
  const c = tools.compass;
  const fmt = (v) => (v === null || v === undefined ? '---' : v.toFixed(1));
  let text = `dial ${fmt(c.dialReading)}  true ${fmt(c.heading.magnetic)}  tilt ${c.heading.tilt.toFixed(0)}${c.stuck ? ' STUCK' : ''}`;
  if (beacon) {
    const p = c.group.getWorldPosition(new THREE.Vector3());
    const az = gridToMagnetic(gridAzimuth(beacon.x - p.x, beacon.z - p.z), tools.map.site.gm_angle_deg);
    text += `  beacon ${fmt(az)}`;
  }
  return text;
}

// Debug: a tall striped pole at ?beacon=x,z to check compass readings against.
function makeBeacon(x, z) {
  const group = new THREE.Group();
  group.name = 'beacon';
  for (let i = 0; i < 10; i++) {
    const seg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, 2, 12),
      new THREE.MeshLambertMaterial({ color: i % 2 ? 0xffffff : 0xd02020 }),
    );
    seg.position.y = 1 + i * 2;
    group.add(seg);
  }
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd000 }));
  ball.position.y = 20.8;
  group.add(ball);
  group.position.set(x, terrain.heightAt(x, z), z);
  return group;
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
    update(l, warn, compassLine) {
      const text = `${l.pace.distance.toFixed(1)} m  ${l.pace.leftCount} paces|${compassLine || warn || `grade ${(l.lastGrade * 100).toFixed(0)}%`}`;
      if (text === last) return;
      last = text;
      const [a, b] = text.split('|');
      ctx.fillStyle = 'rgba(15,17,20,0.85)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffd27a';
      ctx.font = 'bold 64px system-ui, sans-serif';
      ctx.fillText(a, 20, 80);
      ctx.fillStyle = '#ddd';
      ctx.font = `${b.length > 22 ? 30 : 44}px system-ui, sans-serif`;
      ctx.fillText(b, 20, 155, canvas.width - 30);
      tex.needsUpdate = true;
    },
  };
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

async function loadLandCover(base, site) {
  if (!site.landcover) return null;
  try {
    const res = await fetch(dataUrl(`${base}/landcover.bin`));
    return res.ok ? new LandCover(await res.arrayBuffer(), site.landcover) : null;
  } catch (err) {
    console.warn('Land cover not loaded; trees fall back to noise.', err);
    return null;
  }
}

async function loadSiteIndex() {
  try {
    const res = await fetch(dataUrl('sites/index.json'));
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

async function start() {
  const sites = await loadSiteIndex();
  siteId ||= sites[0]?.id || 'demo-synthetic';
  setStatus(`Loading site "${siteId}" ...`);
  const base = `sites/${encodeURIComponent(siteId)}`;
  const [data, mapTexture] = await Promise.all([loadSite(base), loadMapTexture(base)]);
  mapImage = mapTexture.image;
  lastRun = loadLastRun(data.site.id);
  const features = await loadFeatures(base, data.site);
  landcover = await loadLandCover(base, data.site);
  // With land cover data the campground's thinner canopy is already in it.
  featureIndex = features ? new FeatureIndex(features, landcover ? { areaDensity: { campground: 1 } } : {}) : null;
  const vegSeed = hashString(data.site.id);
  // Tree cover from real land cover data where the site has it, else from noise.
  const coverFn = landcover
    ? (x, z, slope) => landcoverCover(landcover, vegSeed, x, z, slope)
    : (x, z, slope) => forestCover(vegSeed, x, z, slope);
  // No trees on roads, trails, parking or around buildings; fewer in the campground.
  const densityAt = featureIndex ? (x, z) => featureIndex.density(x, z) : undefined;
  terrain = buildTerrain(renderer, data, {
    coverAt: (x, z, slope) => coverFn(x, z, slope) * (densityAt ? densityAt(x, z) : 1),
  });
  vegetation = new Vegetation(scene, terrain, data.site, settings, {
    densityAt, coverAt: landcover ? coverFn : undefined, evergreenAt: landcover ? (x, z) => landcover.evergreenAt(x, z) : undefined,
  });
  applyCanopyRange();
  scene.add(terrain.group);
  scene.add(buildFeatures(features, data.field));
  tools = new Tools({ renderer, camera, site: data.site, mapTexture, settings });
  for (const hand of ['left', 'right']) if (hands[hand].grip) tools.attach(hand, hands[hand]);
  applyPreset(); // night tint and compass lume for the tools just made
  siteData = data;
  buildCoursePanel(await loadCourseIndex(base), sites);
  mountWrist();
  if (debug && params.get('beacon')) {
    const [bx, bz] = params.get('beacon').split(',').map(Number);
    if (Number.isFinite(bx) && Number.isFinite(bz)) {
      beacon = { x: bx, z: bz };
      scene.add(makeBeacon(bx, bz));
    }
  }
  document.title = `${data.site.name} | Land Nav`;

  // Start on the ground in the middle of the area, facing grid north, until a
  // course puts you at its start.
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
    teleporter.tick(dt);
    // Trees and sky follow the viewer.
    camera.getWorldPosition(head);
    sky.position.copy(head);
    vegetation.update(head.x, head.z);
    renderer.render(scene, camera);
    updateHud(dt);
  });

  // Exposed for automated checks and console poking. Not a gameplay API.
  window.__landnav = {
    camera, player, terrain, site: data.site, field: data.field, renderer, scene, settings, loco, input, tools, beacon, wrist, startCourse, vegetation, featureIndex, landcover, collide,
    get run() { return run; },
    get lastRun() { return lastRun; },
    get xrJog() { return xrJog; },
    get fly() { return fly; },
    teleporter, teleportTo,
    vrMenu, setFly,
    headlamp, setNight, toggleHeadlamp, get headlampOn() { return headlampOn; },
    showReview, hideReview, reviewBoard,
  };

  // ?course=<id> loads a listed course; ?course=gen:<seed> generates one; add &night
  // to run it at night.
  const want = params.get('course');
  if (want) {
    const index = await loadCourseIndex(base);
    const listed = index.find((c) => c.id === want);
    const opts = { night: params.has('night') };
    if (listed) await startCourse(await loadCourse(base, listed.file), opts);
    else if (want.startsWith('gen:')) await startCourse(generateCourse(data.site, data.field, Number(want.slice(4)) || 1, genOptions()), opts);
    else showToast(`No course "${want}" for this site.`);
  }
}

start().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err.message}`, true);
});
