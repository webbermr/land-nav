import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeHeights, Heightfield } from '../src/heightfield.js';
import {
  mulberry32, slopeAt, generateCourse, validateCourse, idealDistance, scoreRun, GEN_DEFAULTS,
} from '../src/course-logic.js';
import { BeadCounter } from '../src/beads.js';
import { RunLog } from '../src/runlog.js';

const dir = new URL('../sites/demo-synthetic/', import.meta.url);
const site = JSON.parse(readFileSync(new URL('site.json', dir)));
const buf = readFileSync(new URL('height.bin', dir));
const field = new Heightfield(
  decodeHeights(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), site.elev_min, site.elev_max, site.elev_ref),
  site.grid, site.spacing_m,
);

test('PRNG is deterministic and in [0, 1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('slopeAt measures grade on a known plane', () => {
  // h = 0.2 * x: a 20% grade everywhere.
  const g = 11, h = new Float32Array(g * g);
  for (let r = 0; r < g; r++) for (let c = 0; c < g; c++) h[r * g + c] = 0.2 * c * 4;
  const plane = new Heightfield(h, g, 4);
  assert.ok(Math.abs(slopeAt(plane, 20, 20) - 0.2) < 1e-6);
});

test('generator: valid courses for many seeds on the demo site', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const c = generateCourse(site, field, seed);
    assert.deepEqual(validateCourse(c, site, field), [], `seed ${seed}`);
    assert.equal(c.points.length, GEN_DEFAULTS.points);
    assert.equal(c.decoys.length, GEN_DEFAULTS.decoys);
    for (const p of [c.start, ...c.points, ...c.decoys]) {
      assert.equal(((p.x % 10) + 10) % 10, 5, 'x at a grid-square centre');
      assert.equal(((p.z % 10) + 10) % 10, 5, 'z at a grid-square centre');
    }
    for (const s of [...c.points, ...c.decoys]) assert.match(s.code, /^[A-HJ-NP-Z][1-9]$/);
  }
});

test('generator: same seed, same course; different seed, different course', () => {
  assert.deepEqual(generateCourse(site, field, 1234), generateCourse(site, field, 1234));
  assert.notDeepEqual(generateCourse(site, field, 1234).points, generateCourse(site, field, 1235).points);
});

test('generator honours options', () => {
  const c = generateCourse(site, field, 7, { points: 6, decoys: 2, passThreshold: 5, timeLimitMin: 90 });
  assert.equal(c.points.length, 6);
  assert.equal(c.decoys.length, 2);
  assert.equal(c.pass_threshold, 5);
  assert.equal(c.time_limit_min, 90);
  assert.deepEqual(validateCourse(c, site, field), []);
});

test('validator catches broken courses', () => {
  const c = generateCourse(site, field, 3);
  const bad = structuredClone(c);
  bad.points[0] = { ...bad.points[0], x: bad.start.x + 20, z: bad.start.z };   // short leg, too close
  bad.decoys[0] = { ...bad.decoys[0], x: 30, z: 30 };                         // near the edge
  bad.decoys[1] = { ...bad.decoys[1], code: bad.points[1].code };              // duplicate code
  bad.pass_threshold = 9;
  const problems = validateCourse(bad, site, field).join('\n');
  assert.match(problems, /leg 1 is 20 m/);
  assert.match(problems, /apart/);
  assert.match(problems, /boundary/);
  assert.match(problems, /not unique/);
  assert.match(problems, /pass threshold/);
});

test('ideal distance: start, points in order, back to start', () => {
  const c = { start: { x: 0, z: 0 }, points: [{ x: 300, z: 0 }, { x: 300, z: 400 }] };
  assert.equal(idealDistance(c), 300 + 400 + 500);
});

test('scoring: correct codes, threshold, time limit and returning to start', () => {
  const c = { time_limit_min: 60, pass_threshold: 2, points: [{ code: 'K7' }, { code: 'B3' }, { code: 'X9' }] };
  let r = scoreRun(c, ['K7', 'B3', 'Q1'], { elapsedSec: 3000, endedAtStart: true });
  assert.equal(r.correct, 2);
  assert.ok(r.pass);
  assert.deepEqual(r.rows.map((x) => x.correct), [true, true, false]);
  r = scoreRun(c, ['K7', null, 'X9'], { elapsedSec: 3601, endedAtStart: true });
  assert.ok(!r.timeOk && !r.pass, 'over time fails');
  r = scoreRun(c, ['K7', 'B3', 'X9'], { elapsedSec: 100, endedAtStart: false });
  assert.ok(!r.pass, 'must end back at the start');
  r = scoreRun(c, ['K7'], { elapsedSec: 100, endedAtStart: true });
  assert.equal(r.correct, 1);
  assert.equal(r.rows[2].entered, null);
});

test('pace beads: 9 lower, then an upper on the 10th; reset; wraps after 4.9 km', () => {
  const b = new BeadCounter();
  const p = { x: 1, z: 2 };
  for (let i = 0; i < 9; i++) b.slide(i, p);
  assert.deepEqual([b.lower, b.upper, b.metres], [9, 0, 900]);
  b.slide(9, p);
  assert.deepEqual([b.lower, b.upper, b.metres], [0, 1, 1000]);
  for (let i = 0; i < 37; i++) b.slide(10 + i, p);
  assert.deepEqual([b.lower, b.upper, b.metres], [7, 4, 4700]);
  for (let i = 0; i < 3; i++) b.slide(50 + i, p);
  assert.deepEqual([b.lower, b.upper], [0, 0]);
  b.slide(60, p);
  b.reset(61, { x: 5, z: 6 });
  assert.equal(b.metres, 0);
  assert.equal(b.log.length, 52); // 51 slides + 1 reset
  assert.deepEqual(b.log.at(-1), { t: 61, x: 5, z: 6, action: 'reset', lower: 0, upper: 0 });
  assert.deepEqual(b.log[0], { t: 0, x: 1, z: 2, action: 'slide', lower: 1, upper: 0 });
});

test('run log: samples about once a second, tool intervals, distance', () => {
  const log = new RunLog();
  for (let i = 0; i <= 20; i++) log.sample(i * 0.25, i * 0.25, 0);
  assert.deepEqual(log.track.map((p) => p.t), [0, 1, 2, 3, 4, 5]);
  log.tool('map', true, 1);
  log.tool('map', true, 2);
  log.tool('map', false, 3);
  log.tool('compass', true, 4);
  log.event('punch', 4.5, { code: 'K7' });
  log.finish(6, 6, 0);
  assert.deepEqual(log.intervals, { map: [[1, 3]], compass: [[4, 6]] });
  assert.equal(log.distance(), 6);
  assert.deepEqual(log.events, [{ t: 4.5, type: 'punch', code: 'K7' }]);
  assert.deepEqual(Object.keys(log.toJSON()), ['track', 'events', 'intervals']);
});
