// The site builder page (builder.html): place a square on a map, choose what to
// build, and send the request to GitHub as a pre-filled issue. The build runs in
// .github/workflows/build-site.yml. Nothing here needs a GitHub token.
/* global L */
import {
  REPO, slugify, siteSquare, existingSquare, nextCourses, makeRequest, issueUrl, cliCommands,
} from './request.js';
import { dataUrl } from '../data-url.js';

const $ = (id) => document.getElementById(id);
const state = {
  mode: 'new',
  center: null,       // { lat, lon } of the new square
  start: null,        // { lat, lon }
  placingStart: false,
  idEdited: false,
  sites: [],          // [{ id, name, site (site.json), courses: [ids] }]
  courseRows: [],     // [{ id, name, night, preset }]
};

// ---- Map ----

const map = L.map('map', { zoomControl: true }).setView([38.764, -78.296], 12);
const usgs = (name) => L.tileLayer(`https://basemap.nationalmap.gov/arcgis/rest/services/${name}/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 16, attribution: 'USGS The National Map',
});
const layers = {
  'USGS topo': usgs('USGSTopo'),
  'USGS imagery': usgs('USGSImageryTopo'),
  OpenStreetMap: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap contributors',
  }),
};
layers['USGS topo'].addTo(map);
L.control.layers(layers).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const existingLayer = L.layerGroup().addTo(map);
let squareLayer = null, centerMarker = null, startMarker = null;

const dot = (color) => L.divIcon({
  className: '', iconSize: [16, 16], iconAnchor: [8, 8],
  html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 3px #000"></div>`,
});

function drawSquare(sq, color) {
  return L.polygon(sq.corners.map((c) => [c.lat, c.lon]), { color, weight: 2, fillOpacity: 0.08 });
}

map.on('click', (e) => {
  if (state.mode !== 'new') return;
  if (state.placingStart) {
    state.start = { lat: e.latlng.lat, lon: e.latlng.lng };
    setPlacingStart(false);
  } else {
    state.center = { lat: e.latlng.lat, lon: e.latlng.lng };
  }
  update();
});

function setPlacingStart(on) {
  state.placingStart = on;
  $('place-start').setAttribute('aria-pressed', String(on));
  $('place-start').textContent = on ? 'Click the map ...' : 'Place the start';
  map.getContainer().style.cursor = on ? 'crosshair' : '';
}

// ---- Sites already built ----

async function getJson(url) {
  const res = await fetch(dataUrl(url));
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function loadSites() {
  const index = await getJson('sites/index.json');
  const out = [];
  for (const entry of index) {
    try {
      const site = await getJson(`sites/${entry.id}/site.json`);
      if (site.synthetic) continue; // not a real place: nothing to fetch for it
      const courses = await getJson(`sites/${entry.id}/courses/index.json`).catch(() => []);
      out.push({ id: entry.id, name: entry.name, site, courses: courses.flatMap((c) => [c.id, c.name]) });
    } catch (err) {
      console.warn(err);
    }
  }
  state.sites = out;
  const pick = $('site-pick');
  pick.replaceChildren(...out.map((s) => Object.assign(document.createElement('option'), { value: s.id, textContent: s.name })));
  for (const s of out) {
    drawSquare(existingSquare(s.site), '#8a8f98').bindTooltip(s.name).on('click', (e) => {
      if (state.mode === 'new' && !state.placingStart) return; // let clicks place a new square
      L.DomEvent.stopPropagation(e);
    }).addTo(existingLayer);
  }
}

const currentSite = () => state.sites.find((s) => s.id === $('site-pick').value);

// ---- Courses ----

function refreshCourses() {
  const day = Math.max(0, Math.min(5, Number($('day-count').value) || 0));
  const night = Math.max(0, Math.min(5, Number($('night-count').value) || 0));
  const site = state.mode === 'new'
    ? { id: $('site-id').value || 'my-site', name: $('site-name').value || 'My site', courses: [] }
    : currentSite() ?? { id: '', name: '', courses: [] };
  const rows = nextCourses(site.id, site.name, site.courses, { day, night });
  // Keep names and presets the user edited, row by row.
  // Keep each row's seed (and anything the user edited) as the list changes.
  state.courseRows = rows.map((r, i) => {
    const old = state.courseRows[i];
    const same = old && old.night === r.night;
    const seed = same ? old.seed : 1 + Math.floor(Math.random() * 999999);
    return same && old.edited ? { ...old, id: r.id } : { ...r, seed, preset: same ? old.preset : 'woods' };
  });
  const list = $('course-list');
  list.replaceChildren(...state.courseRows.map((c, i) => {
    const row = document.createElement('div');
    row.className = 'course';
    const name = Object.assign(document.createElement('input'), { type: 'text', value: c.name, maxLength: 60 });
    name.addEventListener('input', () => { c.name = name.value; c.edited = true; update(false); });
    const preset = document.createElement('select');
    for (const p of ['woods', 'open']) preset.append(Object.assign(document.createElement('option'), { value: p, textContent: p }));
    preset.value = c.preset;
    preset.addEventListener('change', () => { c.preset = preset.value; c.edited = true; update(false); });
    const tag = Object.assign(document.createElement('span'), { className: 'note', textContent: c.night ? 'night' : 'day' });
    row.append(name, preset, tag);
    row.dataset.index = String(i);
    return row;
  }));
}

// ---- Everything that follows from the form ----

function pageState() {
  const size = Number($('size').value);
  const sq = state.center ? siteSquare(state.center.lat, state.center.lon, size) : null;
  if (state.mode === 'new') {
    return {
      mode: 'new', landcover: $('landcover').checked, roads: $('roads').checked,
      site: {
        id: $('site-id').value.trim(), name: $('site-name').value.trim(), size, square: sq,
        lat: state.center?.lat, lon: state.center?.lon,
        start: state.start ? { ...state.start, name: $('start-name').value.trim() || 'Start' } : null,
        declination: $('declination').value.trim() === '' || /^auto$/i.test($('declination').value.trim()) ? '' : $('declination').value.trim(),
        existingIds: state.sites.map((s) => s.id).concat(['demo-synthetic']),
      },
      courses: state.courseRows,
    };
  }
  return { mode: 'update', landcover: $('landcover').checked, roads: $('roads').checked, site: { id: $('site-pick').value }, courses: state.courseRows };
}

let lastRequest = null;

function update(redrawCourses = true) {
  if (redrawCourses) refreshCourses();
  const ps = pageState();

  // Map: the new square, its centre and the start.
  squareLayer?.remove(); squareLayer = null;
  if (state.mode === 'new' && ps.site.square) {
    const sq = ps.site.square;
    squareLayer = drawSquare(sq, sq.problems.length ? '#ff5a4f' : '#ffd27a').addTo(map);
    if (!centerMarker) {
      centerMarker = L.marker([0, 0], { draggable: true, icon: dot('#ffd27a'), title: 'Drag to move the square' }).addTo(map);
      centerMarker.on('drag', (e) => { state.center = { lat: e.latlng.lat, lon: e.latlng.lng }; update(false); });
    }
    centerMarker.setLatLng([state.center.lat, state.center.lon]);
    const mgrs = `UTM zone ${sq.zone}${sq.north ? 'N' : 'S'}, NW corner E ${sq.eWest} N ${sq.nNorth}`;
    $('square-status').innerHTML = sq.problems.length
      ? `<span class="bad">${sq.problems.join(' ')}</span>`
      : `<span class="good">${(sq.size / 1000).toLocaleString()} km square.</span> <span class="note">${mgrs}</span>`;
  } else if (state.mode === 'new') {
    centerMarker?.remove(); centerMarker = null;
    $('square-status').textContent = 'No square yet.';
  }
  if (state.mode === 'new' && state.start) {
    if (!startMarker) {
      startMarker = L.marker([0, 0], { draggable: true, icon: dot('#d42a1f'), title: 'Course start: drag to move' }).addTo(map);
      startMarker.on('drag', (e) => { state.start = { lat: e.latlng.lat, lon: e.latlng.lng }; update(false); });
    }
    startMarker.setLatLng([state.start.lat, state.start.lon]);
  } else {
    startMarker?.remove(); startMarker = null;
  }

  // The request and what's wrong with it.
  const { request, errors } = makeRequest(ps);
  lastRequest = errors.length ? null : request;
  $('errors').replaceChildren(...errors.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  $('send').disabled = errors.length > 0;
  $('explore-now').disabled = state.mode !== 'new' || !state.center;
  $('json').textContent = JSON.stringify(request, null, 2);
  $('cli').textContent = cliCommands(request).join('\n\n');
}

function setMode(mode) {
  state.mode = mode;
  $('tab-new').setAttribute('aria-pressed', String(mode === 'new'));
  $('tab-update').setAttribute('aria-pressed', String(mode === 'update'));
  $('new-site').hidden = mode !== 'new';
  $('update-site').hidden = mode !== 'update';
  squareLayer?.remove(); centerMarker?.remove(); startMarker?.remove();
  squareLayer = centerMarker = startMarker = null;
  setPlacingStart(false);
  state.courseRows = [];
  if (mode === 'update') {
    $('day-count').value = 1; $('night-count').value = 0;
    showSite();
  } else {
    $('day-count').value = 2; $('night-count').value = 1;
    $('landcover').checked = $('roads').checked = true;
  }
  update();
}

// Update mode: show the chosen site and default the boxes to what it lacks.
function showSite() {
  const s = currentSite();
  if (!s) { $('site-status').textContent = 'No sites to update yet.'; return; }
  const sq = existingSquare(s.site);
  map.fitBounds(sq.corners.map((c) => [c.lat, c.lon]), { padding: [30, 30] });
  $('landcover').checked = !s.site.landcover;
  $('roads').checked = !s.site.features;
  const has = [s.site.landcover && 'tree cover', s.site.features && 'roads and trails'].filter(Boolean);
  $('site-status').innerHTML = `<span class="note">${s.courses.length} course${s.courses.length === 1 ? '' : 's'}${has.length ? `; has ${has.join(' and ')}` : ''}. Ticking something it has already rebuilds it from fresh data.</span>`;
}

// ---- Wiring ----

$('tab-new').addEventListener('click', () => setMode('new'));
$('tab-update').addEventListener('click', () => setMode('update'));
$('site-pick').addEventListener('change', () => { state.courseRows = []; showSite(); update(); });
$('place-start').addEventListener('click', () => setPlacingStart(!state.placingStart));
$('clear-start').addEventListener('click', () => { state.start = null; setPlacingStart(false); update(false); });
$('site-name').addEventListener('input', () => {
  if (!state.idEdited) $('site-id').value = slugify($('site-name').value);
  state.courseRows = [];
  update();
});
$('site-id').addEventListener('input', () => { state.idEdited = $('site-id').value !== ''; state.courseRows = []; update(); });
for (const id of ['size', 'declination', 'start-name', 'landcover', 'roads']) $(id).addEventListener('input', () => update(false));
for (const id of ['day-count', 'night-count']) $(id).addEventListener('input', () => update());
$('goto').addEventListener('change', () => {
  const m = $('goto').value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return;
  const [lat, lon] = [Number(m[1]), Number(m[2])];
  map.setView([lat, lon], 14);
  if (state.mode === 'new') { state.center = { lat, lon }; update(false); }
});
// Explore the square straight away: the app builds it in the browser (src/instant-site.js).
$('explore-now').addEventListener('click', () => {
  if (!state.center) return;
  const q = new URLSearchParams({ at: `${state.center.lat.toFixed(5)},${state.center.lon.toFixed(5)}`, size: $('size').value });
  const name = $('site-name').value.trim();
  if (name) q.set('name', name);
  location.href = `./?${q}`;
});

$('send').addEventListener('click', () => {
  if (lastRequest) window.open(issueUrl(lastRequest), '_blank', 'noopener');
});

// Recent builds: public issues titled "[build] ...", no token needed.
async function loadBuilds() {
  const list = $('builds');
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=30&sort=created`);
    if (!res.ok) throw new Error(String(res.status));
    const builds = (await res.json()).filter((i) => i.title.startsWith('[build]') && !i.pull_request).slice(0, 8);
    list.replaceChildren(...(builds.length ? builds.map((i) => {
      const li = document.createElement('li');
      const a = Object.assign(document.createElement('a'), { href: i.html_url, target: '_blank', rel: 'noopener', textContent: `#${i.number} ${i.title.replace(/^\[build\]\s*/, '')}` });
      const pill = Object.assign(document.createElement('span'), { className: `pill ${i.state}`, textContent: i.state === 'open' ? 'building or waiting to merge' : 'done' });
      li.append(a, pill);
      return li;
    }) : [Object.assign(document.createElement('li'), { textContent: 'None yet.' })]));
  } catch {
    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: "Couldn't reach GitHub to list builds." }));
  }
}

window.__builder = { state, map, update, setMode, get request() { return lastRequest; } };

loadSites().catch((err) => console.warn('Could not load sites', err)).finally(() => update());
loadBuilds();
