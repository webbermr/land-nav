import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  positionAt, trackBetween, pathLength, closestApproach, pointAtDistance, offsetFromLine,
  legWindows, legPace, analyzeRun, joggedLength, buildRunExport, formatDrift, formatPaceError, formatDuration,
} from '../src/aar-logic.js';
import { RunLog } from '../src/runlog.js';
import { BeadCounter } from '../src/beads.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Start at (500, 500). Point 1 is 300 m grid north, point 2 is 400 m east of it.
const COURSE = {
  id: 't', name: 'T', time_limit_min: 60, pass_threshold: 2,
  start: { x: 500, z: 500 },
  points: [{ code: 'A1', x: 500, z: 200 }, { code: 'B2', x: 900, z: 200 }],
  decoys: [{ code: 'Z9', x: 700, z: 450 }],
};

// Walk a straight line at 1 m/s, logging 1 s samples.
function walk(log, from, to, t0) {
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  for (let s = 1; s <= Math.ceil(d); s++) {
    const f = Math.min(1, s / d);
    log.sample(t0 + s, from.x + (to.x - from.x) * f, from.z + (to.z - from.z) * f);
  }
  return t0 + Math.ceil(d);
}

test('track helpers: interpolation, length, closest approach, point at distance', () => {
  const tr = [{ t: 0, x: 0, z: 0 }, { t: 10, x: 10, z: 0 }, { t: 20, x: 10, z: 10 }];
  assert.deepEqual(positionAt(tr, 5), { x: 5, z: 0 });
  assert.deepEqual(positionAt(tr, 99), { x: 10, z: 10 });
  const seg = trackBetween(tr, 5, 15);
  assert.deepEqual(seg.map((p) => [p.x, p.z]), [[5, 0], [10, 0], [10, 5]]);
  assert.equal(pathLength(seg), 10);
  const c = closestApproach(tr, { x: 4, z: 3 });
  assert.deepEqual([c.x, c.z, c.d, c.t], [4, 0, 3, 4]);
  const p = pointAtDistance(tr, 15);
  assert.deepEqual([p.x, p.z, p.t, p.short], [10, 5, 15, false]);
  assert.equal(pointAtDistance(tr, 50).short, true);
});

test('offsetFromLine: right of travel is positive', () => {
  // Travelling grid north: east is right.
  const o = offsetFromLine({ x: 0, z: 0 }, { x: 0, z: -100 }, { x: 20, z: -50 });
  near(o.lateral, 20);
  near(o.along, 50);
  // Travelling east: south (+z) is right.
  near(offsetFromLine({ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 10, z: 7 }).lateral, 7);
});

test('legWindows: punches end legs; an unpunched point ends at closest approach', () => {
  const log = new RunLog();
  log.sample(0, 500, 500);
  let t = walk(log, { x: 500, z: 500 }, { x: 500, z: 200 }, 0);
  log.event('punch', t, { code: 'A1', row: 0 });
  // Pass 30 m south of point 2 without punching, then go home.
  t = walk(log, { x: 500, z: 200 }, { x: 900, z: 230 }, t);
  const tNear = t;
  t = walk(log, { x: 900, z: 230 }, { x: 500, z: 500 }, t);
  const w = legWindows(COURSE, log);
  assert.equal(w.length, 3);
  assert.deepEqual([w[0].t0, w[0].t1, w[0].endedBy], [0, 300, 'punch']);
  assert.equal(w[1].endedBy, 'closest');
  // Closest where d/df of |(400(1-f), 30f)| is 0: f = 400^2 / (400^2 + 30^2).
  near(w[1].t1, 300 + (160000 / 160900) * Math.hypot(400, 30), 0.01);
  assert.ok(w[1].t1 < tNear);
  assert.deepEqual([w[2].t1, w[2].endedBy], [t, 'end']);
});

test('legWindows: legs follow the stakes punched, not the card rows', () => {
  // Skip point 1 entirely and punch point 2's stake into row 0 (a card error).
  const log = new RunLog();
  log.sample(0, 500, 500);
  let t = walk(log, { x: 500, z: 500 }, { x: 540, z: 200 }, 0); // 40 m east of point 1
  const tPass = t;
  t = walk(log, { x: 540, z: 200 }, { x: 900, z: 200 }, t);
  log.event('punch', t, { code: 'B2', row: 0 });
  const w = legWindows(COURSE, log);
  assert.equal(w[0].endedBy, 'closest');
  // Closest to point 1 is just before the turn: f = 300^2 / (40^2 + 300^2) along leg one.
  near(w[0].t1, (90000 / 91600) * Math.hypot(40, 300), 0.01);
  assert.ok(w[0].t1 <= tPass);
  assert.deepEqual([w[1].t1, w[1].endedBy], [t, 'punch']);
});

test('legPace: a reset at the punch belongs to the next leg', () => {
  const track = [{ t: 0, x: 0, z: 0 }, { t: 1000, x: 1000, z: 0 }];
  const beads = new BeadCounter();
  for (const t of [100, 200]) beads.slide(t, {});
  beads.reset(250, {});
  assert.equal(legPace(track, beads.log, 0, 250).beads, 2);
});

test('legWindows: a wrong punch is passed over for the right one in the same row', () => {
  const log = new RunLog();
  log.sample(0, 500, 500);
  const t = walk(log, { x: 500, z: 500 }, { x: 500, z: 200 }, 0);
  log.event('punch', 100, { code: 'Z9', row: 0 });
  log.event('punch', t, { code: 'A1', row: 0 });
  assert.equal(legWindows(COURSE, log)[0].t1, t);
});

test('legPace: beads since the leg began (or the last reset) against distance walked', () => {
  const track = [{ t: 0, x: 0, z: 0 }, { t: 1000, x: 1000, z: 0 }];
  const beads = new BeadCounter();
  // Slides at 110, 220, 330 m: the beads claim 300 m for 330 walked.
  for (const t of [110, 220, 330]) beads.slide(t, {});
  const p = legPace(track, beads.log, 0, 500);
  assert.deepEqual([p.beads, p.claimed], [3, 300]);
  near(p.walked, 330);
  near(p.error, 300 / 330 - 1);
  // A reset at 400 m restarts the count; one slide at 495 is 100 m claimed for 95.
  beads.reset(400, {});
  beads.slide(495, {});
  const q = legPace(track, beads.log, 0, 500);
  assert.deepEqual([q.beads, q.claimed], [1, 100]);
  near(q.walked, 95);
  assert.equal(legPace(track, [], 0, 500), null);
});

test('analyzeRun: azimuths, drift, closest approach, correctness and totals', () => {
  const log = new RunLog();
  log.sample(0, 500, 500);
  // Leg 1 drifts: aims 6 degrees right, so 300 m on, you're ~31 m right of the line.
  const drifted = { x: 500 + 300 * Math.sin(6 * Math.PI / 180), z: 500 - 300 * Math.cos(6 * Math.PI / 180) };
  let t = walk(log, { x: 500, z: 500 }, drifted, 0);
  t = walk(log, drifted, { x: 500, z: 200 }, t);
  log.event('punch', t, { code: 'A1', row: 0 });
  t = walk(log, { x: 500, z: 200 }, { x: 900, z: 200 }, t);
  log.event('punch', t, { code: 'B2', row: 1 });
  log.tool('map', true, 10); log.tool('map', false, 40);
  t = walk(log, { x: 900, z: 200 }, { x: 500, z: 500 }, t);
  log.finish(t, 500, 500);
  const result = { rows: [{ code: 'A1', entered: 'A1' }, { code: 'B2', entered: 'Z9' }] };
  const a = analyzeRun({ course: COURSE, log: log.toJSON(), beads: [], result }, { gm_angle_deg: -11.7 });
  const [l1, l2, l3] = a.legs;
  near(l1.gridAz, 0);
  near(l1.magAz, 11.7);
  near(l1.distance, 300);
  near(l1.drift.lateral, 300 * Math.sin(6 * Math.PI / 180), 0.5);
  assert.equal(formatDrift(l1.drift.lateral), '31 m right');
  assert.ok(l1.found);
  assert.equal(l1.correct, true);
  near(l2.gridAz, 90);
  assert.equal(l2.correct, false, 'wrong code entered for point 2');
  near(l3.gridAz, 233.13, 0.01);
  assert.equal(l3.label, 'Start');
  near(a.totals.mapSec, 30);
  near(a.totals.ideal, 300 + 400 + 500);
  assert.ok(a.totals.walked > a.totals.ideal);
  assert.equal(a.pace, null);
});

test('buildRunExport: self-contained and JSON-safe', () => {
  const log = new RunLog();
  log.sample(0, 1, 2);
  const site = { id: 's', name: 'S', epsg: 32617, e_west: 1, n_north: 2, gm_angle_deg: -11.7, extra: 'dropped' };
  const e = buildRunExport({ course: COURSE, site, log, beads: [], result: { pass: true }, settings: { paceCountPer100m: 65, timeScale: 1, slopeEffects: true, preset: 'open' }, date: new Date(0) });
  const back = JSON.parse(JSON.stringify(e));
  assert.equal(back.format, 'land-nav-run');
  assert.equal(back.site.extra, undefined);
  assert.deepEqual(back.log.track, [{ t: 0, x: 1, z: 2 }]);
  assert.equal(back.settings.paceCountPer100m, 65);
  assert.equal(back.date, '1970-01-01T00:00:00.000Z');
});

test('formatting', () => {
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3725), '1:02:05');
  assert.equal(formatDrift(-12.4), '12 m left');
  assert.equal(formatDrift(0.3), 'on line');
  assert.equal(formatPaceError(0.083), '+8%');
  assert.equal(formatPaceError(-0.09), '-9%');
});

test('joggedLength: counts segments that end on a jogging sample', () => {
  const tr = [{ t: 0, x: 0, z: 0 }, { t: 1, x: 3, z: 0, j: 1 }, { t: 2, x: 6, z: 0, j: 1 }, { t: 3, x: 7, z: 0 }];
  assert.equal(joggedLength(tr), 6);
  const log = new RunLog();
  log.sample(0, 0, 0);
  log.sample(1, 3, 0, 1, true);
  assert.deepEqual(log.track[1], { t: 1, x: 3, z: 0, j: 1 });
});
