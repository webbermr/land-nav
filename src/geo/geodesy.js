// Geodesy for building a site in the browser: magnetic declination from the World
// Magnetic Model, the NLCD's Albers projection, MGRS grid letters, and grid
// convergence. Pure functions.
import { WMM2025 } from './wmm-2025.js';
import { toUtm, fromUtm } from '../utm.js';

const RAD = Math.PI / 180;

// ---- World Magnetic Model ----

// Decimal year for a Date (2026.78 for 11 October 2026).
export function decimalYear(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1), end = Date.UTC(y + 1, 0, 1);
  return y + (date.getTime() - start) / (end - start);
}

// Magnetic declination (degrees, east positive) at a geodetic lat, lon (degrees),
// height (km above the WGS84 ellipsoid) and date. Spherical harmonic synthesis to
// degree 12, as in the WMM technical report (NOAA/NCEI, 2025).
export function declination(lat, lon, date, heightKm = 0, model = WMM2025) {
  const N = 12;
  const t = decimalYear(date) - model.epoch;
  const g = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  const h = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  for (const [n, m, gnm, hnm, gd, hd] of model.coef) {
    g[n][m] = gnm + t * gd;
    h[n][m] = hnm + t * hd;
  }
  // Geodetic to geocentric spherical.
  const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F), RE = 6371.2;
  const sp = Math.sin(lat * RAD), cp = Math.cos(lat * RAD);
  const rc = A / Math.sqrt(1 - E2 * sp * sp);
  const px = (rc + heightKm) * cp, pz = (rc * (1 - E2) + heightKm) * sp;
  const r = Math.hypot(px, pz);
  const latc = Math.asin(pz / r);
  const theta = Math.PI / 2 - latc; // colatitude
  const ct = Math.cos(theta), st = Math.sin(theta);
  // Schmidt semi-normalised associated Legendre functions and their theta derivatives.
  const P = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  const dP = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  P[0][0] = 1;
  for (let n = 1; n <= N; n++) {
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        const k = n === 1 ? 1 : Math.sqrt((2 * n - 1) / (2 * n));
        P[n][n] = k * st * P[n - 1][n - 1];
        dP[n][n] = k * (st * dP[n - 1][n - 1] + ct * P[n - 1][n - 1]);
      } else {
        const a = (2 * n - 1) / Math.sqrt(n * n - m * m);
        const b = n - 2 >= m ? Math.sqrt(((n - 1) ** 2 - m * m) / (n * n - m * m)) : 0;
        const p2 = n - 2 >= m ? P[n - 2][m] : 0, d2 = n - 2 >= m ? dP[n - 2][m] : 0;
        P[n][m] = a * ct * P[n - 1][m] - b * p2;
        dP[n][m] = a * (ct * dP[n - 1][m] - st * P[n - 1][m]) - b * d2;
      }
    }
  }
  let X = 0, Y = 0, Z = 0;
  const lam = lon * RAD;
  for (let n = 1; n <= N; n++) {
    const ar = (RE / r) ** (n + 2);
    for (let m = 0; m <= n; m++) {
      const cm = Math.cos(m * lam), sm = Math.sin(m * lam);
      const gh = g[n][m] * cm + h[n][m] * sm;
      X += ar * gh * dP[n][m];
      Y += ar * m * (g[n][m] * sm - h[n][m] * cm) * P[n][m];
      Z -= ar * (n + 1) * gh * P[n][m];
    }
  }
  // dP is d/dtheta; north is -theta, so X = -(-...) is as above. Y needs 1/sin(theta).
  Y /= st;
  // Back to geodetic axes.
  const psi = latc - lat * RAD;
  const Xg = X * Math.cos(psi) - Z * Math.sin(psi);
  return Math.atan2(Y, Xg) / RAD;
}

// ---- NLCD's CONUS Albers Equal Area (EPSG:5070, NAD83 / GRS80) ----

export function toAlbers5070(lat, lon) {
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), e = Math.sqrt(e2);
  const q = (phi) => {
    const s = Math.sin(phi);
    return (1 - e2) * (s / (1 - e2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  };
  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const p0 = 23 * RAD, p1 = 29.5 * RAD, p2 = 45.5 * RAD, l0 = -96 * RAD;
  const m1 = m(p1), m2 = m(p2), q0 = q(p0), q1 = q(p1), q2 = q(p2);
  const n = (m1 * m1 - m2 * m2) / (q2 - q1);
  const C = m1 * m1 + n * q1;
  const rho0 = (a * Math.sqrt(C - n * q0)) / n;
  const rho = (a * Math.sqrt(C - n * q(lat * RAD))) / n;
  const th = n * (lon * RAD - l0);
  return { x: rho * Math.sin(th), y: rho0 - rho * Math.cos(th) };
}

// ---- MGRS ----

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const COLS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';

// Grid zone designation ("17S") and 100 km square letters ("QC") for a point.
export function mgrsSquare(lat, lon) {
  const u = toUtm(lat, lon);
  const band = BANDS[Math.min(19, Math.max(0, Math.floor((lat + 80) / 8)))];
  const col = COLS[(u.zone - 1) % 3][Math.floor(u.e / 1e5) - 1];
  let row = Math.floor(u.n / 1e5) % 20;
  if (u.zone % 2 === 0) row = (row + 5) % 20;
  return { gzd: `${String(u.zone).padStart(2, '0')}${band}`, sq: `${col}${ROWS[row]}` };
}

// ---- Grid convergence ----

// Angle of grid north from true north at a UTM point, degrees, positive when grid
// north is east of true north (as tools/make_site.py measures it: step due north
// and see which way the grid says that is).
export function gridConvergence(zone, north, e, n) {
  const ll = fromUtm(e, n, zone, north);
  const p = toUtm(ll.lat + 0.01, ll.lon, zone);
  return -Math.atan2(p.e - e, p.n - n) / RAD;
}
