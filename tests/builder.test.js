import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  slugify, siteSquare, existingSquare, insideSquare, nextCourses, makeRequest, issueUrl, issueTitle, issueBody, cliCommands,
} from '../src/builder/request.js';

const SHEN = JSON.parse(readFileSync(new URL('../sites/shenandoah-matthews-arm/site.json', import.meta.url)));

test('siteSquare reproduces the corner make_site.py chose for Matthews Arm', () => {
  const sq = siteSquare(SHEN.center_lat, SHEN.center_lon, 2000);
  assert.equal(sq.zone, 17);
  assert.equal(sq.eWest, SHEN.e_west);
  assert.equal(sq.nNorth, SHEN.n_north);
  assert.deepEqual(sq.problems, []);
  const ex = existingSquare(SHEN);
  assert.equal(ex.eWest, SHEN.e_west);
  assert.ok(Math.abs(ex.corners[0].lat - sq.corners[0].lat) < 1e-9);
});

test('siteSquare flags a 100 km line, a zone edge and a band edge', () => {
  // Matthews Arm's north edge (4 295 080 m) is 4.9 km south of the 4 300 000 m
  // northing line; 5 km farther north, the line runs through the square.
  const north = siteSquare(38.7641 + 0.045, -78.2958, 2000);
  assert.ok(north.problems.some((p) => p.includes('100 km')), north.problems.join());
  assert.ok(siteSquare(38.76, -78.0005, 2000).problems.some((p) => p.includes('UTM zone')));
  assert.ok(siteSquare(40.0005, -78.3, 2000).problems.some((p) => p.includes('latitude band')));
});

test('insideSquare keeps a margin from the edges', () => {
  const sq = siteSquare(SHEN.center_lat, SHEN.center_lon, 2000);
  assert.ok(insideSquare(sq, SHEN.center_lat, SHEN.center_lon));
  assert.ok(!insideSquare(sq, SHEN.center_lat, SHEN.center_lon - 0.0118)); // ~1.02 km west
});

test('slugify and course naming avoid clashes', () => {
  assert.equal(slugify('Shenandoah NP: Old Rag!'), 'shenandoah-np-old-rag');
  assert.equal(slugify('Café Röthlisberger'), 'cafe-rothlisberger');
  const c = nextCourses('old-rag', 'Shenandoah NP: Old Rag', ['old-rag-1'], { day: 2, night: 1 });
  assert.deepEqual(c.map((x) => x.id), ['old-rag-2', 'old-rag-3', 'old-rag-night-1']);
  assert.deepEqual(c.map((x) => x.name), ['Old Rag 2', 'Old Rag 3', 'Old Rag Night 1']);
  assert.equal(c[2].night, true);
  // Names clash too: Matthews Arm already has a course called "Matthews Arm 1".
  // So does a name with a suffix: "Matthews Arm 2 (open)" takes "Matthews Arm 2".
  const m = nextCourses('shenandoah-matthews-arm', 'Shenandoah NP: Matthews Arm',
    ['matthews-arm-1', 'Matthews Arm 1', 'matthews-arm-2', 'Matthews Arm 2 (open)'], { day: 1 });
  assert.deepEqual(m.map((x) => x.name), ['Matthews Arm 3']);
});

function newSite(over = {}) {
  const sq = siteSquare(38.5512, -78.3155, 2000);
  return {
    mode: 'new', landcover: true, roads: true,
    site: { id: 'old-rag', name: 'Shenandoah NP: Old Rag', lat: 38.5512, lon: -78.3155, size: 2000, square: sq,
      start: { lat: 38.5545, lon: -78.3230, name: 'Saddle' }, declination: '', existingIds: ['demo-synthetic'], ...over },
    courses: [{ id: 'old-rag-1', name: 'Old Rag 1', night: false }, { id: 'old-rag-night-1', name: 'Old Rag Night 1', night: true, seed: 42 }],
  };
}

test('makeRequest: a new site with courses', () => {
  const { request, errors } = makeRequest(newSite(), () => 777);
  assert.deepEqual(errors, []);
  assert.equal(request.v, 1);
  assert.equal(request.site.new, true);
  assert.equal(request.site.declination, null, 'blank means work it out');
  assert.deepEqual(request.courses.map((c) => [c.seed, c.legMax, c.time]), [[777, 600, 120], [42, 350, 150]]);
  assert.equal(issueTitle(request), '[build] New site: Shenandoah NP: Old Rag');
});

test('makeRequest: says what is wrong', () => {
  const e = (over) => makeRequest(newSite(over)).errors.join(' | ');
  assert.match(e({ id: 'Old Rag' }), /lowercase/);
  assert.match(e({ name: '' }), /name/);
  assert.match(e({ square: null }), /Click the map/);
  assert.match(e({ start: { lat: 38.5545, lon: -78.3270, name: 'S' } }), /inside the square/);
  assert.match(e({ existingIds: ['old-rag'] }), /already a site/);
  assert.match(e({ declination: 'west' }), /Declination/);
  assert.match(makeRequest({ mode: 'update', site: { id: 'old-rag' }, courses: [] }).errors.join(), /Pick something/);
});

test('issue link carries the request; the build script can read it back', () => {
  const { request } = makeRequest(newSite(), () => 777);
  const url = new URL(issueUrl(request));
  assert.equal(url.pathname, '/webbermr/land-nav/issues/new');
  const body = url.searchParams.get('body');
  assert.equal(body, issueBody(request));
  const json = body.match(/```json\s*(\{[\s\S]*?\})\s*```/)[1];
  assert.deepEqual(JSON.parse(json), request);
  assert.ok(url.href.length < 6000, `URL is ${url.href.length} characters`);
});

test('cliCommands: the same build in the terminal, quoted safely', () => {
  const { request } = makeRequest(newSite({ name: "Bob's Hill" }), () => 777);
  const cmds = cliCommands(request, new Date('2026-10-11T12:00:00Z'));
  assert.equal(cmds.length, 5);
  assert.match(cmds[0], /--name 'Bob'\\''s Hill'/);
  assert.match(cmds[0], /--declination <declination> --declination-date 2026-10-11/);
  assert.match(cmds[4], /--night$/);
});
