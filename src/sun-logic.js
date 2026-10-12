// Where the sun is, and what the sky and light look like because of it. Pure
// functions, no Three.js, so they can be tested in Node.
//
// Solar position: the NOAA Solar Calculator's equations (after Meeus,
// "Astronomical Algorithms"), good to about a tenth of a degree, which is far
// better than anyone can see. https://gml.noaa.gov/grad/solcalc/calcdetails.html

const RAD = Math.PI / 180;

// Sun azimuth (degrees true, clockwise from north) and elevation (degrees above
// the horizon, refraction included) at `date` for a point at lat, lon (degrees).
export function solarPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525; // Julian centuries since J2000
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360; // mean longitude
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t); // mean anomaly
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t); // orbit eccentricity
  const c = Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) + Math.sin(3 * m * RAD) * 0.000289;
  const trueLong = l0 + c;
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD); // apparent longitude
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD); // corrected obliquity
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  // Equation of time, minutes.
  const eot = 4 / RAD * (y * Math.sin(2 * l0 * RAD) - 2 * e * Math.sin(m * RAD)
    + 4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD)
    - 0.5 * y * y * Math.sin(4 * l0 * RAD) - 1.25 * e * e * Math.sin(2 * m * RAD));
  const utcMin = (((date.getTime() / 60000) % 1440) + 1440) % 1440;
  const trueSolarMin = (((utcMin + eot + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarMin / 4 < 0 ? trueSolarMin / 4 + 180 : trueSolarMin / 4 - 180;
  const cosZen = Math.sin(lat * RAD) * Math.sin(decl * RAD) + Math.cos(lat * RAD) * Math.cos(decl * RAD) * Math.cos(hourAngle * RAD);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen))) / RAD;
  const elev = 90 - zen;
  const sinZen = Math.sin(zen * RAD);
  let az;
  if (sinZen < 1e-9) {
    az = lat > 0 ? 180 : 0;
  } else {
    const cosAz = (Math.sin(lat * RAD) * Math.cos(zen * RAD) - Math.sin(decl * RAD)) / (Math.cos(lat * RAD) * sinZen);
    const a = Math.acos(Math.min(1, Math.max(-1, cosAz))) / RAD;
    az = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }
  return { azimuth: az, elevation: elev + refraction(elev), declination: decl };
}

// Atmospheric refraction near the horizon, degrees (NOAA's approximation).
function refraction(elev) {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let r;
  if (elev > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575) r = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else r = -20.772 / te;
  return r / 3600;
}

// Sunrise and sunset for the local day containing `date` (offsetMin: the site's
// UTC offset in minutes). Returns Dates, or null for polar day/night. The sun's
// top edge on the horizon, refraction included: elevation -0.833 before refraction,
// which solarPosition reports as about -0.3.
export function sunTimes(date, lat, lon, offsetMin) {
  const dayStart = localMidnight(date, offsetMin);
  const elevAt = (min) => solarPosition(new Date(dayStart + min * 60000), lat, lon).elevation;
  const HORIZON = -0.3;
  const cross = (a, b) => {
    for (let k = 0; k < 30; k++) {
      const m = (a + b) / 2;
      if ((elevAt(a) - HORIZON) * (elevAt(m) - HORIZON) <= 0) b = m; else a = m;
    }
    return new Date(dayStart + ((a + b) / 2) * 60000);
  };
  let rise = null, set = null;
  for (let min = 0; min < 1440; min += 10) {
    const a = elevAt(min) - HORIZON, b = elevAt(min + 10) - HORIZON;
    if (a < 0 && b >= 0 && !rise) rise = cross(min, min + 10);
    if (a >= 0 && b < 0) set = cross(min, min + 10);
  }
  return { rise, set };
}

// UTC milliseconds of local midnight (offsetMin from UTC) for the day containing date.
export function localMidnight(date, offsetMin) {
  const local = date.getTime() + offsetMin * 60000;
  return local - (((local % 86400000) + 86400000) % 86400000) - offsetMin * 60000;
}

// "Now", or a chosen local clock time on today's (or a given) date, as a Date.
// minutes: minutes after local midnight, or < 0 for the real time.
// ymd: 'YYYY-MM-DD' to put the clock on another day (weather replay), else today.
export function worldTime(nowMs, minutes, offsetMin, ymd = '') {
  if (minutes < 0 && !ymd) return new Date(nowMs);
  let midnight;
  if (ymd) {
    const [y, mo, d] = ymd.split('-').map(Number);
    midnight = Date.UTC(y, mo - 1, d) - offsetMin * 60000;
  } else {
    midnight = localMidnight(new Date(nowMs), offsetMin);
  }
  // A replayed day with no clock time chosen follows the real time of day.
  const m = minutes >= 0 ? minutes : (nowMs - localMidnight(new Date(nowMs), offsetMin)) / 60000;
  return new Date(midnight + m * 60000);
}

// The site's UTC offset before anything better (a weather service) tells us: one
// hour per 15 degrees, plus US daylight saving time. Good for the lower 48 apart
// from the odd zone boundary and Arizona.
export function guessUtcOffsetMin(lon, date) {
  const std = Math.round(lon / 15) * 60;
  return std + (usDst(date) ? 60 : 0);
}

// US daylight saving: 2 a.m. on the second Sunday of March to 2 a.m. on the first
// Sunday of November (local; close enough at the day level).
export function usDst(date) {
  const y = date.getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return Date.UTC(y, month, 1 + ((7 - first) % 7) + (n - 1) * 7, 7);
  };
  const t = date.getTime();
  return t >= nthSunday(2, 2) && t < nthSunday(10, 1);
}

// Local clock time as "HH:MM".
export function clockText(date, offsetMin) {
  const m = Math.floor((((date.getTime() / 60000 + offsetMin) % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ---- Sky and light from the sun's elevation ----

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Key frames by sun elevation (degrees). Colours are linear RGB, 0..1, which is
// what the renderer works in. Night matches night.js; full day matches sky.js.
const hex = (h) => {
  const s = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return [s((h >> 16) & 255), s((h >> 8) & 255), s(h & 255)];
};
const SKY_KEYS = [
  // elev, top, horizon, ground
  [-18, hex(0x03050a), hex(0x0a0e16), hex(0x040505)],
  [-10, hex(0x070b18), hex(0x1a1c2c), hex(0x080909)],
  [-4, hex(0x1d2a4c), hex(0x5a5068), hex(0x2a2a2c)],
  [0, hex(0x3a5a8c), hex(0xc89a84), hex(0x5a5a56)],
  [6, hex(0x5684bd), hex(0xd8c6b2), hex(0x828a80)],
  [20, hex(0x6f9fd4), hex(0xc4d6e4), hex(0x9aa49a)],
];
// The sun's own colour, warmer as it nears the horizon.
const SUN_KEYS = [
  [-1, hex(0xff6a2a)],
  [3, hex(0xff9450)],
  [10, hex(0xffcf98)],
  [25, hex(0xfff1dc)],
];

function interpKeys(keys, elev, slot) {
  if (elev <= keys[0][0]) return keys[0][slot].slice();
  for (let i = 1; i < keys.length; i++) {
    if (elev <= keys[i][0]) {
      const t = smoothstep(keys[i - 1][0], keys[i][0], elev);
      return keys[i][slot].map((v, k) => lerp(keys[i - 1][slot][k], v, t));
    }
  }
  return keys[keys.length - 1][slot].slice();
}

// Everything the scene needs to light itself for a sun elevation.
//   sky: { top, horizon, ground }  linear RGB arrays
//   sunColor, sunIntensity          the directional light
//   hemiIntensity                   sky fill light
//   stars                           0..1, how bright the stars are
//   dark                            true once it's too dark to read a map (night rules)
export function skyState(elev) {
  return {
    sky: { top: interpKeys(SKY_KEYS, elev, 1), horizon: interpKeys(SKY_KEYS, elev, 2), ground: interpKeys(SKY_KEYS, elev, 3) },
    sunColor: interpKeys(SUN_KEYS, elev, 1),
    sunIntensity: 2.2 * smoothstep(-1.5, 14, elev),
    hemiIntensity: lerp(0.05, 0.95, smoothstep(-12, 12, elev)),
    stars: 1 - smoothstep(-12, -4, elev),
    dark: elev < DARK_BELOW_DEG,
  };
}

// Civil twilight ends at -6 degrees; by about -5 you need a light to read a map.
export const DARK_BELOW_DEG = -5;

// Local sidereal time, degrees: which way the stars face (Meeus 12.4).
export function siderealDeg(date, lon) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545;
  return ((280.46061837 + 360.98564736629 * d + lon) % 360 + 360) % 360;
}

// A scene direction (x east, y up, z south, scene aligned to grid north) for a
// true azimuth and elevation, degrees. convergenceDeg: grid north's angle east of
// true north (site.json convergence_deg), so grid azimuth = true - convergence.
export function sceneDirection(azTrueDeg, elevDeg, convergenceDeg = 0) {
  const a = (azTrueDeg - convergenceDeg) * RAD, e = elevDeg * RAD;
  return { x: Math.sin(a) * Math.cos(e), y: Math.sin(e), z: -Math.cos(a) * Math.cos(e) };
}
