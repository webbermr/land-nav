import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solarPosition, sunTimes, worldTime, clockText, guessUtcOffsetMin, usDst, skyState, sceneDirection, siderealDeg,
} from '../src/sun-logic.js';
import { nearestLinePoint, FeatureIndex } from '../src/features-logic.js';

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (±${eps})`);
const DC = { lat: 38.9, lon: -77.04 };

test('solar noon at the June solstice: 90 - latitude + 23.44 degrees, due south', () => {
  let best = { e: -90 };
  for (let t = Date.UTC(2024, 5, 21, 15); t < Date.UTC(2024, 5, 21, 19); t += 60000) {
    const p = solarPosition(new Date(t), DC.lat, DC.lon);
    if (p.elevation > best.e) best = { e: p.elevation, az: p.azimuth, t };
  }
  near(best.e, 90 - DC.lat + 23.44, 0.1, 'elevation');
  near(best.az, 180, 1, 'azimuth');
  // Solar noon in Washington is about 13:10 EDT (17:10 UTC) in late June.
  near((best.t - Date.UTC(2024, 5, 21, 17, 10)) / 60000, 0, 3, 'minutes');
});

test('sunrise and sunset in Washington match the almanac to a couple of minutes', () => {
  // USNO: 21 Jun 2024 rise 05:43, set 20:37 EDT; 21 Dec 2024 rise 07:23, set 16:49 EST.
  const june = sunTimes(new Date(Date.UTC(2024, 5, 21, 16)), DC.lat, DC.lon, -240);
  const dec = sunTimes(new Date(Date.UTC(2024, 11, 21, 16)), DC.lat, DC.lon, -300);
  const min = (d, off) => { const [h, m] = clockText(d, off).split(':').map(Number); return h * 60 + m; };
  near(min(june.rise, -240), 5 * 60 + 43, 2, 'June rise');
  near(min(june.set, -240), 20 * 60 + 37, 2, 'June set');
  near(min(dec.rise, -300), 7 * 60 + 23, 2, 'Dec rise');
  near(min(dec.set, -300), 16 * 60 + 49, 2, 'Dec set');
});

test('morning sun is in the east, evening sun in the west', () => {
  const am = solarPosition(new Date(Date.UTC(2024, 2, 20, 12)), DC.lat, DC.lon);
  const pm = solarPosition(new Date(Date.UTC(2024, 2, 20, 22)), DC.lat, DC.lon);
  assert.ok(am.azimuth > 60 && am.azimuth < 140, `am ${am.azimuth}`);
  assert.ok(pm.azimuth > 220 && pm.azimuth < 300, `pm ${pm.azimuth}`);
});

test('worldTime: the real time, or a picked local clock time today or on a given day', () => {
  const now = Date.UTC(2026, 9, 11, 20, 0); // 16:00 EDT
  assert.equal(worldTime(now, -1, -240).getTime(), now);
  assert.equal(clockText(worldTime(now, 6 * 60 + 30, -240), -240), '06:30');
  assert.equal(new Date(worldTime(now, 6 * 60 + 30, -240).getTime() - 240 * 60000).getUTCDate(), 11);
  const replay = worldTime(now, 15 * 60, -240, '2024-07-04');
  assert.equal(replay.toISOString(), '2024-07-04T19:00:00.000Z');
  // A replayed day with no time picked keeps the real time of day.
  assert.equal(clockText(worldTime(now, -1, -240, '2024-07-04'), -240), '16:00');
});

test('UTC offset guess: Eastern, with US daylight saving', () => {
  assert.equal(guessUtcOffsetMin(-78.3, new Date(Date.UTC(2026, 6, 1))), -240);
  assert.equal(guessUtcOffsetMin(-78.3, new Date(Date.UTC(2026, 0, 1))), -300);
  assert.equal(guessUtcOffsetMin(-105, new Date(Date.UTC(2026, 0, 1))), -420);
  assert.ok(usDst(new Date(Date.UTC(2026, 2, 8, 8))) && !usDst(new Date(Date.UTC(2026, 2, 7, 12))), 'starts 8 Mar 2026');
  assert.ok(!usDst(new Date(Date.UTC(2026, 10, 1, 8))) && usDst(new Date(Date.UTC(2026, 9, 31, 12))), 'ends 1 Nov 2026');
});

test('skyState: bright by day, dark below -5 degrees, stars only at night', () => {
  const noon = skyState(50), dusk = skyState(-3), night = skyState(-20);
  assert.ok(noon.sunIntensity > 2 && !noon.dark && noon.stars === 0);
  assert.ok(dusk.sunIntensity === 0 && !dusk.dark);
  assert.ok(night.dark && night.stars === 1 && night.hemiIntensity < 0.1);
  assert.ok(noon.sky.top[2] > night.sky.top[2] * 10);
  // Low sun is redder than high sun.
  const low = skyState(2).sunColor, high = skyState(40).sunColor;
  assert.ok(low[2] / low[0] < high[2] / high[0]);
});

test('sceneDirection: true azimuth turned to grid by the convergence', () => {
  const s = sceneDirection(180, 0, 0);
  near(s.x, 0, 1e-9); near(s.z, 1, 1e-9); // south is +z
  const e = sceneDirection(90, 0, 2); // true east is 88 degrees grid
  near(Math.atan2(e.x, -e.z) * 180 / Math.PI, 88, 1e-9);
  near(sceneDirection(0, 90).y, 1, 1e-12);
});

test('sidereal time advances about 361 degrees a day', () => {
  const a = siderealDeg(new Date(Date.UTC(2026, 0, 1)), 0);
  const b = siderealDeg(new Date(Date.UTC(2026, 0, 2)), 0);
  near(((b - a) + 360) % 360, 0.9856, 0.001);
  // GMST at 2000-01-01 12:00 UT is 280.46 degrees.
  near(siderealDeg(new Date(Date.UTC(2000, 0, 1, 12)), 0), 280.46, 0.01);
});

test('nearestLinePoint finds the closest point on a stream', () => {
  const idx = new FeatureIndex({ lines: [{ kind: 'stream', width: 2, pts: [[0, 100], [200, 100]] }, { kind: 'road', width: 6, pts: [[0, 10], [200, 10]] }], areas: [] });
  const p = nearestLinePoint(idx, 50, 60, ['stream'], 80);
  assert.deepEqual({ x: p.x, z: p.z, d: p.d }, { x: 50, z: 100, d: 40 });
  assert.equal(nearestLinePoint(idx, 50, 0, ['stream'], 50), null);
});
