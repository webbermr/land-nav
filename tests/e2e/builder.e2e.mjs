// The site builder page (builder.html) in headless Chromium: place a square and a
// start, check the request it would send, and that update mode reads existing sites.
// Map tiles are fetched from USGS but not needed: the checks don't look at them.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

let pw;
try {
  pw = (await import('playwright')).default ?? (await import('playwright'));
} catch {
  pw = createRequire(import.meta.url)(execSync('npm root -g').toString().trim() + '/playwright');
}
const base = process.argv[2] || 'http://localhost:8080/';
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const check = (name, fn) => fn().then(() => console.log(`ok   ${name}`), (e) => { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; });

await page.goto(`${base}builder.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__builder && document.querySelector('#site-pick option'), null, { timeout: 30000 });

const clickAt = async (lat, lon) => {
  const box = await page.locator('#map').boundingBox();
  const p = await page.evaluate(([la, lo]) => window.__builder.map.latLngToContainerPoint([la, lo]), [lat, lon]);
  await page.mouse.click(box.x + p.x, box.y + p.y);
};

await check('new site: nothing to send until there is a square and a name', async () => {
  assert.equal(await page.isDisabled('#send'), true);
  const errs = await page.locator('#errors li').allTextContents();
  assert.ok(errs.some((t) => /Click the map/.test(t)), errs.join(' | '));
});

await check('new site: click places the square, the start goes inside it, the request is complete', async () => {
  await page.evaluate(() => window.__builder.map.setView([38.5512, -78.3155], 13));
  await clickAt(38.5512, -78.3155);
  await page.fill('#site-name', 'Old Rag Test');
  assert.equal(await page.inputValue('#site-id'), 'old-rag-test');
  await page.click('#place-start');
  await clickAt(38.5545, -78.3230);
  await page.fill('#start-name', 'Saddle');
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  const req = await page.evaluate(() => window.__builder.request);
  assert.equal(req.site.new, true);
  assert.ok(Math.abs(req.site.lat - 38.5512) < 0.001 && Math.abs(req.site.lon + 78.3155) < 0.001, JSON.stringify(req.site));
  assert.ok(Math.abs(req.site.start.lat - 38.5545) < 0.001, 'start where clicked');
  assert.equal(req.site.start.name, 'Saddle');
  assert.deepEqual(req.courses.map((c) => [c.id, c.night]), [['old-rag-test-1', false], ['old-rag-test-2', false], ['old-rag-test-night-1', true]]);
  assert.match(await page.textContent('#square-status'), /UTM zone 17N/);
  assert.match(await page.textContent('#cli'), /make_site\.py --fetch-dem --lat 38\.5512/);
});

await check('new site: Send opens a GitHub issue carrying the request', async () => {
  // Capture the link rather than follow it: signed out, GitHub redirects to its login.
  await page.evaluate(() => { window.open = (u) => { window.__opened = u; }; });
  await page.click('#send');
  const url = new URL(await page.evaluate(() => window.__opened));
  assert.equal(url.hostname, 'github.com');
  assert.equal(url.pathname, '/webbermr/land-nav/issues/new');
  assert.match(url.searchParams.get('title'), /^\[build\] New site: Old Rag Test/);
  const json = url.searchParams.get('body').match(/```json\s*(\{[\s\S]*?\})\s*```/)[1];
  assert.equal(JSON.parse(json).site.id, 'old-rag-test');
});

await check('new site: a square across a 100 km line or a start outside it is refused', async () => {
  await page.evaluate(() => window.__builder.map.setView([38.809, -78.2958], 13));
  await clickAt(38.7641 + 0.045, -78.2958);
  await page.waitForFunction(() => document.getElementById('send').disabled);
  assert.match((await page.locator('#errors li').allTextContents()).join(' '), /100 km/);
});

await check('update: picks an existing site, defaults to what it lacks, and names courses without clashes', async () => {
  await page.click('#tab-update');
  await page.selectOption('#site-pick', 'shenandoah-matthews-arm');
  const req = await page.evaluate(() => window.__builder.request);
  assert.deepEqual([req.site.id, req.site.new, req.landcover, req.roads], ['shenandoah-matthews-arm', false, false, false]);
  assert.deepEqual(req.courses.map((c) => c.name), ['Matthews Arm 4']);
  assert.ok(!(await page.isDisabled('#send')));
});

await check('no page errors', async () => assert.deepEqual(errors, []));
await browser.close();
