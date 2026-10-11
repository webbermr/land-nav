import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LandCover, landcoverCover, NLCD_NAMES } from '../src/landcover.js';
import { tileTrees } from '../src/vegetation-logic.js';

// 3x3 grid at 10 m: west column deciduous 100% canopy, middle evergreen 50%,
// east column pasture 0%.
function sample() {
  const g = 3;
  const cls = [41, 42, 81, 41, 42, 81, 41, 42, 81];
  const can = [100, 50, 0, 100, 50, 0, 100, 50, 0];
  return new LandCover(new Uint8Array([...cls, ...can]).buffer, { grid: g, spacing_m: 10 });
}

test('LandCover: classes, canopy and conifer share, smooth between cells', () => {
  const lc = sample();
  assert.equal(lc.classAt(0, 0), 41);
  assert.equal(lc.classAt(9, 20), 42);
  assert.equal(lc.classAt(20, 0), 81);
  assert.equal(NLCD_NAMES[lc.classAt(20, 0)], 'pasture/hay');
  assert.equal(lc.canopyAt(0, 0), 1);
  assert.equal(lc.canopyAt(5, 0), 0.75);
  assert.equal(lc.canopyAt(15, 7), 0.25);
  assert.equal(lc.evergreenAt(10, 10), 1);
  assert.equal(lc.evergreenAt(5, 10), 0.5);
  assert.equal(lc.canopyAt(-50, 99), 1, 'clamped at the edge');
  assert.throws(() => new LandCover(new ArrayBuffer(10), { grid: 3, spacing_m: 10 }));
});

test('landcoverCover follows the canopy: full forest near 1, pasture 0', () => {
  const lc = sample();
  let forest = 0, field = 0;
  for (let i = 0; i < 50; i++) {
    forest += landcoverCover(lc, 7, 0, i * 0.4, 0);
    field += landcoverCover(lc, 7, 20, i * 0.4, 0);
  }
  assert.ok(forest / 50 > 0.9, `forest ${forest / 50}`);
  assert.equal(field, 0);
  // Very steep ground thins even full forest.
  assert.ok(landcoverCover(lc, 7, 0, 0, 1.5) < 0.5);
});

test('tileTrees with land cover: no trees in the field, conifers where it is evergreen', () => {
  // A wide strip: x < 100 deciduous forest, 100..200 evergreen, > 200 pasture.
  const g = 41;
  const cls = new Uint8Array(g * g), can = new Uint8Array(g * g);
  for (let r = 0; r < g; r++) {
    for (let c = 0; c < g; c++) {
      const x = c * 10;
      cls[r * g + c] = x < 100 ? 41 : x <= 200 ? 42 : 81;
      can[r * g + c] = x <= 200 ? 95 : 0;
    }
  }
  const lc = new LandCover(new Uint8Array([...cls, ...can]).buffer, { grid: g, spacing_m: 10 });
  const opts = {
    seed: 5, slopeAt: () => 0, size: 400,
    coverAt: (x, z, s) => landcoverCover(lc, 5, x, z, s), evergreenAt: (x, z) => lc.evergreenAt(x, z),
  };
  const trees = [];
  for (let tx = 0; tx < 12; tx++) for (let tz = 0; tz < 6; tz++) trees.push(...tileTrees(tx, tz, opts));
  assert.ok(!trees.some((t) => t.x > 215), 'none in the pasture');
  const big = (lo, hi) => trees.filter((t) => t.x > lo && t.x < hi && t.species !== 'sapling');
  assert.ok(big(0, 85).every((t) => t.species === 'oak'), 'deciduous: hardwoods');
  assert.ok(big(115, 190).every((t) => t.species === 'conifer'), 'evergreen: conifers');
  assert.ok(big(0, 85).length > 50 && big(115, 190).length > 50);
});
