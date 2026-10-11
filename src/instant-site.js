// Build a site in the browser, anywhere in the lower 48 (and wherever else USGS
// 3DEP covers): elevation from the 3DEP image service, land cover and tree canopy
// from the NLCD (MRLC), roads and trails from OpenStreetMap, declination from the
// World Magnetic Model, and the topo map drawn on a canvas. No GitHub build, no
// server of our own. The result is kept in the browser (IndexedDB), so going back
// is quick.
//
// It makes the same site the Python tools do (tools/make_site.py, make_landcover.py,
// make_features.py), from the same services, so a site built here and one built
// there should match.
import { Heightfield } from './heightfield.js';
import { readGeoTiff, sampleRaster } from './geo/tiff.js';
import { declination, toAlbers5070, mgrsSquare, gridConvergence } from './geo/geodesy.js';
import { fetchOsm, osmToFeatures } from './geo/osm.js';
import { toUtm, fromUtm } from './utm.js';
import { utmSquare } from './builder/request.js';
import { LandCover } from './landcover.js';
import { drawTopoMap, mapLayout } from './topo-map.js';

const TDEP = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
const MRLC = 'https://www.mrlc.gov/geoserver/ows';
const NLCD_LC = 'mrlc_download__NLCD_2021_Land_Cover_L48';
const NLCD_TCC = 'mrlc_download__nlcd_tcc_conus_2021_v2021-4';
const CACHE_VERSION = 1;

async function fetchBuffer(url, { signal, timeout = 90000, what = 'data' } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const abort = () => ctl.abort();
  signal?.addEventListener('abort', abort);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${what}: ${res.status} from ${new URL(url).host}`);
    const type = res.headers.get('content-type') || '';
    if (/json|xml|html/.test(type)) throw new Error(`${what}: the service sent ${type} instead of an image`);
    return await res.arrayBuffer();
  } catch (err) {
    if (err.name === 'AbortError' && !signal?.aborted) throw new Error(`${what}: no answer from ${new URL(url).host}`);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

// Elevation on a grid whose sample (row, col) sits at (eWest + col*spacing,
// nNorth - row*spacing): one pixel per sample, centred on it.
export async function fetchElevation(epsg, eWest, nNorth, spacing, grid, opts = {}) {
  const half = spacing / 2, ext = grid * spacing;
  const q = new URLSearchParams({
    bbox: `${eWest - half},${nNorth - ext + half},${eWest - half + ext},${nNorth + half}`,
    bboxSR: epsg, imageSR: epsg, size: `${grid},${grid}`, format: 'tiff', pixelType: 'F32', compression: 'None',
    noDataInterpretation: 'esriNoDataMatchAny', interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  const r = await readGeoTiff(await fetchBuffer(`${TDEP}?${q}`, { ...opts, what: 'Elevation' }));
  if (r.width !== grid || r.height !== grid) throw new Error(`Elevation came back ${r.width} x ${r.height}, not ${grid} x ${grid}`);
  const out = new Float32Array(grid * grid);
  let missing = 0;
  for (let i = 0; i < out.length; i++) {
    const v = r.data[i];
    const bad = !Number.isFinite(v) || v === r.nodata || v < -1000 || v > 9000;
    out[i] = bad ? NaN : v;
    if (bad) missing++;
  }
  return { heights: out, missing: missing / out.length };
}

// Fill NaN holes by repeatedly averaging valid neighbours (as make_site.py does for the skirt).
export function fillHoles(a, grid) {
  for (let iter = 0; iter < 500; iter++) {
    const holes = [];
    for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) holes.push(i);
    if (!holes.length) return a;
    const fills = [];
    for (const i of holes) {
      const r = Math.floor(i / grid), c = i % grid;
      let sum = 0, n = 0;
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= grid || cc >= grid) continue;
        const v = a[rr * grid + cc];
        if (!Number.isNaN(v)) { sum += v; n++; }
      }
      if (n) fills.push([i, sum / n]);
    }
    if (!fills.length) break;
    for (const [i, v] of fills) a[i] = v;
  }
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = 0;
  return a;
}

// NLCD land cover classes and tree canopy on a 10 m grid over the square.
async function fetchLandCover(site, opts) {
  const zone = site.epsg % 100;
  const spacing = 10, grid = Math.round(site.size_m / spacing) + 1;
  const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([fx, fz]) => {
    const ll = fromUtm(site.e_west + fx * site.size_m, site.n_north - fz * site.size_m, zone, true);
    return toAlbers5070(ll.lat, ll.lon);
  });
  const pad = 120;
  const x0 = Math.min(...corners.map((c) => c.x)) - pad, x1 = Math.max(...corners.map((c) => c.x)) + pad;
  const y0 = Math.min(...corners.map((c) => c.y)) - pad, y1 = Math.max(...corners.map((c) => c.y)) + pad;
  const wcs = (id) => `${MRLC}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${id}`
    + `&subset=X(${x0.toFixed(0)},${x1.toFixed(0)})&subset=Y(${y0.toFixed(0)},${y1.toFixed(0)})&format=image/geotiff`;
  const [lcBuf, tccBuf] = await Promise.all([
    fetchBuffer(wcs(NLCD_LC), { ...opts, what: 'Land cover' }),
    fetchBuffer(wcs(NLCD_TCC), { ...opts, what: 'Tree canopy' }),
  ]);
  const [lc, tcc] = await Promise.all([readGeoTiff(lcBuf), readGeoTiff(tccBuf)]);
  tcc.nodata = 255;
  const bytes = new Uint8Array(2 * grid * grid);
  let any = 0;
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const ll = fromUtm(site.e_west + c * spacing, site.n_north - r * spacing, zone, true);
      const p = toAlbers5070(ll.lat, ll.lon);
      const cls = sampleRaster(lc, p.x, p.y, 'nearest');
      let can = sampleRaster(tcc, p.x, p.y, 'bilinear');
      if (!(can >= 0 && can <= 100)) can = 0;
      const k = r * grid + c;
      bytes[k] = Number.isFinite(cls) ? cls : 0;
      bytes[grid * grid + k] = Math.round(can);
      if (bytes[k]) any++;
    }
  }
  if (!any) throw new Error('No NLCD land cover here (it covers the lower 48 states)');
  return { bytes, info: { grid, spacing_m: spacing, year: 2021, source: 'NLCD 2021 Land Cover and Tree Canopy Cover (USGS, MRLC, USDA Forest Service)' } };
}

// Where a course should start by default: the parking lot nearest the middle, or
// the nearest point on a road or track, or the middle.
function pickStart(site, features) {
  const mid = site.size_m / 2;
  const inside = (x, z) => x > 50 && z > 50 && x < site.size_m - 50 && z < site.size_m - 50;
  let best = null;
  for (const a of features?.areas || []) {
    if (a.kind !== 'parking') continue;
    const x = a.pts.reduce((s, p) => s + p[0], 0) / a.pts.length, z = a.pts.reduce((s, p) => s + p[1], 0) / a.pts.length;
    const d = Math.hypot(x - mid, z - mid);
    if (inside(x, z) && (!best || d < best.d)) best = { x, z, d, name: a.name || 'Parking' };
  }
  if (!best) {
    for (const l of features?.lines || []) {
      if (l.kind !== 'road' && l.kind !== 'track') continue;
      for (const [x, z] of l.pts) {
        const d = Math.hypot(x - mid, z - mid);
        if (inside(x, z) && (!best || d < best.d)) best = { x, z, d, name: l.name || (l.kind === 'road' ? 'Road' : 'Track') };
      }
    }
  }
  if (!best || best.d > 700) return null;
  return { name: best.name, x: Math.floor(best.x / 10) * 10 + 5, z: Math.floor(best.z / 10) * 10 + 5 };
}

// The square for a centre point: like make_site.py, but nudged to sit inside one
// 100 km MGRS square instead of refusing.
export function instantSquare(lat, lon, size = 2000) {
  const c = toUtm(lat, lon);
  const snap = (v) => Math.floor(v / 10 + 0.5) * 10;
  let eWest = snap(c.e - size / 2), nNorth = snap(c.n + size / 2);
  const e100 = Math.floor(c.e / 1e5) * 1e5, n100 = Math.floor(c.n / 1e5) * 1e5;
  eWest = Math.min(Math.max(eWest, e100), e100 + 1e5 - size);
  nNorth = Math.min(Math.max(nNorth, n100 + size), n100 + 1e5);
  return utmSquare(c.zone, c.north, eWest, nNorth, size);
}

// Build the site. onProgress(text) reports each step. Returns
// { site, heights (absolute, Float32Array), skirt, far, features, landcoverBytes, mapCanvas }.
export async function buildInstantSite({ lat, lon, name, size = 2000, date = new Date(), onProgress = () => {}, signal } = {}) {
  const sq = instantSquare(lat, lon, size);
  if (sq.problems.length) throw new Error(sq.problems.join(' '));
  if (!sq.north) throw new Error('Only the northern hemisphere (USGS 3DEP covers the US).');
  const epsg = 32600 + sq.zone;
  const spacing = 4, grid = Math.round(size / spacing) + 1;
  const sk = { size_m: 6000, spacing_m: 30 };
  sk.grid = Math.round(sk.size_m / sk.spacing_m) + 1;
  sk.e_west = Math.floor((sq.eWest + size / 2 - sk.size_m / 2) / sk.spacing_m + 0.5) * sk.spacing_m;
  sk.n_north = Math.floor((sq.nNorth - size / 2 + sk.size_m / 2) / sk.spacing_m + 0.5) * sk.spacing_m;
  const far = { size_m: 40000, spacing_m: 200 };
  far.grid = Math.round(far.size_m / far.spacing_m) + 1;
  far.e_west = Math.floor((sq.eWest + size / 2 - far.size_m / 2) / far.spacing_m) * far.spacing_m;
  far.n_north = Math.floor((sq.nNorth - size / 2 + far.size_m / 2) / far.spacing_m) * far.spacing_m;

  onProgress('Elevation (USGS 3DEP) ...');
  const opts = { signal };
  const [play, skirt, farEl] = await Promise.all([
    fetchElevation(epsg, sq.eWest, sq.nNorth, spacing, grid, opts),
    fetchElevation(epsg, sk.e_west, sk.n_north, sk.spacing_m, sk.grid, opts),
    fetchElevation(epsg, far.e_west, far.n_north, far.spacing_m, far.grid, opts).catch(() => null),
  ]);
  if (play.missing > 0.02) throw new Error(`${Math.round(play.missing * 100)}% of this square has no USGS elevation data. Try somewhere in the US.`);
  fillHoles(play.heights, grid);
  fillHoles(skirt.heights, sk.grid);
  if (farEl) fillHoles(farEl.heights, far.grid);

  let lo = Infinity, hi = -Infinity;
  for (const v of play.heights) { if (v < lo) lo = v; if (v > hi) hi = v; }
  let slo = Infinity, shi = -Infinity;
  for (const v of skirt.heights) { if (v < slo) slo = v; if (v > shi) shi = v; }

  const centre = fromUtm(sq.eWest + size / 2, sq.nNorth - size / 2, sq.zone, true);
  const { gzd, sq: sq100 } = mgrsSquare(centre.lat, centre.lon);
  const decl = Math.round(declination(centre.lat, centre.lon, date) * 100) / 100;
  const conv = gridConvergence(sq.zone, true, sq.eWest + size / 2, sq.nNorth - size / 2);
  const today = date.toISOString().slice(0, 10);
  const id = `at-${centre.lat.toFixed(4)}-${centre.lon.toFixed(4)}`.replace(/\./g, '_');
  const site = {
    id, name: name || `${Math.abs(centre.lat).toFixed(4)}° N, ${Math.abs(centre.lon).toFixed(4)}° W`,
    utm_zone: `${sq.zone}N`, epsg, mgrs_gzd: gzd, mgrs_100km: sq100,
    center_lat: centre.lat, center_lon: centre.lon, e_west: sq.eWest, n_north: sq.nNorth,
    size_m: size, spacing_m: spacing, grid, elev_min: lo, elev_max: hi, elev_ref: lo,
    skirt: { ...sk, elev_min: slo, elev_max: shi },
    declination_deg: decl, convergence_deg: Math.round(conv * 1e4) / 1e4, gm_angle_deg: Math.round((decl - conv) * 1e4) / 1e4,
    declination_date: today, contour_interval_m: hi - lo > 700 ? 20 : 10, index_contour_interval_m: hi - lo > 700 ? 100 : 50,
    map: mapLayout(4096),
    sources: ['USGS 3DEP elevation service (built in the browser)'],
    instant: true,
  };
  if (farEl) site.far = far;

  onProgress('Roads and trails (OpenStreetMap) ...');
  let features = null;
  try {
    features = osmToFeatures(await fetchOsm(site, opts), site);
    site.features = true;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('No OpenStreetMap features:', err);
    onProgress(`Roads and trails skipped (${err.message}).`);
  }
  onProgress('Land cover (NLCD) ...');
  let landcoverBytes = null;
  try {
    const lc = await fetchLandCover(site, opts);
    landcoverBytes = lc.bytes;
    site.landcover = lc.info;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('No land cover:', err);
    onProgress(`Land cover skipped (${err.message}).`);
  }
  const start = pickStart(site, features);
  if (start) site.default_start = start;

  onProgress('Drawing the map ...');
  const mapCanvas = drawTopoMap(document.createElement('canvas'), {
    site, heights: play.heights, features, contourInterval: site.contour_interval_m, indexInterval: site.index_contour_interval_m,
  });
  return { site, heights: play.heights, skirt: skirt.heights, far: farEl?.heights ?? null, features, landcoverBytes, mapCanvas };
}

// The parts the app needs, from what buildInstantSite returns (or the cache holds).
export function instantSiteData(built) {
  const { site } = built;
  const rel = (h) => { const out = new Float32Array(h.length); for (let i = 0; i < h.length; i++) out[i] = h[i] - site.elev_ref; return out; };
  const field = new Heightfield(rel(built.heights), site.grid, site.spacing_m);
  const skirtField = new Heightfield(rel(built.skirt), site.skirt.grid, site.skirt.spacing_m);
  const farField = built.far && site.far ? new Heightfield(rel(built.far), site.far.grid, site.far.spacing_m) : null;
  const landcover = built.landcoverBytes && site.landcover ? new LandCover(built.landcoverBytes.buffer.slice(0), site.landcover) : null;
  return { site, field, skirtField, farField, features: built.features, landcover, baseUrl: null };
}

// ---- The browser's copy (IndexedDB) ----

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('land-nav-sites', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('sites');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function cacheKey(lat, lon, size) {
  return `v${CACHE_VERSION}:${lat.toFixed(4)},${lon.toFixed(4)},${size}`;
}

export async function loadCachedSite(key) {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const r = db.transaction('sites').objectStore('sites').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    if (!rec) return null;
    // The map was kept as a PNG; draw it back onto a canvas.
    const img = await createImageBitmap(rec.mapPng);
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return { ...rec, mapCanvas: canvas };
  } catch (err) {
    console.warn('Site cache unreadable:', err);
    return null;
  }
}

export async function saveCachedSite(key, built) {
  try {
    const mapPng = await new Promise((resolve) => built.mapCanvas.toBlob(resolve, 'image/png'));
    const { mapCanvas, ...rest } = built;
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sites', 'readwrite');
      tx.objectStore('sites').put({ ...rest, mapPng, saved: Date.now() }, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch (err) {
    console.warn('Could not keep the site in this browser:', err);
    return false;
  }
}
