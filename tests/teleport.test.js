import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceArc, launchSpeed, rigShift, GRAVITY } from '../src/teleport-logic.js';

const flat = () => 0;
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);

test('on flat ground the arc lands where ballistics says', () => {
  const range = 60, h = 1.5, th = Math.PI / 4;
  const dir = { x: 0, y: Math.sin(th), z: -Math.cos(th) }; // grid north, 45 degrees up
  const r = traceArc({ x: 500, y: h, z: 500 }, dir, { range, heightAt: flat, size: 1000 });
  const v = launchSpeed(range);
  const t = (v * Math.sin(th) + Math.sqrt((v * Math.sin(th)) ** 2 + 2 * GRAVITY * h)) / GRAVITY;
  const expected = v * Math.cos(th) * t;
  assert.ok(r.valid);
  near(500 - r.hit.z, expected, 0.01);
  near(r.hit.x, 500, 1e-9);
  assert.equal(r.hit.y, 0);
  // Drawn points are about half a metre apart.
  const gaps = r.points.slice(1, -1).map((p, i) => Math.hypot(p.x - r.points[i].x, p.y - r.points[i].y, p.z - r.points[i].z));
  assert.ok(gaps.every((d) => d > 0.3 && d < 0.75), `gaps ${Math.min(...gaps)}..${Math.max(...gaps)}`);
});

test('a hill in the way stops the arc early', () => {
  const hill = (x, z) => (z < 480 ? 50 : 0); // a cliff 20 m north
  const dir = { x: 0, y: Math.SQRT1_2, z: -Math.SQRT1_2 };
  const r = traceArc({ x: 500, y: 1.5, z: 500 }, dir, { range: 60, heightAt: hill, size: 1000 });
  assert.ok(r.valid);
  near(r.hit.z, 480, 0.01);
  assert.equal(r.hit.y, 50);
});

test('pointing down lands close; off the edge is not a valid landing', () => {
  const down = traceArc({ x: 10, y: 1.5, z: 10 }, { x: 0, y: -0.8, z: -0.6 }, { range: 60, heightAt: flat, size: 1000 });
  assert.ok(down.valid && Math.hypot(down.hit.x - 10, down.hit.z - 10) < 2);
  const out = traceArc({ x: 5, y: 1.5, z: 500 }, { x: -Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, { range: 60, heightAt: flat, size: 1000 });
  assert.ok(out.hit && !out.valid, 'lands west of x = 0');
});

test('rigShift moves the head onto the target', () => {
  assert.deepEqual(rigShift({ x: 3, z: 4 }, { x: 10, z: -2 }), { dx: 7, dz: -6 });
});

test('rayGround finds where a line of sight meets the ground', async () => {
  const { rayGround } = await import('../src/teleport-logic.js');
  // From 1.7 m, looking 10 degrees down: hits flat ground at 1.7 / tan(10 deg).
  const a = (10 * Math.PI) / 180;
  const hit = rayGround({ x: 0, y: 1.7, z: 0 }, { x: 0, y: -Math.sin(a), z: -Math.cos(a) }, flat);
  near(-hit.z, 1.7 / Math.tan(a), 1e-3);
  // Looking up: nothing.
  assert.equal(rayGround({ x: 0, y: 1.7, z: 0 }, { x: 0, y: 0.5, z: -0.866 }, flat), null);
});
