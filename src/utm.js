// WGS84 latitude/longitude <-> UTM, standard 6-degree zones. Pure functions.
// Krüger series to third order in n (accurate to well under a millimetre inside
// a zone), as in the USGS and NGA references. Used by the site builder page to
// draw the exact square tools/make_site.py will build.

const A_AXIS = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const E0 = 500000;
const N = F / (2 - F);
const A = (A_AXIS / (1 + N)) * (1 + (N * N) / 4 + N ** 4 / 64);
const ALPHA = [N / 2 - (2 / 3) * N ** 2 + (5 / 16) * N ** 3, (13 / 48) * N ** 2 - (3 / 5) * N ** 3, (61 / 240) * N ** 3];
const BETA = [N / 2 - (2 / 3) * N ** 2 + (37 / 96) * N ** 3, (1 / 48) * N ** 2 + (1 / 15) * N ** 3, (17 / 480) * N ** 3];
const DELTA = [2 * N - (2 / 3) * N ** 2 - 2 * N ** 3, (7 / 3) * N ** 2 - (8 / 5) * N ** 3, (56 / 15) * N ** 3];
const RAD = Math.PI / 180;

export function utmZone(lon) {
  return Math.floor((lon + 180) / 6) + 1;
}

const centralMeridian = (zone) => (zone - 1) * 6 - 180 + 3;

// { e, n, zone, north } for a lat/lon, in the given zone (default: its own).
export function toUtm(lat, lon, zone = utmZone(lon)) {
  const phi = lat * RAD;
  const lam = (lon - centralMeridian(zone)) * RAD;
  const c = (2 * Math.sqrt(N)) / (1 + N);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - c * Math.atanh(c * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam));
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let e = eta, n = xi;
  for (let j = 1; j <= 3; j++) {
    e += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    n += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  const north = lat >= 0;
  return { e: E0 + K0 * A * e, n: (north ? 0 : 10000000) + K0 * A * n, zone, north };
}

// { lat, lon } for a UTM coordinate.
export function fromUtm(e, n, zone, north = true) {
  const xi = (n - (north ? 0 : 10000000)) / (K0 * A);
  const eta = (e - E0) / (K0 * A);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 3; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi;
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  const lam = Math.atan2(Math.sinh(eta1), Math.cos(xi1));
  return { lat: phi / RAD, lon: centralMeridian(zone) + lam / RAD };
}
