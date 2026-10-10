// Coordinate conventions (spec section 4). Pure functions, no Three.js.
//
// Scene origin is the NW corner of the playable area.
//   x = easting - e_west      (increases east)
//   z = n_north - northing    (increases south)
//   y = elevation - elev_ref
// Grid north is -Z. The scene is aligned to grid north.

const RAD = Math.PI / 180;

export function normalizeDeg(a) {
  const r = a % 360;
  // `+ 0` turns -0 into 0 so callers can compare with ===.
  return (r < 0 ? r + 360 : r) + 0;
}

// Grid azimuth (degrees, 0..360) of a horizontal scene direction.
export function gridAzimuth(dx, dz) {
  return normalizeDeg(Math.atan2(dx, -dz) / RAD);
}

// Unit horizontal scene direction for a grid azimuth.
export function directionFromAzimuth(azDeg) {
  const a = azDeg * RAD;
  return { dx: Math.sin(a), dz: -Math.cos(a) };
}

export function backAzimuth(az) {
  return normalizeDeg(az + 180);
}

// gm_angle_deg is positive when magnetic north is east of grid north.
export function gridToMagnetic(gridAz, gmAngleDeg) {
  return normalizeDeg(gridAz - gmAngleDeg);
}

export function magneticToGrid(magAz, gmAngleDeg) {
  return normalizeDeg(magAz + gmAngleDeg);
}

export const MILS_PER_CIRCLE = 6400;

export function degToMils(deg) {
  return (deg * MILS_PER_CIRCLE) / 360;
}

export function milsToDeg(mils) {
  return (mils * 360) / MILS_PER_CIRCLE;
}

export function sceneToUtm(site, x, z) {
  return { easting: site.e_west + x, northing: site.n_north - z };
}

export function utmToScene(site, easting, northing) {
  return { x: easting - site.e_west, z: site.n_north - northing };
}

function mod(a, n) {
  return ((a % n) + n) % n;
}

// Four easting digits and four northing digits (10 m precision), truncated.
export function gridDigits(site, x, z) {
  const { easting, northing } = sceneToUtm(site, x, z);
  // Round to the nearest micrometre first so 284000 + 9.99 doesn't drift across a line.
  const e = Math.floor(mod(Math.round(easting * 1e6) / 1e6, 100000) / 10);
  const n = Math.floor(mod(Math.round(northing * 1e6) / 1e6, 100000) / 10);
  return { e: String(e).padStart(4, '0'), n: String(n).padStart(4, '0') };
}

export function eightDigitGrid(site, x, z) {
  const { e, n } = gridDigits(site, x, z);
  return `${site.mgrs_gzd} ${site.mgrs_100km} ${e} ${n}`;
}

// Parse an 8-digit grid ("18S TJ 8542 0124", "8542 0124" or "85420124") that lies
// in this site's 100 km square. Returns the scene position of the SW corner of
// the 10 m square it names.
export function parseGrid(site, text) {
  const t = String(text).trim().toUpperCase().replace(/\s+/g, ' ');
  const m = t.match(/^(?:(\d{1,2}[C-HJ-NP-X])\s?([A-HJ-NP-Z]{2})\s?)?(\d{4})\s?(\d{4})$/);
  if (!m) throw new Error(`Not an 8-digit grid: "${text}"`);
  const [, gzd, sq, eStr, nStr] = m;
  if (gzd && gzd !== site.mgrs_gzd.toUpperCase()) {
    throw new Error(`Grid zone ${gzd} is not this site's (${site.mgrs_gzd})`);
  }
  if (sq && sq !== site.mgrs_100km.toUpperCase()) {
    throw new Error(`100 km square ${sq} is not this site's (${site.mgrs_100km})`);
  }
  // The site lies entirely inside one 100 km square, so its centre picks the base.
  const half = (site.size_m ?? 0) / 2;
  const eBase = Math.floor((site.e_west + half) / 100000) * 100000;
  const nBase = Math.floor((site.n_north - half) / 100000) * 100000;
  const easting = eBase + Number(eStr) * 10;
  const northing = nBase + Number(nStr) * 10;
  return utmToScene(site, easting, northing);
}

export function horizontalDistance(x1, z1, x2, z2) {
  return Math.hypot(x2 - x1, z2 - z1);
}
