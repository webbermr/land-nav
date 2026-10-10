import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compassHeading, angleDelta, DialDamper } from '../src/compass-math.js';

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be within ${eps} of ${b}`);
const UP = { x: 0, y: 1, z: 0 };

test('heading: pointing grid north with no G-M angle reads 0', () => {
  const h = compassHeading({ x: 0, y: 0, z: -1 }, UP, 0);
  close(h.grid, 0); close(h.magnetic, 0); close(h.tilt, 0);
});

test('heading: magnetic reading applies the G-M angle (both signs)', () => {
  // Pointing grid east.
  close(compassHeading({ x: 1, y: 0, z: 0 }, UP, 10).magnetic, 80);
  close(compassHeading({ x: 1, y: 0, z: 0 }, UP, -8.96).magnetic, 98.96);
  // Pointing grid north, magnetic 9 deg west of grid: reads 9.
  close(compassHeading({ x: 0, y: 0, z: -1 }, UP, -9).magnetic, 9);
});

test('heading: projected to horizontal, so pitching up or down does not change it', () => {
  const level = compassHeading({ x: 1, y: 0, z: -1 }, UP, 0).grid;
  close(compassHeading({ x: 1, y: 0.8, z: -1 }, UP, 0).grid, level);
  close(compassHeading({ x: 1, y: -2, z: -1 }, UP, 0).grid, level);
  close(level, 45);
});

test('heading: vertical axis has no heading', () => {
  assert.equal(compassHeading({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 0).magnetic, null);
});

test('tilt: angle of the face from level', () => {
  close(compassHeading({ x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 1 }, 0).tilt, 45, 1e-9);
  close(compassHeading({ x: 0, y: 0, z: -1 }, { x: Math.sin(0.2), y: Math.cos(0.2), z: 0 }, 0).tilt, 0.2 * 180 / Math.PI, 1e-9);
});

test('angleDelta takes the short way round', () => {
  close(angleDelta(350, 10), 20);
  close(angleDelta(10, 350), -20);
  close(angleDelta(0, 180), 180);
  close(angleDelta(90, 90), 0);
});

test('dial damper settles on the target and wraps through north', () => {
  const d = new DialDamper();
  d.update(350, 0.016);
  for (let i = 0; i < 300; i++) d.update(10, 1 / 72);
  close(d.reading, 10, 0.01);
  // It crossed north (350 -> 10), not the long way through 180.
  const e = new DialDamper();
  e.update(350, 0.016);
  let min = 360;
  for (let i = 0; i < 300; i++) { const r = e.update(10, 1 / 72); if (r > 90 && r < 270) min = Math.min(min, r); }
  assert.equal(min, 360);
});

test('dial damper is stable with long frames', () => {
  const d = new DialDamper();
  d.update(0, 0.01);
  for (let i = 0; i < 50; i++) d.update(120, 0.25);
  close(d.reading, 120, 0.01);
});
