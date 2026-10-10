import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sceneToMapPx, mapPxToScene, boardToMapPx, mapPxToBoard, boardToScene, sceneToBoard, boardScale, insideTerrain,
} from '../src/map-math.js';

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be within ${eps} of ${b}`);
const site = { size_m: 2000, map: { px: 4096, area: [323, 110, 3773, 3560] } };

test('terrain corners land on the map area corners', () => {
  assert.deepEqual(sceneToMapPx(site, 0, 0), { px: 323, py: 110 });
  assert.deepEqual(sceneToMapPx(site, 2000, 2000), { px: 3773, py: 3560 });
  const c = sceneToMapPx(site, 1000, 1000);
  close(c.px, 2048); close(c.py, 1835);
});

test('east is right and south is down on the map', () => {
  const a = sceneToMapPx(site, 100, 100), b = sceneToMapPx(site, 200, 300);
  assert.ok(b.px > a.px && b.py > a.py);
});

test('map pixels <-> scene round-trip', () => {
  const p = mapPxToScene(site, ...Object.values(sceneToMapPx(site, 1234.5, 678.9)));
  close(p.x, 1234.5, 1e-9); close(p.z, 678.9, 1e-9);
});

test('board centre is the image centre; board up is image up', () => {
  assert.deepEqual(boardToMapPx(site, 0, 0), { px: 2048, py: 2048 });
  const top = boardToMapPx(site, 0, 0.2);
  close(top.py, 0);
  const right = boardToMapPx(site, 0.2, 0);
  close(right.px, 4096);
  const b = mapPxToBoard(site, 1000, 3000);
  const back = boardToMapPx(site, b.bx, b.by);
  close(back.px, 1000, 1e-9); close(back.py, 3000, 1e-9);
});

test('board <-> scene round-trip', () => {
  const b = sceneToBoard(site, 1500, 250);
  const s = boardToScene(site, b.bx, b.by);
  close(s.x, 1500, 1e-9); close(s.z, 250, 1e-9);
});

test('board scale is about 1:5,900 for the default layout', () => {
  const s = boardScale(site);
  assert.ok(s > 5900 && s < 6000, String(s));
});

test('insideTerrain', () => {
  assert.ok(insideTerrain(site, 0, 2000));
  assert.ok(!insideTerrain(site, -1, 5));
});
