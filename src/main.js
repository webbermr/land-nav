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
import { gridAzimuth, gridToMagnetic, eightDigitGrid, sceneToUtm } from './coords.js';
import { Tools } from './tools.js';
import { loadMapTexture } from './map.js';
import { CourseRun, loadCourse, loadCourseIndex, formatClock } from './course.js';
import { generateCourse, validateCourse } from './course-logic.js';
import { createBeadsModel, createScoreCard } from './wrist.js';
import { createInfoCard } from './info-card.js';
import { compassPoint, formatTemp, formatWind, formatDistance, formatElevation, formatLatLon, formatDay, utcLabel } from './info-logic.js';
import { fromUtm } from './utm.js';
import { Vegetation, VEGETATION_QUALITY } from './vegetation.js';
import { forestCover, hashString } from './vegetation-logic.js';
import { Environment, castShadows } from './environment.js';
import { worldTime, clockText, guessUtcOffsetMin, sceneDirection, localMidnight, sunTimes } from './sun-logic.js';
import { Soundscape } from './soundscape.js';
import { WeatherService, WeatherVisuals } from './weather.js';
import { weatherEffects, phenology, seasonPhenology, dayOfYear, WEATHER_MODES, WEATHER_MODE_NAMES, SEASONS, presetWeather, seasonName } from './weather-logic.js';
import { setGroundFx } from './ground-fx.js';
import { SWAY } from './vegetation.js';
import { loadFeatures, buildFeatures } from './features.js';
import { LandCover, landcoverCover, NLCD_NAMES } from './landcover.js';
import { FeatureIndex, stakeAvoider, nearestLinePoint } from './features-logic.js';
import { resolveCollisions } from './collision.js';
import { analyzeRun, buildRunExport } from './aar-logic.js';
import { drawReview, createReviewBoard, downloadRun } from './aar.js';
import { createVrMenu, cycle } from './vr-menu.js';
import { Teleporter } from './teleport.js';
import { rayGround } from './teleport-logic.js';
import { RED_LIGHT, NO_LIGHT, tintUnlit, createHeadlamp, HEADLAMP_INTENSITY } from './night.js';
import { dataUrl } from './data-url.js';
import { buildInstantSite, instantSiteData, cacheKey, loadCachedSite, saveCachedSite } from './instant-site.js';
import { loadSkirtAerial, loadFarField, buildFarRing, fetchFarAerial } from './aerial.js';
import { GROUND_FX } from './ground-fx.js';
import {
  sceneToLatLon, latLonToScene, squareStep, neighbourCentre, edgeStep, pushingOut, arrivalOn,
  loadPlaces, savePlaces, sortPlaces, addPlace, touchRecent, removePlace, spotName,
} from './travel-logic.js';

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
// Sky, sun and light for the site's place and time (src/environment.js). The site
// isn't known yet; start() tells it.
const env = new Environment(scene, renderer, null);
scene.background = new THREE.Color().copy(env.horizon);
scene.fog = new THREE.Fog(new THREE.Color(), 1500, 7000);
// Weather: where it comes from (made in start(), once the site is known) and the
// rain, snow and lightning it draws.
let weatherService = null;
const weatherFx = new WeatherVisuals(scene);
let weatherNow = presetWeather('clear');
let fx = weatherEffects(weatherNow);
let phen = { leaf: 1, autumn: 0, spring: 0 };
let farRing = null; // terrain out to 20 km (src/aerial.js), once loaded

const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 9000);
camera.rotation.order = 'YXZ';
const player = new THREE.Group();
player.name = 'player';
player.add(camera);
scene.add(player);

let vegetation = null;
const headlamp = createHeadlamp(camera);
let headlampOn = true;

// Night rules (short sight, red light, luminous marks) apply on a night course, after
// N, or when the clock says it's dark.
const isNight = () => settings.night || env.dark;

// How far you can see, by preset, darkness and (later) weather.
// Dusk closes in gradually: from the day range at the end of civil twilight to the
// night range once the sky is properly dark.
function fogRange() {
  // Open: haze, out to the horizon when the far terrain is there.
  const open = farRing?.visible ? [2500, 32000] : [1500, 7000];
  let day = settings.preset === 'woods' ? [settings.woodsVisibility * 0.15, settings.woodsVisibility] : open;
  // Fog, rain and snow: you see as far as the weather report says.
  if (fx.visibilityM < day[1]) day = [Math.min(day[0], fx.visibilityM * 0.04), Math.max(30, fx.visibilityM)];
  if (settings.night) return [2, settings.nightVisibility];
  if (!env.dark) return day;
  const k = THREE.MathUtils.smoothstep(-env.elevation, 5, 12);
  return [THREE.MathUtils.lerp(day[0], 2, k), THREE.MathUtils.lerp(day[1], settings.nightVisibility, k)];
}

// Woods: you see about 150 m. Open: light haze, so distant ridges fade like real air.
// Night: starlight under the canopy, tree silhouettes to about 60 m, and a headlamp.
function applyPreset() {
  updateWorldClock(true);
  const night = isNight();
  [scene.fog.near, scene.fog.far] = fogRange();
  headlamp.intensity = night && headlampOn ? HEADLAMP_INTENSITY : 0;
  tools?.compass.setNight(night);
  applyNightTint();
  if (vegetation) {
    vegetation.setPreset(settings.preset);
    vegetation.setNight(night);
    vegetation.setLight(Math.min(1, env.hemi.intensity / 0.95 * 0.6 + env.sun.intensity / 2.2 * 0.4));
    applyCanopyRange();
  }
}

// What you read by (src/night.js): red under the headlamp, near black without it.
function applyNightTint() {
  const tint = isNight() ? (headlampOn ? RED_LIGHT : NO_LIGHT) : null;
  for (const root of [tools?.compass.group, tools?.map.group, wrist.card.mesh, run?.group]) tintUnlit(root, tint);
  tintUnlit(wrist.info.mesh, tint);
}

function setNight(on) {
  settings.night = on;
  applyPreset();
}

// N, or the menu: night, or back to day (moving the clock to noon if it's dark out).
function toggleDayNight() {
  if (isNight()) {
    settings.night = false;
    if (env.dark) settings.timeOfDay = 12 * 60;
    applyPreset();
    showToast(`Day: ${timeOfDayText()}.`);
  } else {
    setNight(true);
    showToast('Night. T switches the headlamp.');
  }
}

// Time of day: the real time ("Now") or any hour you pick. Not remembered between visits.
const TIME_CHOICES = [-1, ...Array.from({ length: 24 }, (_, h) => h * 60)];
function setTimeOfDay(minutes) {
  settings.timeOfDay = minutes;
  settings.night = false;
  applyPreset();
}
function timeOfDayText() {
  const t = clockText(worldDate(), env.offsetMin);
  return settings.timeOfDay < 0 ? `Now (${t})` : t;
}

function toggleHeadlamp() {
  headlampOn = !headlampOn;
  applyPreset();
  if (isNight()) showToast(headlampOn ? 'Headlamp on.' : 'Headlamp off: only luminous marks show.');
}

// ---- The world clock: the sun follows the real time, or the time you pick ----

let courseClockMin = -1; // a course runs at a fixed time of day
let clockNext = 0;
let wasNight = null;
function clockMinutes() {
  return run && run.state !== 'ended' ? courseClockMin : settings.timeOfDay;
}
// A replayed day puts the clock (and the sun) on that date.
function replayDay() {
  if (settings.weather !== 'replay' || (run && run.state !== 'ended')) return '';
  if (settings.weatherDate) return settings.weatherDate;
  const d = new Date(Date.now() - 365 * 86400000);
  return d.toISOString().slice(0, 10);
}
function worldDate() {
  return worldTime(Date.now(), clockMinutes(), env.offsetMin, replayDay());
}

// The weather and season for the world clock, and what they do to the scene.
function updateWeather(date) {
  if (weatherService) {
    const minute = (date.getTime() - localMidnight(date, env.offsetMin)) / 60000;
    weatherNow = weatherService.get(settings.weather, { date: replayDay(), minuteOfDay: minute });
    if (weatherService.offsetMin !== null && settings.weather !== 'pick') env.offsetMin = weatherService.offsetMin;
  }
  fx = weatherEffects(weatherNow);
  env.weather = { cloud: fx.cloud, gloom: fx.gloom };
  const site = env.site;
  phen = settings.season === 'auto'
    ? phenology(dayOfYear(date, env.offsetMin), site?.center_lat ?? 38.5, site ? site.elev_ref + (site.elev_max - site.elev_min) / 2 : 300)
    : seasonPhenology(settings.season);
  setGroundFx(phen, fx);
  vegetation?.setSeason(phen);
  vegetation?.setVisibility(fx.visibilityM);
}
// Every half second (or at once with force): move the sun, recolour the sky, and
// switch night rules on or off when dusk or dawn passes.
function updateWorldClock(force = false) {
  const now = performance.now();
  if (!force && now < clockNext) return;
  clockNext = now + 500;
  const date = worldDate();
  updateWeather(date);
  env.setTime(date, { forceNight: settings.night });
  // After dark, far things fade into the dark ground, not the pale strip of sky.
  scene.fog.color.copy(env.horizon).multiplyScalar(isNight() ? 0.3 : 1);
  scene.background.copy(env.horizon);
  if (!settings.night) [scene.fog.near, scene.fog.far] = fogRange();
  // Unlit far-tree cut-outs follow the light level.
  vegetation?.setLight(Math.min(1, env.hemi.intensity / 0.95 * 0.6 + env.sun.intensity / 2.2 * 0.4));
  const night = isNight();
  if (!force && wasNight !== null && night !== wasNight) applyPreset();
  wasNight = night;
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
const soundscape = new Soundscape(settings);
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
// The card on the wrist is the score card during a course (and its result after),
// and the info card when exploring.
const wrist = { beads: createBeadsModel(), card: createScoreCard(), info: createInfoCard(), cardShown: false, showResult: false };
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
function showToast(text, ms = 3500) {
  toast = text ? { text, until: performance.now() + ms } : null;
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
    else toggleDayNight();
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
  if (key === 'timeOfDay') setTimeOfDay(settings.timeOfDay);
  if (key === 'shadows') env.setShadows(settings.shadows);
  if (key === 'farView') { if (settings.farView && !farRing && siteData) loadFarView(siteData.site); applyFarView(); }
  if (key === 'weather' || key === 'weatherDate' || key === 'season') applyPreset();
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
  const onward = siteData && !siteData.site.synthetic && !courseRunning();
  boundaryWarning = edge <= settings.boundaryWarn
    ? (edge <= 0.01
      ? (onward ? 'Edge of this area. Keep going to carry on into the next one.' : 'Boundary. You cannot go farther.')
      : (onward ? 'Near the edge of this area. The next one is getting ready.' : 'Approaching the boundary.'))
    : '';
}

// ---- Per-frame update ----

const fwd = new THREE.Vector3();
const head = new THREE.Vector3();
const lastHeading = new THREE.Vector3(0, 0, -1);
let snapArmed = true;

// ---- Weather, every frame: rain and snow around you, lightning, wind ----

const windTo = new THREE.Vector3();
function updateWeatherFrame(dt) {
  const d = sceneDirection(weatherNow.windFromDeg + 180, 0, env.site?.convergence_deg ?? 0);
  windTo.set(d.x, 0, d.z).multiplyScalar(weatherNow.windMs);
  const light = Math.min(1, env.hemi.intensity / 0.95);
  weatherFx.update(dt, head, fx, windTo, light, weatherNow.thunder, (metres) => {
    // Thunder arrives at the speed of sound.
    setTimeout(() => soundscape.ctx && soundscape.thunder(Math.max(0.3, 1 - metres / 6000)), (metres / 343) * 1000);
  });
  // A flash lights everything for a moment.
  env.hemi.intensity = env.hemiBase + weatherFx.flash * 2.5;
  SWAY.time.value += dt;
  SWAY.amp.value = 0.08 + fx.sway * 1.1;
  // Clouds drift with the wind.
  env.sky.uniforms.cloudShift.value.x += windTo.x * dt * 0.0006;
  env.sky.uniforms.cloudShift.value.y += windTo.z * dt * 0.0006;
}

// ---- Nature sounds (src/soundscape.js) ----

const listenFwd = new THREE.Vector3(), listenUp = new THREE.Vector3();
let streamNear = null, streamNext = 0;
function updateSound(dt) {
  if (!soundscape.ctx && footfalls.ctx) soundscape.start(footfalls.ctx);
  if (!soundscape.ctx || !terrain) return;
  camera.getWorldDirection(listenFwd);
  listenUp.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
  const now = performance.now();
  if (now > streamNext) {
    streamNext = now + 500;
    streamNear = featureIndex ? nearestLinePoint(featureIndex, head.x, head.z, ['stream'], 80) : null;
  }
  const w = weatherState();
  const date = env.date ?? new Date();
  const month = new Date(date.getTime() + env.offsetMin * 60000).getUTCMonth() + 1;
  soundscape.update(dt, {
    head, fwd: listenFwd, up: listenUp,
    sunElev: env.elevation,
    windMs: w.windMs,
    cover: vegetation ? vegetation.coverAt(head.x, head.z) * (settings.preset === 'woods' ? 1 : 0.6) : 0,
    heightAboveGround: head.y - terrain.heightAt(head.x, head.z),
    stream: streamNear,
    rainMmH: w.rainMmH, snowing: w.snowing, tempC: w.tempC, thunder: w.thunder,
    month, leafOn: w.leafOn,
  });
}
// The weather as the sound and light see it. Fair and breezy until weather.js says otherwise.
function weatherState() {
  const w = weatherNow;
  return { windMs: w.windMs, rainMmH: w.rainMmH, snowing: w.snowCmH > 0, tempC: w.tempC, thunder: false, leafOn: phen.leaf };
}

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
// Places: save where you are, go back to a saved place or a recent square. Each
// slot shows one place; the right half of its box goes there, the left half
// (pressed twice) forgets it.
const PLACE_SLOTS = 8;
const MENU_CLOSE = { label: 'Close', press: () => vrMenu.hide() };
const placeAt = (i) => sortPlaces(places)[i];
const placeItems = [
  { label: 'Save this spot', value: () => 'Save', enabled: () => !!siteData, press: () => saveSpot() },
  ...Array.from({ length: PLACE_SLOTS }, (_, i) => ({
    label: () => { const p = placeAt(i); return p ? `${p.name}${p.recent ? ' (recent)' : ''}` : '-'; },
    value: () => (placeAt(i) ? (removeArmed?.place === placeAt(i) && performance.now() < removeArmed.until ? '‹ remove?' : 'Go ›') : ''),
    enabled: () => !!placeAt(i) && !traveling,
    press: (d) => {
      const p = placeAt(i);
      if (!p) return;
      if (d > 0) { removeArmed = null; vrMenu.hide(); goToPlace(p); return; }
      if (removeArmed?.place === p && performance.now() < removeArmed.until) { removeArmed = null; forgetPlace(p); return; }
      removeArmed = { place: p, until: performance.now() + 3000 };
    },
  })),
];

// Four pages, picked with the tabs along the top.
const MENU_PAGES = [
  { title: 'World', items: [
    { label: 'Time of day', value: () => timeOfDayText(), enabled: () => !courseRunning(), repeat: true,
      press: (d) => setTimeOfDay(cycle(TIME_CHOICES, settings.timeOfDay, d)) },
    { label: 'Weather', value: () => WEATHER_MODE_NAMES[settings.weather] ?? settings.weather,
      press: (d) => changeSetting('weather', cycle(WEATHER_MODES, settings.weather, d)) },
    { label: 'Replay date', value: () => replayDay() || '-', enabled: () => settings.weather === 'replay' && !courseRunning(), repeat: true,
      press: (d) => changeSetting('weatherDate', shiftDate(replayDay(), d)) },
    { label: 'Season', value: () => (settings.season === 'auto' ? 'From the date' : settings.season[0].toUpperCase() + settings.season.slice(1)),
      press: (d) => changeSetting('season', cycle(SEASONS, settings.season, d)) },
    { label: 'Woods or open', value: () => (settings.preset === 'woods' ? 'Woods' : 'Open'),
      press: () => { settings.preset = settings.preset === 'woods' ? 'open' : 'woods'; applyPreset(); saveSettings(settings); } },
    { label: 'Headlamp', value: () => onOff(headlampOn), enabled: () => isNight(), press: () => toggleHeadlamp() },
    { label: 'Shadows', value: () => onOff(settings.shadows), press: () => changeSetting('shadows', !settings.shadows) },
    { label: 'Far view (photos, far hills)', value: () => onOff(settings.farView), press: () => changeSetting('farView', !settings.farView) },
    { label: 'Trees', value: () => settings.vegetation[0].toUpperCase() + settings.vegetation.slice(1),
      press: (d) => changeSetting('vegetation', cycle(['off', 'low', 'medium', 'high'], settings.vegetation, d)) },
    { label: 'Nature sounds', value: () => `${Math.round(settings.ambientVolume * 100)}%`,
      press: (d) => changeSetting('ambientVolume', cycle([0, 0.2, 0.4, 0.6, 0.8, 1], settings.ambientVolume, d)) },
    { label: 'Close', press: () => vrMenu.hide() },
  ] },
  { title: 'Moving', items: [
    { label: 'Fly', value: () => onOff(fly), enabled: () => !courseRunning(), press: () => setFly(!fly) },
    { label: 'Teleport range', value: () => `${settings.teleportRange} m`,
      press: (d) => changeSetting('teleportRange', cycle([20, 40, 60, 100, 150], settings.teleportRange, d)) },
    { label: 'Turning (right stick)', value: () => ({ snap: 'Snap', smooth: 'Smooth', off: 'Off' })[settings.turn],
      press: (d) => changeSetting('turn', cycle(['snap', 'smooth', 'off'], settings.turn, d)) },
    { label: 'Snap angle', value: () => `${settings.snapTurnDeg}°`, enabled: () => settings.turn === 'snap',
      press: (d) => changeSetting('snapTurnDeg', cycle([15, 30, 45], settings.snapTurnDeg, d)) },
    { label: 'Smooth turn speed', value: () => `${settings.smoothTurnDegPerSec}°/s`, enabled: () => settings.turn === 'smooth',
      press: (d) => changeSetting('smoothTurnDegPerSec', cycle([45, 90, 135], settings.smoothTurnDegPerSec, d)) },
    { label: 'Trees and buildings block you', value: () => onOff(settings.collisions), press: () => changeSetting('collisions', !settings.collisions) },
    { label: 'Pace count per 100 m', value: () => String(settings.paceCountPer100m), repeat: true, press: step('paceCountPer100m', 30, 120) },
    { label: 'Jogging pace count', value: () => String(settings.jogPaceCountPer100m), repeat: true, press: step('jogPaceCountPer100m', 25, 100) },
    { label: 'Time compression', value: () => `${settings.timeScale}x`, press: (d) => changeSetting('timeScale', cycle([1, 2, 3], settings.timeScale, d)) },
    { label: 'Comfort vignette', value: () => `${Math.round(settings.vignette * 100)}%`,
      press: (d) => changeSetting('vignette', cycle([0, 0.25, 0.5, 0.75, 1], settings.vignette, d)) },
    { label: 'Close', press: () => vrMenu.hide() },
  ] },
  { title: 'Places', items: [...placeItems, MENU_CLOSE] },
  { title: 'Tools', items: [
    { label: 'Compass lens', value: () => (settings.units === 'mils' ? 'Mils' : 'Degrees'),
      press: () => changeSetting('units', settings.units === 'mils' ? 'deg' : 'mils') },
    { label: 'Assisted map readout', value: () => onOff(settings.assisted), press: () => changeSetting('assisted', !settings.assisted) },
    { label: "Allow 'show my position'", value: () => onOff(settings.lostHelp), press: () => changeSetting('lostHelp', !settings.lostHelp) },
    { label: 'Exploring: me on the map', value: () => onOff(settings.exploreMapPosition), press: () => changeSetting('exploreMapPosition', !settings.exploreMapPosition) },
    { label: 'Info card units', value: () => (settings.infoUnits === 'metric' ? 'Metric' : 'US'),
      press: () => changeSetting('infoUnits', settings.infoUnits === 'metric' ? 'us' : 'metric') },
    { label: 'Close', press: () => vrMenu.hide() },
  ] },
];
// A day earlier or later, never past yesterday (there's no record of tomorrow yet).
function shiftDate(ymd, days) {
  const t = Date.parse(`${ymd}T12:00:00Z`) + days * 86400000;
  const latest = Date.now() - 86400000;
  return new Date(Math.min(t, latest)).toISOString().slice(0, 10);
}
const vrMenu = createVrMenu(MENU_PAGES, {
  title: 'Menu',
  hint: 'Point with the right controller and pull the trigger. The tabs pick a page; the left or right side of a value steps it down or up. Hold X to close.',
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

// What's underfoot: a road or trail from the site's features, else leaf litter
// under trees, else grass.
function surfaceUnder(x, z) {
  const f = featureIndex?.surfaceAt(x, z);
  if (f === 'road' || f === 'parking' || f === 'track' || f === 'trail' || f === 'stream') return f;
  return vegetation && vegetation.coverAt(x, z) > 0.4 ? 'litter' : 'grass';
}

function playFeet(feet, haptics) {
  if (!feet.length) return;
  camera.getWorldPosition(head);
  const surface = surfaceUnder(head.x, head.z);
  for (const foot of feet) footfalls.play(foot, haptics, surface);
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
    checkTravel(dt, player.position.x, player.position.z, dirX, dirZ);
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
  checkTravel(dt, player.position.x, player.position.z, dirX, dirZ);
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
    checkTravel(dt, head.x, head.z, dirX, dirZ);
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
  checkTravel(dt, head.x, head.z, dirX * stick.mag, dirZ * stick.mag);
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
  if (!shown) wrist.showResult = false;
  updateCardKind();
}
function updateCardKind() {
  const score = !!run && (run.state !== 'ended' || wrist.showResult);
  wrist.card.mesh.visible = wrist.cardShown && score;
  wrist.info.mesh.visible = wrist.cardShown && !score;
}

// The wrist kit lives on the left controller in VR and in the corners of the screen on desktop.
function mountWrist() {
  const grip = hands.left.grip;
  if (renderer.xr.isPresenting && grip) {
    grip.add(wrist.beads.group);
    wrist.beads.group.position.set(-0.04, -0.06, 0.06);
    wrist.beads.group.rotation.set(0, 0, 0);
    wrist.beads.group.scale.setScalar(1);
    for (const card of [wrist.card.mesh, wrist.info.mesh]) {
      grip.add(card);
      card.position.set(0, 0.04, 0.12);
      card.rotation.set(-1.15, 0, 0);
      card.scale.setScalar(1);
    }
  } else {
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.add(wrist.beads.group);
    wrist.beads.group.position.set(-t * camera.aspect * 0.4 * 0.88, -0.06, -0.4);
    wrist.beads.group.scale.setScalar(0.9);
    for (const card of [wrist.card.mesh, wrist.info.mesh]) {
      camera.add(card);
      card.position.set(t * camera.aspect * 0.45 * 0.68, -0.02, -0.45);
      card.rotation.set(0, 0, 0);
      card.scale.setScalar(1.4);
    }
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
  // A course runs at a set time of day: mid-morning, or 22:00 for a night course.
  courseClockMin = settings.night ? 22 * 60 : 10 * 60 + 30;
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

// ---- Explore: the info card, and your position on the map ----

let infoNext = 0;
let sunDayKey = '', sunDay = null;
const exploring = () => !run || run.state === 'ended';
function updateExplore(x, z) {
  updateCardKind();
  const now = performance.now();
  // Exploring, the map shows where you are (no penalty: there's no course).
  if (tools) {
    if (exploring() && settings.exploreMapPosition) tools.map.showPosition(x, z, facingGridAz());
    else if (!revealUntil) tools.map.hidePosition();
  }
  if (!wrist.info.mesh.visible || now < infoNext) return;
  infoNext = now + 500;
  wrist.info.draw(infoCardContent(x, z));
}

function facingGridAz() {
  if (renderer.xr.isPresenting) {
    camera.getWorldDirection(fwd);
    return gridAzimuth(fwd.x, fwd.z);
  }
  return gridAzimuth(-Math.sin(input.yaw), -Math.cos(input.yaw));
}

function infoCardContent(x, z) {
  const site = siteData.site;
  const u = settings.infoUnits;
  const date = env.date ?? new Date();
  const off = env.offsetMin;
  const dayKey = `${Math.floor((date.getTime() + off * 60000) / 86400000)}:${off}`;
  if (dayKey !== sunDayKey) { sunDayKey = dayKey; sunDay = sunTimes(date, site.center_lat, site.center_lon, off); }
  const w = weatherNow;
  const { easting, northing } = sceneToUtm(site, x, z);
  const ll = fromUtm(easting, northing, parseInt(site.utm_zone, 10), !/S$/.test(site.utm_zone));
  const gridAz = facingGridAz();
  const magAz = gridToMagnetic(gridAz, site.gm_angle_deg);
  const surface = featureIndex?.surfaceAt(x, z);
  const cover = landcover ? NLCD_NAMES[landcover.classAt(x, z)] : null;
  const ground = [surface, cover].filter(Boolean).join(', ') || (vegetation && vegetation.coverAt(x, z) > 0.4 ? 'woods' : 'open ground');
  const sunUp = sunDay.rise && sunDay.set ? `up ${clockText(sunDay.rise, off)}, down ${clockText(sunDay.set, off)}` : 'no sunrise today';
  const sunNow = env.elevation > -0.8 ? `${Math.round(env.elevation)}° up in the ${compassPoint(env.azimuth)}` : 'below the horizon';
  const leaf = phen.leaf < 0.05 ? 'bare woods' : phen.leaf < 0.95 ? (phen.spring > 0 ? 'leafing out' : 'leaves falling') : phen.autumn > 0.2 ? 'autumn colour' : 'in leaf';
  const source = weatherService?.status || '';
  const hint = renderer.xr.isPresenting ? 'X hides this; hold X for the menu.' : 'Tab hides this.';
  return {
    title: site.name,
    subtitle: `Exploring  ·  ${formatDay(date, off)}`,
    rows: [
      ['Time', `${clockText(date, off)} ${utcLabel(off)}${settings.timeOfDay >= 0 || replayDay() ? ' (set)' : ''}`],
      ['Sun', sunUp],
      ['', sunNow],
      null,
      ['Weather', w.label],
      ['Temperature', formatTemp(w.tempC, u)],
      ['Wind', formatWind(w.windMs, w.windFromDeg, w.gustMs, u)],
      ['Visibility', formatDistance(w.visibilityM, u)],
      ['Season', `${seasonName(phen)}, ${leaf}`],
      null,
      ['Grid', eightDigitGrid(site, x, z)],
      ['Lat, lon', formatLatLon(ll.lat, ll.lon)],
      ['Elevation', formatElevation(site.elev_ref + terrain.heightAt(x, z), u)],
      ['Facing', `${Math.round(magAz)}° magnetic (${compassPoint(gridAz + (site.convergence_deg ?? 0))})`],
      ['Ground', ground],
    ],
    footer: `${source}${/Open-Meteo/.test(source) ? ' (weather data by Open-Meteo.com)' : ''}. ${hint}`,
  };
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
  wrist.showResult = true;
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
  updateExplore(x, z);
  if (!run) return;
  const wasRunning = run.state === 'running';
  run.update(dt, { x, z }, { moving, mapOut: tools?.map.group.visible, compassOut: tools?.compass.group.visible, jog: moving && loco.lastGait === 'jog' });
  if (wasRunning && run.state === 'ended') {
    wrist.showResult = true;
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
  if (xrInput.justPressed('left', 'trigger') && isNight()) { toggleHeadlamp(); xrInput.pulse('left', 0.2, 15); }
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
      if (sitePick.value === siteId) return;
      coursePanel.hidden = true;
      travelTo({ siteId: sitePick.value }).then((ok) => { if (!ok) sitePick.value = siteId; });
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
  builder.append(link, ': pick any spot in the US and explore it right away, or build a permanent site with courses.');
  const ph = document.createElement('h2');
  ph.textContent = 'Places';
  const placesBox = Object.assign(document.createElement('div'), { id: 'places' });
  coursePanel.append(h, select, seedRow, nightRow, startBtn, endBtn, reviewBtn, note, ph, placesBox, builder);
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

// In the headset the page's HUD can't be seen, so messages (and the edge warning)
// show on a small card low in front of you.
const vrNote = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 128;
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.08),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  mesh.name = 'vr-note';
  mesh.renderOrder = 998;
  mesh.position.set(0, -0.2, -0.9);
  mesh.visible = false;
  camera.add(mesh);
  let last = '';
  return {
    mesh,
    show(text) {
      mesh.visible = !!text;
      if (!text || text === last) return;
      last = text;
      g.clearRect(0, 0, 1024, 128);
      g.fillStyle = 'rgba(22, 26, 31, 0.88)';
      g.beginPath(); g.roundRect(0, 0, 1024, 128, 24); g.fill();
      g.fillStyle = '#ffd27a';
      g.font = `600 ${text.length > 60 ? 30 : 38}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, 512, 64, 980);
      tex.needsUpdate = true;
    },
  };
})();

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
    `${mode}  ${settings.preset}  ${clockText(env.date ?? new Date(), env.offsetMin)}${isNight() ? `  NIGHT (headlamp ${headlampOn ? 'on' : 'off'})` : ''}  ${weatherNow.label}  ${fps.toFixed(0)} fps  ${info.calls} calls  ${(info.triangles / 1000).toFixed(0)}k tris`,
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
  const toastOn = toast && performance.now() < toast.until;
  if (toastOn) lines.push(`> ${toast.text}`);
  vrNote.show(renderer.xr.isPresenting ? (toastOn ? toast.text : boundaryWarning) : '');
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

// ---- Worlds: a site from sites/, or a square built here in the browser ----
//
// A world spec: { siteId } or { lat, lon, size, name }. fetchWorld gets its data;
// installWorld swaps it in, in place, so you can move between squares without a
// reload (and without leaving VR).

// The square built here in the browser for a spec, from the browser's copy when it has one.
const building = new Map(); // cache key -> promise, so a prefetch and a travel share one build
function buildOrLoad({ lat, lon, size = 2000, name = '', rebuild = false }, onProgress = () => {}) {
  const key = cacheKey(lat, lon, size);
  if (!rebuild && building.has(key)) return building.get(key);
  const p = (async () => {
    let built = rebuild ? null : await loadCachedSite(key);
    if (!built) {
      onProgress('Building this place from USGS, NLCD and OpenStreetMap data ...');
      built = await buildInstantSite({ lat, lon, size, name, onProgress });
      saveCachedSite(key, built);
    }
    if (name) built.site.name = name;
    return built;
  })();
  building.set(key, p);
  p.catch(() => building.delete(key));
  return p;
}

async function fetchWorld(spec, onProgress = () => {}) {
  if (spec.siteId) {
    const base = `sites/${encodeURIComponent(spec.siteId)}`;
    const [data, mapTexture] = await Promise.all([loadSite(base), loadMapTexture(base)]);
    const features = await loadFeatures(base, data.site);
    const lc = await loadLandCover(base, data.site);
    return { spec, base, data, mapTexture, features, landcover: lc, farField: null, courseIndex: await loadCourseIndex(base), instant: false };
  }
  const built = await buildOrLoad(spec, onProgress);
  const d = instantSiteData(built);
  return {
    spec: { lat: spec.lat, lon: spec.lon, size: spec.size || 2000, name: built.site.name },
    base: null, data: d, mapTexture: new THREE.CanvasTexture(built.mapCanvas), features: d.features, landcover: d.landcover,
    farField: d.farField, courseIndex: [], instant: true,
  };
}

let worldSpec = null;
let featureGroup = null;
let siteList = [];

function disposeTree(root) {
  root?.removeFromParent();
  root?.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); }
  });
}

// Take the current world out: terrain, trees, roads, tools, far view, course.
function removeWorld() {
  run?.dispose();
  run = null;
  hideReview();
  if (terrain) disposeTree(terrain.group);
  vegetation?.dispose();
  disposeTree(featureGroup);
  disposeTree(farRing);
  farRing = null;
  GROUND_FX.aerialBox.value.w = 0;
  if (tools) {
    tools.map.group.removeFromParent();
    tools.compass.group.removeFromParent();
    tools.rayLine.removeFromParent();
  }
  if (beacon) { scene.getObjectByName('beacon')?.removeFromParent(); beacon = null; }
}

function installWorld(w) {
  removeWorld();
  const { data, mapTexture, features } = w;
  worldSpec = w.spec;
  siteId = data.site.id;
  env.site = data.site;
  env.offsetMin = guessUtcOffsetMin(data.site.center_lon, new Date());
  weatherService = new WeatherService(data.site);
  mapImage = mapTexture.image;
  lastRun = loadLastRun(data.site.id);
  landcover = w.landcover;
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
  featureGroup = buildFeatures(features, data.field);
  scene.add(featureGroup);
  // Shadows: trees and buildings cast them; the ground, roads and buildings take them.
  castShadows(terrain.group, { cast: false, receive: true });
  castShadows(featureGroup, { cast: false, receive: true });
  for (const name of ['roofs', 'walls']) castShadows(featureGroup.getObjectByName(name), { cast: true, receive: true });
  vegetation.castShadows();
  env.setShadows(settings.shadows);
  const wasMap = tools?.desktopMap, wasCompass = tools?.desktopCompass;
  tools = new Tools({ renderer, camera, site: data.site, mapTexture, settings });
  for (const hand of ['left', 'right']) if (hands[hand].grip) tools.attach(hand, hands[hand]);
  if (!renderer.xr.isPresenting && (wasMap || wasCompass)) {
    tools.desktopMap = !!wasMap; tools.desktopCompass = !!wasCompass;
    tools.mountDesktop();
  }
  siteData = data;
  applyPreset(); // night tint and compass lume for the tools just made
  buildCoursePanel(w.courseIndex, w.instant ? [...siteList, { id: siteId, name: `${data.site.name} (built here)` }] : siteList);
  if (settings.farView) loadFarView(data.site, w.farField);
  mountWrist();
  document.title = `${data.site.name} | Land Nav`;
  // The address says where you are, so a reload comes back here.
  const q = new URLSearchParams(location.search);
  for (const k of ['site', 'at', 'size', 'name', 'course', 'rebuild']) q.delete(k);
  if (w.instant) {
    q.set('at', `${w.spec.lat.toFixed(5)},${w.spec.lon.toFixed(5)}`);
    if (w.spec.size !== 2000) q.set('size', w.spec.size);
    if (w.spec.name) q.set('name', w.spec.name);
    places = touchRecent(places, { name: data.site.name, lat: Number(w.spec.lat.toFixed(5)), lon: Number(w.spec.lon.toFixed(5)), size: w.spec.size });
    savePlaces(storage(), places);
  } else {
    q.set('site', siteId);
  }
  history.replaceState(null, '', `${location.pathname}?${q}`);
  refreshPlacesPanel();
}

// Put the viewer (the head, in VR) at a scene position on the current world, facing yaw.
function placeViewer(x, z, { yaw = null, alt = null } = {}) {
  const s = terrain.size;
  x = Math.min(s, Math.max(0, x)); z = Math.min(s, Math.max(0, z));
  if (renderer.xr.isPresenting) {
    camera.getWorldPosition(head);
    player.position.x += x - head.x;
    player.position.z += z - head.z;
    player.position.y = terrain.heightAt(x, z) + (fly && alt ? alt : 0);
  } else {
    player.position.set(x, 0, z);
    if (yaw !== null) input.yaw = yaw;
    if (fly && alt) player.position.y = terrain.heightAt(x, z) + alt + settings.eyeHeight;
    else snapPlayerToGround();
  }
}

// ---- Travel: to the next square, or to a saved place ----

let traveling = false;
let travelProgress = '';
async function travelTo(spec, arrive = null) {
  if (traveling) return false;
  if (courseRunning()) { showToast('End the course before going somewhere else.'); return false; }
  traveling = true;
  travelProgress = 'Getting the next area ready ...';
  showToast(travelProgress, 600000);
  try {
    const w = await fetchWorld(spec, (t) => { travelProgress = t; showToast(t, 600000); });
    await new Promise((resolve) => teleporter.jump(() => {
      installWorld(w);
      const p = arrive ? arrive(w.data.site) : { x: w.data.site.size_m / 2, z: w.data.site.size_m / 2 };
      placeViewer(p.x, p.z, p);
      resolve();
    }, 0.5));
    showToast(`${w.data.site.name}.`);
    return true;
  } catch (err) {
    console.error(err);
    showToast(`Could not go there: ${err.message}`);
    return false;
  } finally {
    traveling = false;
  }
}

// Real places only: the synthetic demo has nothing next to it.
const canTravel = () => siteData && !siteData.site.synthetic && !courseRunning() && !traveling;

function neighbourSpec(i, j) {
  const c = neighbourCentre(siteData.site, i, j);
  return { lat: Number(c.lat.toFixed(5)), lon: Number(c.lon.toFixed(5)), size: siteData.site.size_m };
}

// Walking into an edge (or flying past it) carries on into the next square. The
// one you're heading for is built in the background as you near the edge.
const PREFETCH_M = 200;
let edgePushSec = 0;
let prefetched = '';
function checkTravel(dt, x, z, dx, dz) {
  if (!canTravel()) { edgePushSec = 0; return; }
  const site = siteData.site, s = terrain.size;
  const near = edgeStep(s, x, z, PREFETCH_M);
  if (near.i || near.j) {
    const spec = neighbourSpec(near.i, near.j);
    const key = cacheKey(spec.lat, spec.lon, spec.size);
    if (key !== prefetched) {
      prefetched = key;
      buildOrLoad(spec).catch((err) => console.warn('Next square not ready:', err.message));
    }
  }
  const outside = x < -25 || z < -25 || x > s + 25 || z > s + 25;
  if (pushingOut(s, x, z, dx, dz)) edgePushSec += dt; else edgePushSec = 0;
  if (!outside && edgePushSec < 0.8) return;
  edgePushSec = 0;
  // A step past the edge, the way you were going, says which square is next.
  const len = Math.hypot(dx, dz) || 1;
  const px = outside ? x : x + (dx / len) * 3, pz = outside ? z : z + (dz / len) * 3;
  const { i, j } = squareStep(site, Math.min(s + 1, Math.max(-1, px)), Math.min(s + 1, Math.max(-1, pz)));
  if (!i && !j) return;
  const oldSite = site;
  const alt = fly ? Math.max(0, player.position.y - terrain.heightAt(x, z) - (renderer.xr.isPresenting ? 0 : settings.eyeHeight)) : null;
  travelTo(neighbourSpec(i, j), (newSite) => ({ ...arrivalOn(oldSite, px, pz, newSite), alt }));
}

// ---- Saved places ----

let places = loadPlaces(storage());
let removeArmed = null; // { place, until }: the left half of a place's value box, pressed once

function facingPoint() {
  const az = facingGridAz() + (siteData.site.convergence_deg ?? 0);
  return compassPoint(az);
}

function saveSpot() {
  if (!siteData) return;
  const p = currentPos();
  const ll = sceneToLatLon(siteData.site, p.x, p.z);
  const yaw = renderer.xr.isPresenting ? Math.atan2(-fwd.x, -fwd.z) : input.yaw;
  const alt = fly ? Math.max(0, player.position.y - terrain.heightAt(p.x, p.z) - (renderer.xr.isPresenting ? 0 : settings.eyeHeight)) : 0;
  const count = places.filter((q) => !q.recent).length + 1;
  const place = {
    name: spotName(siteData.site.name, count, facingPoint()),
    site: worldSpec.siteId ? { id: worldSpec.siteId } : { lat: worldSpec.lat, lon: worldSpec.lon, size: worldSpec.size },
    view: { lat: ll.lat, lon: ll.lon, yaw, alt: alt > 3 ? Math.round(alt) : 0 },
  };
  places = addPlace(places, place);
  savePlaces(storage(), places);
  refreshPlacesPanel();
  showToast(`Saved: ${place.name}.`);
}

function goToPlace(place) {
  const here = (place.site.id && worldSpec?.siteId === place.site.id)
    || (!place.site.id && worldSpec && !worldSpec.siteId && worldSpec.lat === place.site.lat && worldSpec.lon === place.site.lon && worldSpec.size === place.site.size);
  const arrive = (site) => {
    if (!place.view) return { x: site.size_m / 2, z: site.size_m / 2 };
    const p = latLonToScene(site, place.view.lat, place.view.lon);
    return { ...p, yaw: place.view.yaw, alt: place.view.alt || null };
  };
  if (place.view?.alt && !fly && !courseRunning()) setFly(true);
  if (here) {
    if (courseRunning()) return showToast('Teleport is off during a course.');
    const p = arrive(siteData.site);
    teleporter.jump(() => placeViewer(p.x, p.z, p), 0.3);
    return;
  }
  travelTo(place.site.id ? { siteId: place.site.id } : { ...place.site, name: place.recent ? place.name : '' }, arrive);
}

function forgetPlace(place) {
  places = removePlace(places, place);
  savePlaces(storage(), places);
  refreshPlacesPanel();
  showToast(`Removed ${place.name}.`);
}

// The Course panel's list of places (desktop).
function refreshPlacesPanel() {
  const box = document.getElementById('places');
  if (!box) return;
  box.replaceChildren();
  const save = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Save this spot' });
  save.addEventListener('click', saveSpot);
  box.append(save);
  for (const p of sortPlaces(places)) {
    const row = document.createElement('div');
    row.className = 'place';
    const go = Object.assign(document.createElement('button'), { type: 'button', className: 'go', textContent: p.recent ? `${p.name} (recent)` : p.name });
    go.addEventListener('click', () => { coursePanel.hidden = true; goToPlace(p); });
    const x = Object.assign(document.createElement('button'), { type: 'button', className: 'x', textContent: '✕', title: 'Remove' });
    x.addEventListener('click', () => forgetPlace(p));
    row.append(go, x);
    box.append(row);
  }
}

// ---- The far view: aerial photographs on distant ground, terrain to the horizon ----

async function loadFarView(site, farFieldIn) {
  if (site.synthetic || farRing) return;
  try {
    await loadSkirtAerial(site);
  } catch (err) {
    console.warn('No aerial photographs:', err.message);
  }
  try {
    let far = site.far, field = farFieldIn;
    if (!field) ({ far, field } = await loadFarField(site));
    const tex = await fetchFarAerial(site, far).catch(() => null);
    if (env.site !== site || farRing) { tex?.dispose(); return; } // moved on while it loaded
    farRing = buildFarRing(site, far, field, tex);
    scene.add(farRing);
    camera.far = 45000;
    camera.updateProjectionMatrix();
  } catch (err) {
    console.warn('No far terrain:', err.message);
  }
  applyFarView();
}
function applyFarView() {
  const on = settings.farView;
  if (farRing) farRing.visible = on;
  GROUND_FX.aerialBox.value.w = on && GROUND_FX.aerial.value.image?.width > 1 ? 1 : 0;
  applyPreset();
}

async function start() {
  siteList = await loadSiteIndex();
  // ?weather=<mode>, ?date=YYYY-MM-DD, ?season=<season>: for checks and screenshots.
  if (WEATHER_MODES.includes(params.get('weather'))) settings.weather = params.get('weather');
  if (/^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '')) settings.weatherDate = params.get('date');
  if (SEASONS.includes(params.get('season'))) settings.season = params.get('season');
  // ?time=HH:MM puts the sun at that local time (for checks and screenshots).
  if (/^\d{1,2}:\d{2}$/.test(params.get('time') || '')) {
    const [hh, mm] = params.get('time').split(':').map(Number);
    settings.timeOfDay = hh * 60 + mm;
  }
  // ?at=lat,lon[&size=m][&name=...]: a square built here in the browser; else ?site=, else the first site.
  let spec;
  const at = params.get('at');
  if (at) {
    const [lat, lon] = at.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`"at=${at}" should be latitude,longitude`);
    const size = [1000, 1500, 2000, 3000].includes(Number(params.get('size'))) ? Number(params.get('size')) : 2000;
    spec = { lat, lon, size, name: params.get('name') || '', rebuild: params.has('rebuild') };
  } else {
    spec = { siteId: siteId || siteList[0]?.id || 'demo-synthetic' };
    setStatus(`Loading site "${spec.siteId}" ...`);
  }
  const w = await fetchWorld(spec, (t) => setStatus(`Building: ${t}`));
  installWorld(w);
  const data = w.data;
  if (debug && params.get('beacon')) {
    const [bx, bz] = params.get('beacon').split(',').map(Number);
    if (Number.isFinite(bx) && Number.isFinite(bz)) {
      beacon = { x: bx, z: bz };
      scene.add(makeBeacon(bx, bz));
    }
  }

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
    // Trees, sky and the shadow box follow the viewer; the sun moves with the clock.
    camera.getWorldPosition(head);
    updateWorldClock();
    env.follow(head);
    updateWeatherFrame(dt);
    updateSound(dt);
    vegetation.update(head.x, head.z);
    renderer.render(scene, camera);
    updateHud(dt);
  });

  // Exposed for automated checks and console poking. Not a gameplay API.
  window.__landnav = {
    camera, player, renderer, scene, settings, loco, input, wrist, startCourse, collide,
    // The world changes when you travel, so these are looked up each time.
    get terrain() { return terrain; }, get site() { return siteData.site; }, get field() { return siteData.field; },
    get tools() { return tools; }, get beacon() { return beacon; }, get vegetation() { return vegetation; },
    get featureIndex() { return featureIndex; }, get landcover() { return landcover; },
    travelTo, saveSpot, goToPlace, get places() { return places; }, get traveling() { return traveling; },
    get run() { return run; },
    get lastRun() { return lastRun; },
    get xrJog() { return xrJog; },
    get fly() { return fly; },
    teleporter, teleportTo, env, soundscape, applyPreset, weatherFx,
    get weather() { return { service: weatherService, now: weatherNow, fx, phen }; },
    vrMenu, setFly,
    headlamp, setNight, toggleHeadlamp, get headlampOn() { return headlampOn; },
    showReview, hideReview, reviewBoard,
  };

  // ?course=<id> loads a listed course; ?course=gen:<seed> generates one; add &night
  // to run it at night.
  const want = params.get('course');
  if (want) {
    const index = w.courseIndex;
    const listed = index.find((c) => c.id === want);
    const opts = { night: params.has('night') };
    if (listed) await startCourse(await loadCourse(w.base, listed.file), opts);
    else if (want.startsWith('gen:')) await startCourse(generateCourse(data.site, data.field, Number(want.slice(4)) || 1, genOptions()), opts);
    else showToast(`No course "${want}" for this site.`);
  }
}

start().catch((err) => {
  console.error(err);
  setStatus(`Failed to start: ${err.message}`, true);
});
