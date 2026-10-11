import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Locomotion, PaceCounter, paceLength, strideFactor, toblerFactor } from '../src/locomotion.js';
import { DEFAULTS } from '../src/settings.js';

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be within ${eps} of ${b}`);

// Ground with a constant grade along +X (positive = uphill walking east).
function rampGround(gradeEast, size = 2000) {
  return { size, slopeAt: (x, z, dx, dz) => gradeEast * (dx / Math.hypot(dx, dz)) };
}
const flat = rampGround(0);

// Walk `metres` of horizontal distance in fixed frames, finishing on the exact distance.
function walk(loco, ground, metres, { dt = 1 / 72, dirX = 1, dirZ = 0, throttle = 1, x0 = 100, z0 = 1000, jog = false } = {}) {
  let x = x0, z = z0, left = 0, right = 0, frames = 0;
  let speed = loco.settings.baseSpeed;
  for (;;) {
    const remaining = metres - Math.hypot(x - x0, z - z0);
    if (remaining <= 1e-9 || frames > 1e6) break;
    const step = loco.step(Math.min(dt, remaining / speed), ground, x, z, dirX, dirZ, throttle, jog);
    if (step.dx === 0 && step.dz === 0) break;
    speed = loco.lastSpeed;
    x += step.dx; z += step.dz; frames++;
    for (const f of step.feet) f === 'left' ? left++ : right++;
  }
  return { x, z, left, right, frames, dist: Math.hypot(x - x0, z - z0) };
}

test('pace length from calibration', () => {
  close(paceLength({ paceCountPer100m: 65 }), 100 / 65);
  close(paceLength({ paceCountPer100m: 50 }), 2);
});

test('PaceCounter: feet alternate starting with the right, left lands each pace', () => {
  const p = new PaceCounter();
  assert.deepEqual(p.advance(1, 1), ['right']);
  assert.deepEqual(p.advance(1, 1), ['left']);
  assert.deepEqual(p.advance(2.5, 1), ['right', 'left']);
  assert.equal(p.leftCount, 2);
  assert.deepEqual(p.advance(0.5, 1), ['right']);
  assert.deepEqual(p.advance(0, 1), []);
});

test('M1 acceptance: 100 m of flat ground gives the calibrated count (within one pace)', () => {
  for (const count of [55, 62, 65, 70]) {
    for (const timeScale of [1, 2, 3]) {
      for (const dt of [1 / 72, 1 / 90, 1 / 30]) {
        const loco = new Locomotion({ ...DEFAULTS, paceCountPer100m: count, timeScale });
        const r = walk(loco, flat, 100, { dt });
        close(r.dist, 100, 1e-6);
        assert.ok(Math.abs(r.left - count) <= 1, `count ${count} x${timeScale} dt ${dt}: got ${r.left}`);
        assert.equal(loco.pace.leftCount, r.left);
      }
    }
  }
});

test('flat ground at the default calibration lands exactly 65', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  assert.equal(walk(loco, flat, 100).left, 65);
});

test('diagonal walking counts horizontal distance', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  assert.equal(walk(loco, flat, 100, { dirX: 1, dirZ: -1 }).left, 65);
});

test('base speed on flat ground, scaled by time compression and throttle', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  close(loco.step(1, flat, 500, 500, 0, -1).dz, -1.3);
  loco.settings.timeScale = 3;
  close(loco.step(1, flat, 500, 500, 0, -1, 0.5).dz, -1.95);
});

test('no movement or footfalls without input', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  assert.deepEqual(loco.step(1, flat, 500, 500, 0, 0), { dx: 0, dz: 0, feet: [] });
  assert.deepEqual(loco.step(1, flat, 500, 500, 1, 0, 0), { dx: 0, dz: 0, feet: [] });
});

test('Tobler factor: 1 on flat, slower uphill and on steep downhill, peak near -5%', () => {
  close(toblerFactor(0), 1);
  assert.ok(toblerFactor(0.1) < 1);
  assert.ok(toblerFactor(-0.05) > 1);
  assert.ok(toblerFactor(-0.3) < 1);
  close(toblerFactor(0.2), Math.exp(-3.5 * 0.25) / Math.exp(-3.5 * 0.05));
});

test('stride factor shortens on slopes and is clamped', () => {
  close(strideFactor(0, DEFAULTS), 1);
  close(strideFactor(0.1, DEFAULTS), 0.92);
  close(strideFactor(-0.1, DEFAULTS), 0.96);
  close(strideFactor(2, DEFAULTS), 0.6);
  close(strideFactor(-5, DEFAULTS), 0.6);
});

test('slope effects: uphill raises the count per 100 m of map distance', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  const r = walk(loco, rampGround(0.15), 100);
  // stride 1 - 0.8*0.15 = 0.88 -> 65 / 0.88 = 73.9
  assert.equal(r.left, 73);
  const off = new Locomotion({ ...DEFAULTS, slopeEffects: false });
  assert.equal(walk(off, rampGround(0.15), 100).left, 65);
});

test('slope effects: uphill is slower than flat', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  const up = loco.step(1, rampGround(0.15), 500, 500, 1, 0).dx;
  assert.ok(up > 0 && up < 1.3);
});

test('boundary stops movement and footfalls', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  const s = loco.step(1, flat, 1999.5, 1000, 1, 0);
  close(s.dx, 0.5);
  const blocked = loco.step(1, flat, 2000, 1000, 1, 0);
  assert.equal(blocked.dx, 0);
  assert.deepEqual(blocked.feet, []);
  // Sliding along the edge still works.
  close(loco.step(1, flat, 2000, 1000, 1, -1).dz, -1.3 / Math.SQRT2);
});

test('jog: faster, with its own pace count on flat ground', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  const r = walk(loco, flat, 100, { jog: true });
  assert.equal(r.left, DEFAULTS.jogPaceCountPer100m);
  assert.equal(loco.lastGait, 'jog');
  close(loco.lastSpeed, DEFAULTS.jogSpeed, 1e-6);
  close(paceLength(DEFAULTS, 'jog'), 100 / DEFAULTS.jogPaceCountPer100m);
});

test('jog: too steep, and you walk at walking speed and count', () => {
  const loco = new Locomotion({ ...DEFAULTS });
  walk(loco, rampGround(0.3), 10, { jog: true });
  assert.equal(loco.lastGait, 'walk');
  assert.equal(loco.tooSteepToJog, true);
  assert.ok(loco.lastSpeed < DEFAULTS.baseSpeed, 'Tobler slows the walk uphill too');
  walk(loco, rampGround(0.2), 10, { jog: true });
  assert.equal(loco.lastGait, 'jog', 'a 20% grade is still jogging');
});
