import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUtm, fromUtm, utmZone } from '../src/utm.js';

// Reference values from pyproj (PROJ), EPSG:326xx / 327xx.
const CASES = [
  [38.7641367, -78.2957968, 17, 734956.159, 4294076.138],
  [38.5512, -78.3155, 17, 733936.19, 4270391.513],
  [-33.86, 151.21, 56, 334416.394, 6251925.36],
  [64.1, -21.9, 27, 456137.554, 7108467.417],
  [0.5, 3.2, 31, 522254.196, 55265.376],
];

test('toUtm matches PROJ to the millimetre', () => {
  for (const [lat, lon, zone, e, n] of CASES) {
    const u = toUtm(lat, lon);
    assert.equal(u.zone, zone);
    assert.ok(Math.abs(u.e - e) < 0.002 && Math.abs(u.n - n) < 0.002, `${lat},${lon}: ${u.e},${u.n} vs ${e},${n}`);
  }
});

test('fromUtm inverts toUtm', () => {
  for (const [lat, lon] of CASES) {
    const u = toUtm(lat, lon);
    const back = fromUtm(u.e, u.n, u.zone, u.north);
    assert.ok(Math.abs(back.lat - lat) < 1e-8 && Math.abs(back.lon - lon) < 1e-8, JSON.stringify(back));
  }
  assert.equal(utmZone(-78.3), 17);
  assert.equal(utmZone(179.9), 60);
});
