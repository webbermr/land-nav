// Browser check of the VR path with a fake headset (tests/e2e/xr-mock.js).
//   python3 -m http.server 8080 &
//   node tests/e2e/xr.e2e.mjs [http://localhost:8080/] [screenshot-dir]
// Needs Playwright with a Chromium build. Not part of `npm test`.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch {
  playwright = require(execSync('npm root -g').toString().trim() + '/playwright');
}
const base = process.argv[2] || 'http://localhost:8080/';
const shots = process.argv[3];
const mock = readFileSync(fileURLToPath(new URL('./xr-mock.js', import.meta.url)), 'utf8');

const browser = await playwright.chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(mock);
await page.goto(`${base}?debug`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__landnav, null, { timeout: 60000 });

const check = (name, fn) => fn().then(() => console.log(`ok   ${name}`), (e) => { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; });
const frames = (n) => page.evaluate((n) => new Promise((res) => {
  // Wait n XR frames (the XR loop runs off the session's rAF).
  let k = 0; const s = window.__xr.session || window;
  const tick = () => (++k >= n ? res() : s.requestAnimationFrame(tick));
  s.requestAnimationFrame(tick);
}), n);

await check('desktop walk follows the ground at eye height', async () => {
  await page.evaluate(() => window.__landnav.loco.pace.reset());
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__landnav.loco.pace.distance > 1, null, { timeout: 30000, polling: 100 });
  await page.keyboard.up('KeyW');
  const r = await page.evaluate(() => {
    const { camera, terrain } = window.__landnav;
    const p = camera.getWorldPosition(camera.position.clone());
    return { eye: p.y - terrain.heightAt(p.x, p.z) };
  });
  assert.ok(Math.abs(r.eye - 1.7) < 0.01, JSON.stringify(r));
});

await check('Enter VR button is offered', async () => {
  await page.waitForFunction(() => !document.getElementById('vr').disabled, null, { timeout: 10000 });
  assert.equal(await page.textContent('#vr'), 'Enter VR');
});

await page.click('#vr');
await page.waitForFunction(() => window.__landnav.renderer.xr.isPresenting, null, { timeout: 10000 });
await frames(5);

await check('stands on the terrain at the headset height', async () => {
  const r = await page.evaluate(() => {
    const { camera, terrain } = window.__landnav;
    const p = camera.getWorldPosition(camera.position.clone());
    return { eye: p.y, ground: terrain.heightAt(p.x, p.z) };
  });
  assert.ok(Math.abs(r.eye - r.ground - 1.6) < 0.02, JSON.stringify(r));
});

await check('controllers connected', async () => {
  const n = await page.evaluate(() => window.__landnav.player.children.filter((c) => c.userData.handedness).length);
  assert.equal(n, 2);
});

await check('left stick walks forward (grid north); left pulses match the pace count', async () => {
  await page.evaluate(() => {
    const s = window.__landnav.settings;
    s.slopeEffects = false; s.timeScale = 3;
    window.__landnav.loco.pace.reset();
    window.__xr.pulses.length = 0;
  });
  const before = await page.evaluate(() => ({ ...window.__landnav.player.position }));
  await page.evaluate(() => { window.__xr.axes.left = [0, 0, 0, -1]; });
  await page.waitForFunction(() => window.__landnav.loco.pace.distance >= 40, null, { timeout: 120000, polling: 100 });
  const vignetteWhileMoving = await page.evaluate(() => window.__landnav.camera.getObjectByName('vignette').visible);
  await page.evaluate(() => { window.__xr.axes.left = [0, 0, 0, 0]; });
  await frames(40);
  const vignetteStopped = await page.evaluate(() => window.__landnav.camera.getObjectByName('vignette').visible);
  assert.ok(vignetteWhileMoving, 'vignette shows while moving');
  assert.ok(!vignetteStopped, 'vignette clears after stopping');
  const r = await page.evaluate((b) => {
    const { player, loco } = window.__landnav;
    return {
      dx: player.position.x - b.x, dz: player.position.z - b.z,
      dist: loco.pace.distance, paces: loco.pace.leftCount,
      pulses: window.__xr.pulses.filter((p) => p.hand === 'left').length,
      right: window.__xr.pulses.filter((p) => p.hand === 'right').length,
    };
  }, before);
  console.log(`     walked ${r.dist.toFixed(2)} m, ${r.pulses} left pulses, expected ${(r.dist * 0.65).toFixed(2)}`);
  assert.ok(r.dz < -39 && Math.abs(r.dx) < 0.01, `moved north: ${JSON.stringify(r)}`);
  assert.equal(r.pulses, r.paces);
  assert.equal(r.pulses, Math.floor(r.dist * 0.65 + 1e-6));
  assert.equal(r.right, 0, 'no haptics on the right hand');
});

await check('stick direction follows the head: facing west walks west', async () => {
  await page.evaluate(() => { window.__xr.head.yaw = Math.PI / 2; });
  await frames(2);
  const b = await page.evaluate(() => ({ ...window.__landnav.player.position }));
  await page.evaluate(() => { window.__xr.axes.left = [0, 0, 0, -1]; });
  await page.waitForFunction((bx) => window.__landnav.player.position.x < bx - 3, b.x, { timeout: 60000, polling: 100 });
  await page.evaluate(() => { window.__xr.axes.left = [0, 0, 0, 0]; });
  const a = await page.evaluate(() => ({ ...window.__landnav.player.position }));
  assert.ok(Math.abs(a.z - b.z) < 0.05, `z drift ${a.z - b.z}`);
  await page.evaluate(() => { window.__xr.head.yaw = 0; });
});

await check('stick deadzone ignores drift', async () => {
  const b = await page.evaluate(() => ({ ...window.__landnav.player.position }));
  await page.evaluate(() => { window.__xr.axes.left = [0, 0, 0.08, -0.1]; });
  await frames(10);
  await page.evaluate(() => { window.__xr.axes.left = [0, 0, 0, 0]; });
  const a = await page.evaluate(() => ({ ...window.__landnav.player.position }));
  assert.equal(a.x, b.x); assert.equal(a.z, b.z);
});

await check('snap turn is off by default, 30 degrees when enabled', async () => {
  const yaw0 = await page.evaluate(() => window.__landnav.player.rotation.y);
  await page.evaluate(() => { window.__xr.axes.right = [0, 0, 1, 0]; });
  await frames(4);
  await page.evaluate(() => { window.__xr.axes.right = [0, 0, 0, 0]; });
  await frames(2);
  assert.equal(await page.evaluate(() => window.__landnav.player.rotation.y), yaw0);
  await page.evaluate(() => { window.__landnav.settings.snapTurn = true; window.__xr.axes.right = [0, 0, 1, 0]; });
  await frames(6); // held: must turn once, not every frame
  await page.evaluate(() => { window.__xr.axes.right = [0, 0, 0, 0]; window.__landnav.settings.snapTurn = false; });
  await frames(2);
  const turned = await page.evaluate(() => window.__landnav.player.rotation.y) - yaw0;
  assert.ok(Math.abs(turned + Math.PI / 6) < 1e-6, `turned ${turned}`);
});

await check('physical walking cannot leave the playable area', async () => {
  // Teleport near the west edge, then step 5 m west in the room.
  await page.evaluate(() => {
    const { player } = window.__landnav;
    player.rotation.y = 0; player.position.x = 2; window.__xr.head.x = 0;
  });
  await frames(2);
  await page.evaluate(() => { window.__xr.head.x = -5; });
  await frames(3);
  const r = await page.evaluate(() => {
    const { camera } = window.__landnav;
    return camera.getWorldPosition(camera.position.clone()).x;
  });
  assert.ok(r > -0.01, `head x ${r}`);
  await page.evaluate(() => { window.__xr.head.x = 0; });
});

if (shots) {
  await page.evaluate(() => { window.__landnav.player.position.set(1000, 0, 1400); window.__xr.head.yaw = 0.4; });
  await frames(3);
  await page.screenshot({ path: `${shots}/xr.png` });
}

await check('Exit VR returns to desktop on the ground', async () => {
  await page.evaluate(() => window.__xr.session.end());
  await page.waitForFunction(() => !window.__landnav.renderer.xr.isPresenting, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const { player, terrain, camera } = window.__landnav;
    return { y: player.position.y, g: terrain.heightAt(player.position.x, player.position.z), cy: camera.position.y, btn: document.getElementById('vr').textContent };
  });
  assert.ok(Math.abs(r.y - r.g) < 1e-6);
  assert.equal(r.cy, 1.7);
  assert.equal(r.btn, 'Enter VR');
});

await check('no page errors', async () => assert.deepEqual(errors, []));
await browser.close();
