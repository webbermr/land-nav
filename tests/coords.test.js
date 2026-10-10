// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDeg, gridAzimuth, directionFromAzimuth, backAzimuth,
  gridToMagnetic, magneticToGrid, degToMils, milsToDeg,
  sceneToUtm, utmToScene, gridDigits, eightDigitGrid, parseGrid,
  horizontalDistance,
} from '../src/coords.js';

const site = {
  mgrs_gzd: '18S',
  mgrs_100km: 'TJ',
  e_west: 284000,
  n_north: 4302000,
  size_m: 2000,
};

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be within ${eps} of ${b}`);

test('normalizeDeg wraps into [0, 360)', () => {
  close(normalizeDeg(0), 0);
  close(normalizeDeg(360), 0);
  close(normalizeDeg(-10), 350);
  close(normalizeDeg(725), 5);
  close(normalizeDeg(-360), 0);
});

test('grid azimuth: north is 0 (toward -Z)', () => {
  close(gridAzimuth(0, -1), 0);
});

test('grid azimuth: east is 90 (toward +X)', () => {
  close(gridAzimuth(1, 0), 90);
});

test('grid azimuth: south is 180, west is 270', () => {
  close(gridAzimuth(0, 1), 180);
  close(gridAzimuth(-1, 0), 270);
});

test('grid azimuth: diagonals and magnitude independence', () => {
  close(gridAzimuth(1, -1), 45);
  close(gridAzimuth(50, 50), 135);
  close(gridAzimuth(-3, 3), 225);
  close(gridAzimuth(-7, -7), 315);
});

test('directionFromAzimuth round-trips with gridAzimuth', () => {
  for (const az of [0, 12.5, 90, 181, 270, 359.9]) {
    const { dx, dz } = directionFromAzimuth(az);
    close(gridAzimuth(dx, dz), az, 1e-9);
    close(Math.hypot(dx, dz), 1, 1e-12);
  }
});

test('back azimuth', () => {
  close(backAzimuth(30), 210);
  close(backAzimuth(200), 20);
  close(backAzimuth(180), 0);
});

test('grid to magnetic, positive G-M angle (magnetic east of grid)', () => {
  // Magnetic north is 10 deg east of grid north, so a magnetic bearing reads 10 deg less.
  close(gridToMagnetic(90, 10), 80);
  close(gridToMagnetic(5, 10), 355);
  close(magneticToGrid(80, 10), 90);
  close(magneticToGrid(355, 10), 5);
});

test('grid to magnetic, negative G-M angle (magnetic west of grid)', () => {
  close(gridToMagnetic(90, -10), 100);
  close(gridToMagnetic(355, -10), 5);
  close(magneticToGrid(100, -10), 90);
  close(magneticToGrid(5, -10), 355);
});

test('grid/magnetic conversion round-trips', () => {
  for (const gm of [-17.25, -3, 0, 4.5, 21]) {
    for (const az of [0, 1, 179.5, 359]) {
      close(magneticToGrid(gridToMagnetic(az, gm), gm), az, 1e-9);
    }
  }
});

test('degrees and mils (6400 per circle)', () => {
  close(degToMils(360), 6400);
  close(degToMils(90), 1600);
  close(milsToDeg(3200), 180);
  close(milsToDeg(degToMils(37.3)), 37.3, 1e-9);
});

test('scene <-> UTM', () => {
  assert.deepEqual(sceneToUtm(site, 0, 0), { easting: 284000, northing: 4302000 });
  assert.deepEqual(sceneToUtm(site, 1420, 760), { easting: 285420, northing: 4301240 });
  assert.deepEqual(utmToScene(site, 285420, 4301240), { x: 1420, z: 760 });
});

test('8-digit grid of the NW corner', () => {
  // E 284000 -> 84000 -> 8400; N 4302000 -> 02000 -> 0200
  assert.equal(eightDigitGrid(site, 0, 0), '18S TJ 8400 0200');
});

test('8-digit grid of a known scene position', () => {
  // x=1420 -> E 285420 -> 85420 -> 8542
  // z=760  -> N 4301240 -> 01240 -> 0124
  assert.equal(eightDigitGrid(site, 1420, 760), '18S TJ 8542 0124');
});

test('8-digit grid truncates (does not round) within the 10 m square', () => {
  // E 284009.99 -> 8400, N 4301990.01 -> 0199
  assert.deepEqual(gridDigits(site, 9.99, 9.99), { e: '8400', n: '0199' });
  // Exactly on a 10 m line belongs to the square to the north/east.
  assert.deepEqual(gridDigits(site, 10, 10), { e: '8401', n: '0199' });
});

test('8-digit grid is zero-padded', () => {
  const s = { ...site, e_west: 300000, n_north: 4200050 };
  assert.deepEqual(gridDigits(s, 5, 0), { e: '0000', n: '0005' });
});

test('parseGrid returns the SW corner of the 10 m square, and round-trips', () => {
  assert.deepEqual(parseGrid(site, '18S TJ 8542 0124'), { x: 1420, z: 760 });
  assert.deepEqual(parseGrid(site, '85420124'), { x: 1420, z: 760 });
  const p = parseGrid(site, '8542 0124');
  assert.equal(eightDigitGrid(site, p.x + 5, p.z - 5), '18S TJ 8542 0124');
});

test('parseGrid rejects a grid outside this 100 km square ID', () => {
  assert.throws(() => parseGrid(site, '18S TK 8542 0124'));
  assert.throws(() => parseGrid(site, '123'));
});

test('horizontal distance', () => {
  close(horizontalDistance(0, 0, 300, -400), 500);
});
