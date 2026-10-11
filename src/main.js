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
import { gridAzimuth, gridToMagnetic } from './coords.js';
import { Tools } from './tools.js';
import { loadMapTexture } from './map.js';
import { CourseRun, loadCourse, loadCourseIndex, formatClock } from './course.js';
import { generateCourse, validateCourse } from './course-logic.js';
import { createBeadsModel, createScoreCard } from './wrist.js';

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
let tools = null;
let beacon = null;
let siteData = null;   // { site, field, ... } from loadSite
let run = null;        // the current CourseRun, if a course is loaded
const wrist = { beads: createBeadsModel(), card: createScoreCard(), cardShown: false };
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
  if (run && run.state !== 'ended' && !fly) {
    showToast('Flying is off while a course is running.');
    return;
  }
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
  if (run && wrist.cardShown && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
    e.preventDefault();
    run.selectRow(e.code === 'ArrowUp' ? -1 : 1);
  }
  if (e.code === 'Enter' && run && run.state !== 'ended') requestEndCourse();
  if (e.code === 'KeyK') showMyPosition();
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

  const step = loco.step(dt, terrain, player.position.x, player.position.z, dirX, dirZ, 1);
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

  // Tools. While the compass is in hand the right stick turns its bezel.
  const compassHeld = tools ? tools.updateXR(dt, xrInput) : false;
  updateXRCourseControls();
  courseTick(dt, head.x, head.z, step.dx !== 0 || step.dz !== 0);

  // Snap turn (off by default): rotate the rig about the head.
  if (settings.snapTurn && !compassHeld) {
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
  vr: 'Trigger punches a stake within 2 m. A slides a bead, hold A to reset. Y picks the next row; hold Y to end (be back at the start). X hides this.',
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

async function startCourse(course) {
  run?.dispose();
  run = new CourseRun({ scene, terrain, site: siteData.site, course, settings });
  const problems = validateCourse(course, siteData.site, siteData.field);
  if (problems.length) console.warn(`Course ${course.id} breaks the generator's rules:\n  ${problems.join('\n  ')}`);
  // The course sets the woods/open preset for this run (not saved as a setting).
  settings.preset = course.preset || settings.preset;
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
}

function courseTick(dt, x, z, moving) {
  if (revealUntil && performance.now() > revealUntil) {
    revealUntil = 0;
    tools?.map.hidePosition();
  }
  if (!run) return;
  const wasRunning = run.state === 'running';
  run.update(dt, { x, z }, { moving, mapOut: tools?.map.group.visible, compassOut: tools?.compass.group.visible });
  if (wasRunning && run.state === 'ended') {
    setCardShown(true);
    showToast(`Time is up: ${run.result.correct}/${run.result.total} correct, ${run.result.pass ? 'PASS' : 'FAIL'}.`);
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
  if (xrInput.justPressed('left', 'primary')) setCardShown(!wrist.cardShown);
  holdButton('left', 'stick', 1, { onHold: () => { showMyPosition(); xrInput.pulse('left', 0.6, 60); } });
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
  if (xrInput.justPressed('right', 'trigger') && !tools?.map.group.visible) {
    const r = run.punch(pos);
    if (r.kind === 'punch') xrInput.pulse('right', 1, 80);
    else xrInput.pulse('right', 0.2, 20);
  }
}

// ---- Course panel (page UI) ----

function buildCoursePanel(index) {
  coursePanel.replaceChildren();
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
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.textContent = 'Start course';
  startBtn.addEventListener('click', async () => {
    try {
      const v = select.value;
      const course = v === 'gen'
        ? generateCourse(siteData.site, siteData.field, Number(seed.value) || 1)
        : await loadCourse(`sites/${encodeURIComponent(siteId)}`, v.slice(5));
      await startCourse(course);
    } catch (err) {
      console.error(err);
      showToast(`Could not start: ${err.message}`);
    }
  });
  const endBtn = document.createElement('button');
  endBtn.type = 'button';
  endBtn.textContent = 'End course';
  endBtn.addEventListener('click', () => finishCourse('ended'));
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'You start at the START flag. Plot the points from the score card, navigate to each, punch its stake, then come back to the start and end the course.';
  coursePanel.append(h, select, seedRow, startBtn, endBtn, note);
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

async function start() {
  setStatus(`Loading site "${siteId}" ...`);
  const base = `sites/${encodeURIComponent(siteId)}`;
  const [data, mapTexture] = await Promise.all([loadSite(base), loadMapTexture(base)]);
  terrain = buildTerrain(renderer, data);
  scene.add(terrain.group);
  tools = new Tools({ renderer, camera, site: data.site, mapTexture, settings });
  for (const hand of ['left', 'right']) if (hands[hand].grip) tools.attach(hand, hands[hand]);
  siteData = data;
  buildCoursePanel(await loadCourseIndex(base));
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
    renderer.render(scene, camera);
    updateHud(dt);
  });

  // Exposed for automated checks and console poking. Not a gameplay API.
  window.__landnav = {
    camera, player, terrain, site: data.site, field: data.field, renderer, scene, settings, loco, input, tools, beacon, wrist, startCourse,
    get run() { return run; },
  };

  // ?course=<id> loads a listed course; ?course=gen:<seed> generates one.
  const want = params.get('course');
  if (want) {
    const index = await loadCourseIndex(base);
    const listed = index.find((c) => c.id === want);
    if (listed) await startCourse(await loadCourse(base, listed.file));
    else if (want.startsWith('gen:')) await startCourse(generateCourse(data.site, data.field, Number(want.slice(4)) || 1));
    else showToast(`No course "${want}" for this site.`);
  }
}

start().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err.message}`, true);
});
