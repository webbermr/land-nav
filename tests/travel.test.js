import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sceneToLatLon, latLonToScene, squareStep, neighbourCentre, edgeStep, pushingOut, arrivalOn,
  loadPlaces, savePlaces, sortPlaces, addPlace, touchRecent, removePlace, spotName,
} from '../src/travel-logic.js';
import { toUtm } from '../src/utm.js';

const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (±${eps})`);
const SITE = { epsg: 32617, e_west: 732000, n_north: 4271000, size_m: 2000 };

test('scene <-> lat/lon round trip', () => {
  const ll = sceneToLatLon(SITE, 300, 1700);
  const p = latLonToScene(SITE, ll.lat, ll.lon);
  near(p.x, 300, 1e-3); near(p.z, 1700, 1e-3);
});

test('neighbours: the square east is 2 km east, the square south 2 km south', () => {
  const e = toUtm(...Object.values(neighbourCentre(SITE, 1, 0)), 17);
  near(e.e, 732000 + 1000 + 2000, 0.01); near(e.n, 4271000 - 1000, 0.01);
  const s = toUtm(...Object.values(neighbourCentre(SITE, 0, 1)), 17);
  near(s.e, 733000, 0.01); near(s.n, 4271000 - 3000, 0.01);
  assert.deepEqual(squareStep(SITE, 2003, 500), { i: 1, j: 0 });
  assert.deepEqual(squareStep(SITE, -1, -1), { i: -1, j: -1 });
  assert.deepEqual(squareStep(SITE, 1000, 1000), { i: 0, j: 0 });
});

test('edges: near which edge, and pushing out through it', () => {
  assert.deepEqual(edgeStep(2000, 1950, 1000, 200), { i: 1, j: 0 });
  assert.deepEqual(edgeStep(2000, 100, 100, 200), { i: -1, j: -1 });
  assert.deepEqual(edgeStep(2000, 1000, 1000, 200), { i: 0, j: 0 });
  assert.ok(pushingOut(2000, 2000, 1000, 1, 0));
  assert.ok(!pushingOut(2000, 2000, 1000, -1, 0), 'walking back in');
  assert.ok(!pushingOut(2000, 1990, 1000, 1, 0), 'not at the edge yet');
  assert.ok(pushingOut(2000, 500, 0, 0, -1), 'north edge');
});

test('arrival: the same ground, on the new square', () => {
  const east = { ...SITE, e_west: 734000 };
  const a = arrivalOn(SITE, 2003, 900, east);
  near(a.x, 3, 1e-3); near(a.z, 900, 1e-3);
  // Never right on the edge.
  const b = arrivalOn(SITE, 2000, 900, east);
  near(b.x, 2, 1e-9);
});

test('places: add, sort, recent squares, remove, survive storage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let places = loadPlaces(storage);
  assert.deepEqual(places, []);
  places = addPlace(places, { name: 'A', site: { id: 'x' }, view: { lat: 1, lon: 2, yaw: 0 } }, 1);
  places = touchRecent(places, { name: 'Sq', lat: 38.5, lon: -78.3, size: 2000 }, 2);
  places = addPlace(places, { name: 'B', site: { id: 'x' }, view: null }, 3);
  places = touchRecent(places, { name: 'Sq again', lat: 38.5, lon: -78.3, size: 2000 }, 4);
  assert.deepEqual(sortPlaces(places).map((p) => p.name), ['B', 'A', 'Sq again']);
  savePlaces(storage, places);
  assert.equal(loadPlaces(storage).length, 3);
  places = removePlace(places, places.find((p) => p.name === 'A'));
  assert.deepEqual(sortPlaces(places).map((p) => p.name), ['B', 'Sq again']);
  // At most 8 recent squares.
  for (let i = 0; i < 12; i++) places = touchRecent(places, { name: `R${i}`, lat: i, lon: i, size: 2000 }, 10 + i);
  assert.equal(places.filter((p) => p.recent).length, 8);
  assert.equal(sortPlaces(places).find((p) => p.recent).name, 'R11');
  storage.setItem('landnav.places.v1', '{broken');
  assert.deepEqual(loadPlaces(storage), []);
});

test('spot names', () => {
  assert.equal(spotName('Old Rag (built here)', 2, 'NW'), 'Old Rag, spot 2, facing NW');
});
