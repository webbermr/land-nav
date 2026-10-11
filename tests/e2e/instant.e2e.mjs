// Browser check of building a site in the browser (?at=lat,lon), with the USGS,
// MRLC, OpenStreetMap and NAIP services faked so it runs offline and the same
// every time.
//   python3 -m http.server 8080 &
//   node tests/e2e/instant.e2e.mjs [http://localhost:8080/]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { writeGeoTiff } from '../../src/geo/tiff.js';
import { toUtm, fromUtm } from '../../src/utm.js';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch {
  playwright = require(execSync('npm root -g').toString().trim() + '/playwright');
}
const base = process.argv[2] || 'http://localhost:8080/';
const LAT = 38.5515, LON = -78.3155;

// A hill in the middle of a valley, in UTM metres.
const centre = toUtm(LAT, LON);
const hill = (e, n) => 500 + 300 * Math.exp(-(((e - centre.e) ** 2 + (n - centre.n) ** 2) / (2 * 700 ** 2)));

const cors = { 'access-control-allow-origin': '*' };
const counts = { dem: 0, wcs: 0, osm: 0, naip: 0 };

async function fakeServices(page) {
  await page.route('https://elevation.nationalmap.gov/**', (route) => {
    counts.dem++;
    const u = new URL(route.request().url());
    const [x0, y0, x1, y1] = u.searchParams.get('bbox').split(',').map(Number);
    const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const px = (x1 - x0) / w;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) data[r * w + c] = hill(x0 + (c + 0.5) * px, y1 - (r + 0.5) * px);
    route.fulfill({ contentType: 'image/tiff', headers: cors, body: Buffer.from(writeGeoTiff(w, h, data, { origin: [x0, y1], pixel: px })) });
  });
  await page.route('https://www.mrlc.gov/**', (route) => {
    counts.wcs++;
    const u = route.request().url();
    const [, x0, x1] = u.match(/subset=X\(([-\d.]+),([-\d.]+)\)/);
    const [, y0, y1] = u.match(/subset=Y\(([-\d.]+),([-\d.]+)\)/);
    const w = Math.ceil((x1 - x0) / 30), h = Math.ceil((y1 - y0) / 30);
    const canopy = /tcc/.test(u);
    // Forest, with a field in the western third.
    const data = new Uint8Array(w * h).map((_, i) => ((i % w) < w / 3 ? (canopy ? 0 : 81) : (canopy ? 85 : 41)));
    route.fulfill({ contentType: 'image/geotiff', headers: cors, body: Buffer.from(writeGeoTiff(w, h, data, { origin: [Number(x0), Number(y1)], pixel: 30, float: false })) });
  });
  const ll = (de, dn) => fromUtm(centre.e + de, centre.n + dn, centre.zone, true);
  const g = (pts) => pts.map(([de, dn]) => ({ lat: ll(de, dn).lat, lon: ll(de, dn).lon }));
  const osm = { elements: [
    { type: 'way', id: 1, tags: { highway: 'tertiary', name: 'Nethers Road' }, geometry: g([[-900, -300], [0, -250], [900, -200]]) },
    { type: 'way', id: 2, tags: { amenity: 'parking', name: 'Old Rag parking' }, nodes: [1, 2, 3, 4, 1], geometry: g([[100, -320], [140, -320], [140, -280], [100, -280], [100, -320]]) },
    { type: 'way', id: 3, tags: { highway: 'path', name: 'Ridge Trail' }, geometry: g([[120, -280], [0, 0], [-100, 300]]) },
  ] };
  await page.route('https://overpass*/**', (route) => { counts.osm++; route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(osm) }); });
  await page.route('https://overpass-api.de/**', (route) => { counts.osm++; route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(osm) }); });
  const img = readFileSync(new URL('../../sites/demo-synthetic/map.png', import.meta.url));
  await page.route('https://imagery.nationalmap.gov/**', (route) => { counts.naip++; route.fulfill({ contentType: 'image/png', headers: cors, body: img }); });
  // Weather stays put.
  await page.route('https://api.open-meteo.com/**', (route) => route.abort());
  await page.route('https://api.weather.gov/**', (route) => route.abort());
}

const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await fakeServices(page);

const check = (name, fn) => fn().then(() => console.log(`ok   ${name}`), (e) => { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; });
const url = `${base}?at=${LAT},${LON}&name=Test%20Hill&time=12:00&weather=clear&season=summer`;

await check('?at= builds the site in the browser: elevation, land cover, roads, map, declination', async () => {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__landnav?.tools, null, { timeout: 120000 });
  const s = await page.evaluate(() => {
    const l = window.__landnav;
    return {
      name: l.site.name, gzd: l.site.mgrs_gzd, sq: l.site.mgrs_100km, grid: l.site.grid, instant: l.site.instant,
      top: l.site.elev_max, decl: l.site.declination_deg, start: l.site.default_start,
      lc: l.landcover?.classAt(1500, 1000), lcWest: l.landcover?.classAt(100, 1000),
      roads: l.featureIndex?.features.lines.length, map: l.tools.map.paper.material.map.image.width,
      ground: l.terrain.heightAt(1000, 1000) + l.site.elev_ref,
    };
  });
  assert.equal(s.name, 'Test Hill');
  assert.ok(s.instant && s.grid === 501, JSON.stringify(s));
  assert.equal(`${s.gzd} ${s.sq}`, '17S QC');
  assert.ok(Math.abs(s.top - 800) < 2, `summit ${s.top}`);
  assert.ok(Math.abs(s.ground - 800) < 5, `ground at the middle ${s.ground}`);
  assert.ok(s.decl < -9 && s.decl > -11, `declination ${s.decl}`);
  assert.equal(s.lc, 41);
  assert.equal(s.lcWest, 81);
  assert.equal(s.roads, 2);
  assert.equal(s.start.name, 'Old Rag parking');
  assert.equal(s.map, 4096);
});

await check('the far view arrives: aerial photographs on the ground, terrain out to 20 km', async () => {
  await page.waitForFunction(() => window.__landnav.scene.getObjectByName('far-ring'), null, { timeout: 60000 });
  const s = await page.evaluate(async () => {
    const src = (f) => new URL(f, document.querySelector('script[type=module][src]').src).href;
    const { GROUND_FX } = await import(src('ground-fx.js'));
    const l = window.__landnav;
    return { on: GROUND_FX.aerialBox.value.w, far: l.camera.far, fog: l.scene.fog.far };
  });
  assert.ok(s.on === 1 && s.far > 40000 && s.fog > 20000, JSON.stringify(s));
});

await check('a random course on the built site', async () => {
  await page.evaluate(async () => {
    const src = (f) => new URL(f, document.querySelector('script[type=module][src]').src).href;
    const { generateCourse } = await import(src('course-logic.js'));
    const l = window.__landnav;
    await l.startCourse(generateCourse(l.site, l.field, 7, { start: l.site.default_start }));
  });
  const n = await page.evaluate(() => window.__landnav.run.course.points.length);
  assert.ok(n >= 3);
});

await check('the browser keeps it: a reload builds nothing', async () => {
  const before = { ...counts };
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__landnav?.tools, null, { timeout: 60000 });
  assert.equal(counts.osm, before.osm);
  assert.equal(counts.wcs, before.wcs);
  assert.equal(await page.evaluate(() => window.__landnav.site.name), 'Test Hill');
});

await check('no page errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
