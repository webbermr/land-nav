// Moving between squares: which square lies next to this one, where you arrive
// in it, and the saved places list. Pure functions (storage is passed in), no
// Three.js.
import { fromUtm, toUtm } from './utm.js';

const zoneOf = (site) => site.epsg % 100;
const northOf = (site) => Math.floor(site.epsg / 100) === 326;

// Latitude and longitude of a scene point on a site.
export function sceneToLatLon(site, x, z) {
  return fromUtm(site.e_west + x, site.n_north - z, zoneOf(site), northOf(site));
}

// Scene point on a site for a latitude and longitude (in the site's own UTM zone,
// even across a zone line).
export function latLonToScene(site, lat, lon) {
  const u = toUtm(lat, lon, zoneOf(site));
  return { x: u.e - site.e_west, z: site.n_north - u.n };
}

// Which neighbouring square a scene point falls in: (i, j) steps east and south,
// both 0 when inside.
export function squareStep(site, x, z) {
  const s = site.size_m;
  return { i: Math.floor(x / s), j: Math.floor(z / s) };
}

// The centre (lat, lon) of the square i steps east and j steps south.
export function neighbourCentre(site, i, j) {
  const s = site.size_m;
  return fromUtm(site.e_west + s / 2 + i * s, site.n_north - s / 2 - j * s, zoneOf(site), northOf(site));
}

// Which edge, if any, you're within `margin` metres of, as the step to the
// square beyond it (diagonal near a corner).
export function edgeStep(size, x, z, margin) {
  const i = x < margin ? -1 : x > size - margin ? 1 : 0;
  const j = z < margin ? -1 : z > size - margin ? 1 : 0;
  return { i, j };
}

// Is a move (dx, dz) pushing out through the edge you're at?
export function pushingOut(size, x, z, dx, dz, at = 0.5) {
  return (x <= at && dx < 0) || (x >= size - at && dx > 0) || (z <= at && dz < 0) || (z >= size - at && dz > 0);
}

// Where a point on the old site lands on the new one, kept a little inside.
export function arrivalOn(oldSite, x, z, newSite, inset = 2) {
  const ll = sceneToLatLon(oldSite, x, z);
  const p = latLonToScene(newSite, ll.lat, ll.lon);
  const s = newSite.size_m;
  return { x: Math.min(s - inset, Math.max(inset, p.x)), z: Math.min(s - inset, Math.max(inset, p.z)), lat: ll.lat, lon: ll.lon };
}

// ---- Saved places ----
//
// A place: { name, saved (ms), site: { id } for a site that ships with the app, or
// { lat, lon, size } for a square built in the browser, view: { lat, lon, yaw, alt? } }.
// Recent squares built in the browser are kept too, marked recent: true.

const KEY = 'landnav.places.v1';
const MAX_SAVED = 30, MAX_RECENT = 8;

export function loadPlaces(storage) {
  try {
    const v = JSON.parse(storage?.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((p) => p && typeof p.name === 'string' && p.site) : [];
  } catch {
    return [];
  }
}

export function savePlaces(storage, places) {
  try { storage?.setItem(KEY, JSON.stringify(places)); return true; } catch { return false; }
}

// Saved places first (newest first), then recent squares.
export function sortPlaces(places) {
  const saved = places.filter((p) => !p.recent).sort((a, b) => b.saved - a.saved);
  const recent = places.filter((p) => p.recent).sort((a, b) => b.saved - a.saved);
  return [...saved, ...recent];
}

export function addPlace(places, place, now = Date.now()) {
  const out = [...places, { ...place, saved: now }];
  const saved = out.filter((p) => !p.recent);
  if (saved.length > MAX_SAVED) out.splice(out.indexOf(saved.sort((a, b) => a.saved - b.saved)[0]), 1);
  return out;
}

// Remember a square built in the browser (once; the newest visit moves it up).
export function touchRecent(places, { name, lat, lon, size }, now = Date.now()) {
  const same = (p) => p.recent && p.site.lat === lat && p.site.lon === lon && p.site.size === size;
  const out = places.filter((p) => !same(p));
  out.push({ name, recent: true, saved: now, site: { lat, lon, size }, view: null });
  const recent = out.filter((p) => p.recent).sort((a, b) => b.saved - a.saved);
  for (const old of recent.slice(MAX_RECENT)) out.splice(out.indexOf(old), 1);
  return out;
}

export function removePlace(places, place) {
  return places.filter((p) => p !== place);
}

// A short name for a spot: the site and the compass point you face.
export function spotName(siteName, count, facing) {
  return `${siteName.replace(/\s*\(built here\)$/, '')}, spot ${count}${facing ? `, facing ${facing}` : ''}`;
}
