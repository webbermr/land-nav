import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureIndex, pointInPolygon, closestOnSegment, stakeAvoider, AREA_DENSITY } from '../src/features-logic.js';
import { resolveCollisions } from '../src/collision.js';
import { Heightfield } from '../src/heightfield.js';
import { Locomotion } from '../src/locomotion.js';
import { DEFAULTS } from '../src/settings.js';
import { tileTrees } from '../src/vegetation-logic.js';
import { generateCourse } from '../src/course-logic.js';

const FEATURES = {
  lines: [
    { kind: 'road', width: 4, pts: [[0, 100], [300, 100]] },
    { kind: 'trail', width: 1.2, pts: [[150, 0], [150, 300]] },
  ],
  areas: [
    { kind: 'campground', name: 'Camp', pts: [[200, 150], [280, 150], [280, 230], [200, 230]] },
    { kind: 'building', pts: [[50, 50], [60, 50], [60, 58], [50, 58]] },
  ],
  points: [],
};

test('pointInPolygon and closestOnSegment', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.ok(pointInPolygon(5, 5, sq));
  assert.ok(!pointInPolygon(15, 5, sq));
  const c = closestOnSegment(5, 3, 0, 0, 10, 0);
  assert.deepEqual([c.x, c.z, c.d], [5, 0, 3]);
  assert.equal(closestOnSegment(-4, 3, 0, 0, 10, 0).d, 5); // past the end: the endpoint
});

test('FeatureIndex: no trees on roads, trails or by buildings; thin in the campground', () => {
  const ix = new FeatureIndex(FEATURES);
  assert.equal(ix.density(120, 100), 0);          // on the road
  assert.equal(ix.density(120, 104), 0);          // shoulder (2 m half-width + 2.5 m)
  assert.equal(ix.density(120, 110), 1);          // woods beside it
  assert.equal(ix.density(150.5, 20), 0);         // on the trail
  assert.equal(ix.density(55, 54), 0);            // in the building
  assert.equal(ix.density(62, 54), 0);            // just outside it
  assert.equal(ix.density(240, 190), AREA_DENSITY.campground);
  assert.equal(ix.density(10, 10), 1);
  assert.equal(ix.surfaceAt(120, 101), 'road');
  assert.equal(ix.surfaceAt(240, 190), 'campground');
  assert.equal(ix.surfaceAt(10, 10), null);
});

test('FeatureIndex: distanceTo and the stake avoider', () => {
  const ix = new FeatureIndex(FEATURES);
  assert.equal(ix.distanceTo(120, 120, ['road'], 30), 18); // 20 m from the centreline, road 4 m wide
  assert.equal(ix.distanceTo(120, 160, ['road'], 30), Infinity);
  assert.equal(ix.distanceTo(240, 190, ['campground'], 30), 0);
  const avoid = stakeAvoider(ix);
  assert.ok(avoid({ x: 120, z: 120 }));
  assert.ok(!avoid({ x: 120, z: 200 }));
  assert.ok(!avoid({ x: 151, z: 200 }), 'trails are allowed near stakes');
});

test('tileTrees honours densityAt: none where it is 0', () => {
  const ix = new FeatureIndex(FEATURES);
  const opts = { seed: 7, slopeAt: () => 0, size: 400, densityAt: (x, z) => ix.density(x, z) };
  for (let tx = 0; tx < 9; tx++) { // the road ends at x 300
    for (const t of tileTrees(tx, 3, opts)) assert.ok(Math.abs(t.z - 100) >= 4.5, `tree at ${t.x},${t.z} on the road`);
  }
  const none = tileTrees(1, 1, { ...opts, densityAt: () => 0 });
  assert.equal(none.length, 0);
});

test('resolveCollisions: out of trunks, logs and buildings', () => {
  const r = 0.25;
  let p = resolveCollisions(0.3, 0, r, [{ type: 'circle', x: 0, z: 0, r: 0.3 }]);
  assert.ok(p.hit);
  assert.ok(Math.abs(Math.hypot(p.x, p.z) - 0.55) < 1e-9);
  p = resolveCollisions(1, 0.1, r, [{ type: 'capsule', ax: -2, az: 0, bx: 2, bz: 0, r: 0.2 }]);
  assert.ok(Math.abs(p.z - 0.45) < 1e-9 && p.x === 1);
  // Inside a footprint: out through the nearest wall.
  p = resolveCollisions(9, 5, r, [{ type: 'poly', pts: [[0, 0], [10, 0], [10, 10], [0, 10]] }]);
  assert.ok(Math.abs(p.x - 10.25) < 1e-9 && p.z === 5);
  p = resolveCollisions(5, 5, r, []);
  assert.deepEqual(p, { x: 5, z: 5, hit: false });
});

function flat(grid = 101, spacing = 4) {
  return new Heightfield(new Float32Array(grid * grid), grid, spacing);
}

test('Locomotion: a tree in the way stops you and the pace count; you slide past at an angle', () => {
  const field = flat();
  const tree = [{ type: 'circle', x: 50, z: 40, r: 0.3 }];
  const ground = {
    slopeAt: (...a) => field.slopeAt(...a), size: field.size,
    collide: (x, z) => resolveCollisions(x, z, 0.25, tree),
  };
  const loco = new Locomotion({ ...DEFAULTS });
  let x = 50, z = 50;
  for (let i = 0; i < 1000; i++) { const s = loco.step(1 / 60, ground, x, z, 0, -1); x += s.dx; z += s.dz; }
  assert.ok(Math.abs(z - 40.55) < 1e-6, `stopped at the trunk, z ${z}`);
  assert.ok(loco.pace.distance < 9.46, 'only the distance actually walked counts');
  // Off-centre: slides around it and carries on north.
  const loco2 = new Locomotion({ ...DEFAULTS });
  x = 50.2; z = 50;
  for (let i = 0; i < 1000; i++) { const s = loco2.step(1 / 60, ground, x, z, 0, -1); x += s.dx; z += s.dz; }
  assert.ok(z < 35, `slid past, z ${z}`);
});

test('generateCourse keeps stakes where avoid() allows', () => {
  const field = flat(301, 4);
  const site = { id: 't', size_m: field.size };
  const avoid = (p) => p.x < 600; // west half off-limits
  const c = generateCourse(site, field, 5, { avoid, start: { x: 800, z: 600 } });
  for (const p of [...c.points, ...c.decoys]) assert.ok(p.x >= 600);
});

test('Heightfield.meshHeightAt matches the drawn triangles', () => {
  // One cell: a=0 (NW), b=4 (NE), d=8 (SW), e=0 (SE). Split on the NE-SW diagonal.
  const f = new Heightfield(new Float32Array([0, 4, 8, 0]), 2, 10);
  assert.equal(f.meshHeightAt(0, 0), 0);
  assert.equal(f.meshHeightAt(10, 10), 0);
  assert.equal(f.meshHeightAt(5, 5), 6);       // on the diagonal: midway between b and d
  assert.equal(f.meshHeightAt(2, 2), 0.8 + 1.6);
  assert.equal(f.heightAt(5, 5), 3);           // bilinear differs
});
