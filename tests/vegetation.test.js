import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueNoise, forestCover, tileTrees, tileClutter, hashInts, TILE_M } from '../src/vegetation-logic.js';

const flat = () => 0;
const opts = { seed: 42, slopeAt: flat, size: 2000 };

test('value noise is in [0, 1], deterministic and smooth', () => {
  let prev = valueNoise(1, 0, 37, 100);
  for (let x = 1; x < 500; x++) {
    const v = valueNoise(1, x, 37, 100);
    assert.ok(v >= 0 && v <= 1);
    assert.ok(Math.abs(v - prev) < 0.05, 'no jumps between metres');
    prev = v;
  }
  assert.equal(valueNoise(1, 123.4, 567.8, 100), valueNoise(1, 123.4, 567.8, 100));
  assert.notEqual(valueNoise(1, 123.4, 567.8, 100), valueNoise(2, 123.4, 567.8, 100));
});

test('forest cover: mostly forest, some clearings, thinner on steep ground', () => {
  let sum = 0, clear = 0, n = 0;
  for (let x = 0; x < 2000; x += 25) for (let z = 0; z < 2000; z += 25) {
    const c = forestCover(42, x, z, 0);
    sum += c; n++;
    if (c < 0.1) clear++;
  }
  const mean = sum / n;
  assert.ok(mean > 0.55 && mean < 0.9, `mean cover ${mean}`);
  assert.ok(clear / n > 0.03, 'there are clearings');
  for (let x = 0; x < 2000; x += 97) {
    assert.ok(forestCover(42, x, 500, 1.2) <= forestCover(42, x, 500, 0) + 1e-12);
  }
});

test('tile trees: deterministic, inside the tile and area, sensible spacing', () => {
  const a = tileTrees(10, 20, opts), b = tileTrees(10, 20, opts);
  assert.deepEqual(a, b);
  for (const t of a) {
    assert.ok(t.x >= 10 * TILE_M && t.x < 11 * TILE_M && t.z >= 20 * TILE_M && t.z < 21 * TILE_M);
    assert.ok(['oak', 'conifer', 'sapling'].includes(t.species));
  }
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    assert.ok(Math.hypot(a[i].x - a[j].x, a[i].z - a[j].z) > 1.5, 'trees are not on top of each other');
  }
});

test('tile trees: density over a big area is forest-like, and the preset thins it', () => {
  let full = 0, open = 0;
  for (let tx = 0; tx < 20; tx++) for (let tz = 0; tz < 20; tz++) {
    full += tileTrees(tx, tz, opts).length;
    open += tileTrees(tx, tz, { ...opts, density: 0.2 }).length;
  }
  const perHa = full / (400 * TILE_M * TILE_M / 10000);
  assert.ok(perHa > 80 && perHa < 260, `${perHa.toFixed(0)} trees per hectare`);
  assert.ok(open < full * 0.3 && open > 0, `open ${open} vs full ${full}`);
});

test('no trees near excluded points (stakes) or outside the area', () => {
  const ex = [{ x: 330, z: 650 }];
  for (let tx = 9; tx <= 11; tx++) for (let tz = 19; tz <= 21; tz++) {
    for (const t of tileTrees(tx, tz, { ...opts, exclude: ex, excludeR: 6 })) {
      assert.ok(Math.hypot(t.x - 330, t.z - 650) >= 6);
    }
  }
  assert.equal(tileTrees(-1, 5, opts).length, 0);
  assert.equal(tileTrees(70, 5, opts).length, 0);
});

test('clutter: shrubs common, rocks only on steep ground', () => {
  let shrubs = 0, rocksFlat = 0, rocksSteep = 0;
  for (let tx = 0; tx < 10; tx++) for (let tz = 0; tz < 10; tz++) {
    for (const c of tileClutter(tx, tz, opts)) { if (c.kind === 'shrub') shrubs++; if (c.kind === 'rock') rocksFlat++; }
    for (const c of tileClutter(tx, tz, { ...opts, slopeAt: () => 0.8 })) if (c.kind === 'rock') rocksSteep++;
  }
  assert.ok(shrubs > 100, `shrubs ${shrubs}`);
  assert.equal(rocksFlat, 0);
  assert.ok(rocksSteep > 0);
});

test('hashInts spreads nearby inputs', () => {
  const s = new Set();
  for (let i = 0; i < 1000; i++) s.add(hashInts(7, i) % 997);
  assert.ok(s.size > 600);
});
