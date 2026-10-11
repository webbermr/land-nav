// Browser check of the VR path with a fake headset (tests/e2e/xr-mock.js).
//   python3 -m http.server 8080 &
//   node tests/e2e/xr.e2e.mjs [http://localhost:8080/] [screenshot-dir]
// Set E2E_CPU_THROTTLE=4 to simulate a slow machine.
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
// E2E_CPU_THROTTLE=4 slows the page's CPU, to reproduce timing bugs seen on slow CI runners.
if (process.env.E2E_CPU_THROTTLE) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.E2E_CPU_THROTTLE) });
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.addInitScript(mock);
const BEACON = { x: 1150, z: 880 };
await page.goto(`${base}?site=demo-synthetic&debug&beacon=${BEACON.x},${BEACON.z}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__landnav?.tools, null, { timeout: 60000 });
await page.evaluate(() => { document.getElementById('help').hidden = true; });
// Walking checks measure exact distances, so trees mustn't get in the way. The
// collision checks switch it back on.
await page.evaluate(() => { window.__landnav.settings.collisions = false; });

// In-page helpers for aiming controllers and finding points on the map board.
await page.evaluate(async () => {
  const THREE = await import('three');
  // App modules live next to main.js (src/ locally, v/<commit>/src/ on Pages).
  const src = (f) => new URL(f, document.querySelector('script[type=module][src]').src).href;
  const { gridAzimuth, gridToMagnetic } = await import(src('coords.js'));
  const L = () => window.__landnav;
  window.__t = {
    // Point a controller space (hand 'left'|'right', kind 'ray'|'grip') from eye toward target, world coords.
    aim(hand, kind, eye, target) {
      const { player } = L();
      player.updateMatrixWorld(true);
      const e = player.worldToLocal(new THREE.Vector3(...eye));
      const t = player.worldToLocal(new THREE.Vector3(...target));
      const m = new THREE.Matrix4().lookAt(e, t, new THREE.Vector3(0, 1, 0));
      m.setPosition(e);
      window.__xr.pose[hand][kind] = new Float32Array(m.elements);
    },
    eye() { return L().camera.getWorldPosition(new THREE.Vector3()).toArray(); },
    // Magnetic azimuth of a horizontal world direction.
    magOf(dx, dz) { return gridToMagnetic(gridAzimuth(dx, dz), L().site.gm_angle_deg); },
    // World point and normal on the map paper for a scene position.
    onBoard(x, z) {
      const { tools } = L();
      const b = tools.map.boardOf({ x, z });
      tools.map.paper.updateMatrixWorld(true);
      const w = tools.map.paper.localToWorld(new THREE.Vector3(b.bx, b.by, 0));
      const n = new THREE.Vector3(0, 0, 1).transformDirection(tools.map.paper.matrixWorld);
      return { w: w.toArray(), n: n.toArray(), b };
    },
    // Page pixel of a scene position on the desktop map board.
    screenOf(x, z) {
      const { camera, renderer } = L();
      camera.updateMatrixWorld(true);
      const v = new THREE.Vector3(...window.__t.onBoard(x, z).w).project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    angleDiff(a, b) { const d = ((b - a) % 360 + 540) % 360 - 180; return Math.abs(d); },
    async course(spec) {
      const { generateCourse } = await import(src('course-logic.js'));
      const l = L();
      const c = typeof spec === 'string'
        ? await (await fetch(`sites/demo-synthetic/courses/${spec}.json`)).json()
        : generateCourse(l.site, l.field, spec.seed, spec.opts);
      await l.startCourse(c);
      return c;
    },
    // Put the player (desktop) or the head (VR) at a scene position.
    // A tree trunk near (x, z) with nothing else within 5 m of it, to walk into.
    clearTrunk(x, z) {
      const obs = L().vegetation.obstaclesNear(x, z, 40);
      const mid = (p) => (p.type === 'capsule' ? { x: (p.ax + p.bx) / 2, z: (p.az + p.bz) / 2 } : p);
      return obs.find((o) => o.type === 'circle' && o.r > 0.2 && obs.every((p) => p === o
        || Math.hypot(mid(p).x - o.x, mid(p).z - o.z) > (p.type === 'capsule' ? 8.5 : 5)));
    },
    goTo(x, z) {
      const { player, camera, renderer, terrain } = L();
      if (renderer.xr.isPresenting) {
        const h = camera.getWorldPosition(new THREE.Vector3());
        player.position.x += x - h.x;
        player.position.z += z - h.z;
      } else {
        player.position.set(x, terrain.heightAt(x, z), z);
      }
    },

  };
});

const check = (name, fn) => fn().then(() => console.log(`ok   ${name}`), (e) => { console.log(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; });
// The HUD is redrawn each frame, so wait for a message rather than reading it at once.
const hudSays = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('hud').textContent), re.source, { timeout: 15000, polling: 50 })
  .catch(async () => assert.fail(`HUD never said ${re}: ${await page.textContent('#hud')}`));
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

await check('M2 desktop: compass reads the beacon within 1 degree of the computed magnetic azimuth', async () => {
  await page.evaluate(({ x, z }) => {
    const { input, player } = window.__landnav;
    input.yaw = Math.atan2(-(x - player.position.x), -(z - player.position.z));
    input.pitch = -0.3;
  }, BEACON);
  await page.keyboard.press('KeyC');
  try {
  // Wait for the dial to settle (frame time, which can be slow headless).
  await page.waitForFunction(() => {
    const c = window.__landnav.tools.compass;
    return c.dialReading !== null && c.heading.magnetic !== null && Math.abs(c.damper.velocity) < 0.05
      && window.__t.angleDiff(c.dialReading, c.heading.magnetic) < 0.05;
  }, null, { timeout: 60000, polling: 100 });
  const r = await page.evaluate(({ x, z }) => {
    const { tools, player } = window.__landnav;
    return { dial: tools.compass.dialReading, expected: window.__t.magOf(x - player.position.x, z - player.position.z) };
  }, BEACON);
  console.log(`     dial ${r.dial.toFixed(2)}, beacon ${r.expected.toFixed(2)}`);
  assert.ok(await page.evaluate(([a, b]) => window.__t.angleDiff(a, b), [r.dial, r.expected]) <= 1);
  // Bezel turns in 3 degree clicks on the wheel.
  await page.mouse.move(640, 300);
  await page.mouse.wheel(0, 100);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__landnav.tools.compass.bezelDeg), 3);
  } finally {
    // Always put the compass away and face grid north again, so a failure here
    // doesn't cascade (entering VR keeps the desktop heading).
    await page.keyboard.press('KeyC');
    await page.evaluate(() => { window.__landnav.input.pitch = 0; window.__landnav.input.yaw = 0; });
  }
});

await check('M2 desktop: map dots, line, protractor, erase and zoom', async () => {
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(500);
  try {
  const A = { x: 900, z: 1100 }, B = { x: 1300, z: 700 };
  const click = async (pt, button = 'left') => {
    const s = await page.evaluate(({ x, z }) => window.__t.screenOf(x, z), pt);
    await page.mouse.move(s.x, s.y);
    await page.waitForTimeout(250); // let a frame update the hover
    await page.mouse.click(s.x, s.y, { button });
    await page.waitForTimeout(150);
  };
  await click(A); await click(B);
  let st = await page.evaluate(() => { const m = window.__landnav.tools.map; return { dots: m.dots.map((d) => [d.x, d.z]), lines: m.lines.length }; });
  assert.equal(st.dots.length, 2);
  // One screen pixel is about 4 m of ground at this zoom.
  assert.ok(Math.hypot(st.dots[0][0] - A.x, st.dots[0][1] - A.z) < 8, `dot A at ${st.dots[0]}`);
  await click(A); await click(B);
  const m = await page.evaluate(() => { const map = window.__landnav.tools.map; return { lines: map.lines.length, meas: map.measure(map.lastLine) }; });
  assert.equal(m.lines, 1);
  assert.ok(Math.abs(m.meas.grid - 45) < 1.5, `line az ${m.meas.grid}`);
  assert.ok(Math.abs(m.meas.distance - Math.hypot(400, 400)) < 12, `line length ${m.meas.distance}`);
  await click(A, 'right');
  assert.ok(await page.evaluate(() => window.__landnav.tools.map.protractor.visible), 'protractor shown');
  // Zoom toward A keeps A under the cursor.
  const before = await page.evaluate(({ x, z }) => window.__t.screenOf(x, z), A);
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(80); }
  const after = await page.evaluate(({ x, z }) => window.__t.screenOf(x, z), A);
  assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 2, `A moved ${after.x - before.x},${after.y - before.y}`);
  assert.ok(await page.evaluate(() => window.__landnav.tools.mapDistance < 0.3));
  // Erase B with the cursor over it.
  const sb = await page.evaluate(({ x, z }) => window.__t.screenOf(x, z), B);
  await page.mouse.move(sb.x, sb.y);
  await page.waitForTimeout(250);
  await page.keyboard.press('Delete');
  st = await page.evaluate(() => { const map = window.__landnav.tools.map; return { dots: map.dots.length, lines: map.lines.length }; });
  assert.deepEqual(st, { dots: 1, lines: 0 });
  // With the compass out too, the desktop pencil still works, and every click says what it did.
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(300);
  await click({ x: 1500, z: 1500 });
  assert.equal(await page.evaluate(() => window.__landnav.tools.map.dots.length), 2, 'dot placed with the compass out');
  await hudSays(/Dot placed/);
  await page.keyboard.press('KeyC');
  } finally {
    if (await page.evaluate(() => window.__landnav.tools.desktopCompass)) await page.keyboard.press('KeyC');
    if (await page.evaluate(() => window.__landnav.tools.desktopMap)) await page.keyboard.press('KeyM');
    await page.evaluate(() => window.__landnav.tools.map.clear());
  }
});

await check('M3 desktop: course at the start; punch, beads, card, rows; end and score', async () => {
  const c = await page.evaluate(() => window.__t.course('day-1'));
  let st = await page.evaluate(() => {
    const { run, player, wrist } = window.__landnav;
    return { state: run.state, x: player.position.x, z: player.position.z, card: wrist.card.mesh.visible, beads: wrist.beads.group.visible, grids: run.grids };
  });
  assert.equal(st.state, 'ready');
  assert.deepEqual([st.x, st.z], [c.start.x, c.start.z]);
  assert.ok(st.card && st.beads, 'card and beads shown');
  const { eightDigitGrid } = await import('../../src/coords.js');
  const site = await page.evaluate(() => window.__landnav.site);
  assert.equal(st.grids.points[0], eightDigitGrid(site, c.points[0].x, c.points[0].z));
  // The clock starts on the first step.
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__landnav.run.state === 'running', null, { timeout: 30000, polling: 50 });
  await page.keyboard.up('KeyW');
  // Flying is off during a course.
  await page.keyboard.press('KeyV');
  await hudSays(/Flying is off/);
  const punchAt = async (p, dx = 0.8) => {
    await page.evaluate(([x, z]) => window.__t.goTo(x, z), [p.x + dx, p.z]);
    await page.keyboard.press('KeyE');
  };
  await punchAt(c.points[0]);
  await punchAt(c.decoys[0]);
  await punchAt(c.points[2]);
  st = await page.evaluate(() => ({ entries: window.__landnav.run.entries, row: window.__landnav.run.row }));
  assert.deepEqual(st.entries, [c.points[0].code, c.decoys[0].code, c.points[2].code, null]);
  assert.equal(st.row, 3);
  await punchAt({ x: c.points[1].x + 40, z: c.points[1].z });
  await hudSays(/No stake within 2 m/);
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => window.__landnav.run.row), 2);
  // Beads: 12 slides = 1 km + 200 m; Shift+Space resets.
  for (let i = 0; i < 12; i++) await page.keyboard.press('Space');
  assert.deepEqual(await page.evaluate(() => [window.__landnav.run.beads.upper, window.__landnav.run.beads.lower]), [1, 2]);
  await page.keyboard.down('ShiftLeft'); await page.keyboard.press('Space'); await page.keyboard.up('ShiftLeft');
  assert.equal(await page.evaluate(() => window.__landnav.run.beads.metres), 0);
  // Tab hides and shows the card.
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => window.__landnav.wrist.card.mesh.visible), false);
  await page.keyboard.press('Tab');
  // Back at the start, Enter twice ends it: 2 of 4 right, threshold 3, so a fail.
  await page.evaluate(([x, z]) => window.__t.goTo(x + 3, z), [c.start.x, c.start.z]);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__landnav.run.state), 'running', 'one Enter only asks');
  await page.keyboard.press('Enter');
  const r = await page.evaluate(() => window.__landnav.run.result);
  assert.equal(r.correct, 2);
  assert.equal(r.total, 4);
  assert.ok(r.endedAtStart && r.timeOk && !r.pass);
  assert.deepEqual(r.rows.map((x) => x.correct), [true, false, true, false]);
  await page.keyboard.press('KeyE');
  await hudSays(/course is over/);
});

await check('M4 desktop: the review opens at the end, analyses each leg, downloads JSON, and closes', async () => {
  await page.waitForFunction(() => !document.getElementById('review').hidden, null, { timeout: 5000 });
  const a = await page.evaluate(async () => {
    const src = (f) => new URL(f, document.querySelector('script[type=module][src]').src).href;
    const { analyzeRun } = await import(src('aar-logic.js'));
    const l = window.__landnav;
    const stored = JSON.parse(localStorage.getItem('landnav.lastrun.v1'));
    const an = analyzeRun(l.lastRun, l.site);
    const c = document.querySelector('#review canvas');
    // The board has drawn something other than background.
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < px.length; i += 4 * 97) if (px[i] < 120) ink++;
    return { legs: an.legs.length, correct: an.legs.map((x) => x.correct), stored: stored?.course.id, size: [c.width, c.height], ink, track: l.lastRun.log.track.length };
  });
  assert.equal(a.legs, 5, 'four points and the way back');
  assert.deepEqual(a.correct, [true, false, true, false, null]);
  assert.equal(a.stored, 'day-1');
  assert.deepEqual(a.size, [2400, 1400]);
  assert.ok(a.ink > 500, `ink ${a.ink}`);
  assert.ok(a.track > 1);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#review-download')]);
  const json = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
  assert.equal(json.format, 'land-nav-run');
  assert.match(download.suggestedFilename(), /^land-nav-day-1-.*\.json$/);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.getElementById('review').hidden), true);
});

await check('M3 desktop: the clock runs out; a generated course from a seed', async () => {
  const c = await page.evaluate(async () => {
    const c = await window.__t.course({ seed: 4242 });
    window.__landnav.run.course.time_limit_min = 0.005; // 0.3 s
    return c;
  });
  assert.equal(c.id, 'gen-4242');
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__landnav.run.state === 'ended', null, { timeout: 30000, polling: 50 });
  await page.keyboard.up('KeyW');
  const r = await page.evaluate(() => window.__landnav.run.result);
  assert.equal(r.reason, 'time');
  assert.ok(!r.pass);
  await hudSays(/Time is up/);
  assert.equal(await page.evaluate(() => document.getElementById('review').hidden), false, 'review opens on time-out too');
  await page.click('#review-close');
});

await check('Lost lifeline (desktop): K shows a brief, counted "you are here"; can be switched off', async () => {
  const c = await page.evaluate(() => window.__t.course('day-2'));
  await page.evaluate(([x, z]) => {
    window.__t.goTo(x, z);
    const l = window.__landnav;
    l.input.yaw = -Math.PI / 2; // facing grid east
    l.settings.lostHelpSec = 1.5;
  }, [c.start.x + 120, c.start.z - 40]);
  await page.keyboard.press('KeyK');
  await hudSays(/You are here.*Used 1 time/);
  const r = await page.evaluate(() => {
    const { tools, run, player } = window.__landnav;
    const here = tools.map.here;
    const b = tools.map.boardOf({ x: player.position.x, z: player.position.z });
    return { map: tools.desktopMap, v: here.visible, dx: here.position.x - b.bx, dy: here.position.y - b.by, rot: here.rotation.z, reveals: run.reveals, ev: run.log.events.filter((e) => e.type === 'reveal').length };
  });
  assert.ok(r.map && r.v, 'map opened with the mark');
  assert.ok(Math.hypot(r.dx, r.dy) < 1e-9, 'mark at the true position');
  assert.ok(Math.abs(r.rot + Math.PI / 2) < 1e-6, `arrow points east, rot ${r.rot}`);
  assert.equal(r.reveals, 1);
  assert.equal(r.ev, 1, 'logged for the AAR');
  await page.waitForFunction(() => !window.__landnav.tools.map.here.visible, null, { timeout: 30000, polling: 50 });
  await page.evaluate(() => { window.__landnav.settings.lostHelp = false; });
  await page.keyboard.press('KeyK');
  await hudSays(/switched off in Settings/);
  assert.equal(await page.evaluate(() => window.__landnav.run.reveals), 1);
  // It shows on the result.
  await page.evaluate(() => { window.__landnav.settings.lostHelp = true; window.__landnav.settings.lostHelpSec = 15; });
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.__landnav.run.result.reveals), 1);
  await page.keyboard.press('KeyM');
  // Face grid north again: entering VR keeps the desktop heading.
  await page.evaluate(() => { window.__landnav.input.yaw = 0; });
});

await check('Trees: drawn around you, never on a stake, and the quality setting turns them off', async () => {
  const c = await page.evaluate(() => window.__t.course('day-1'));
  await page.evaluate(() => { window.__landnav.settings.preset = 'woods'; window.__landnav.vegetation.setPreset('woods'); });
  await frames(3);
  const r = await page.evaluate(([pts]) => {
    const v = window.__landnav.vegetation;
    v.update(pts[0].x + 0.01, pts[0].z); // force a refresh at the start
    const near = [];
    for (const t of v.treeCache.values()) for (const tree of t) for (const p of pts) {
      if (Math.hypot(tree.x - p.x, tree.z - p.z) < 4) near.push([tree.x, tree.z]);
    }
    return { stats: v.stats, near };
  }, [[c.start, ...c.points, ...c.decoys]]);
  assert.ok(r.stats.near > 50 && r.stats.cut > 100, JSON.stringify(r.stats));
  assert.deepEqual(r.near, [], 'no trees within 4 m of a stake');
  const off = await page.evaluate(() => {
    const l = window.__landnav;
    l.settings.vegetation = 'off';
    l.vegetation.update(l.player.position.x + 20, l.player.position.z);
    const s = l.vegetation.stats;
    l.settings.vegetation = 'medium';
    return s;
  });
  assert.deepEqual(off, { near: 0, cut: 0, clutter: 0 });
  await page.evaluate(() => { const l = window.__landnav; l.settings.preset = 'open'; l.vegetation.setPreset('open'); l.run.end(l.run.course.start); });
});

await check('Collision: a trunk stops you, only distance walked counts, and it can be switched off', async () => {
  const { tree, p } = await page.evaluate(() => {
    const l = window.__landnav;
    l.settings.preset = 'woods'; l.vegetation.setPreset('woods');
    const p = { x: l.player.position.x, z: l.player.position.z };
    const tree = window.__t.clearTrunk(p.x, p.z);
    if (tree) {
      window.__t.goTo(tree.x, tree.z + 3);
      l.input.yaw = 0; l.input.pitch = 0; // facing grid north (-z), straight at it
      l.loco.pace.reset();
      l.settings.collisions = true;
    }
    return { tree, p };
  });
  assert.ok(tree, 'found a trunk to walk into');
  try {
    const stop = tree.z + tree.r + 0.25;
    await page.keyboard.down('KeyW');
    await page.waitForFunction((stop) => window.__landnav.player.position.z < stop + 0.01, stop, { timeout: 30000, polling: 50 });
    await page.waitForTimeout(800); // keep pushing into it
    await page.keyboard.up('KeyW');
    const r = await page.evaluate(() => ({ z: window.__landnav.player.position.z, d: window.__landnav.loco.pace.distance }));
    assert.ok(Math.abs(r.z - stop) < 0.02, `stopped at ${r.z}, trunk face ${stop}`);
    assert.ok(r.d < 3 - tree.r - 0.25 + 0.02, `paced ${r.d} m`);
    // Off: straight through.
    await page.evaluate(() => { window.__landnav.settings.collisions = false; });
    await page.keyboard.down('KeyW');
    await page.waitForFunction((z) => window.__landnav.player.position.z < z - 1, tree.z, { timeout: 30000, polling: 50 });
  } finally {
    await page.keyboard.up('KeyW');
    await page.evaluate((p) => {
      const l = window.__landnav;
      l.settings.collisions = false; l.settings.preset = 'open'; l.vegetation.setPreset('open');
      window.__t.goTo(p.x, p.z);
    }, p);
  }
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

await check('M2 VR: compass in the right hand reads the beacon within 1 degree', async () => {
  await page.evaluate(({ x, z }) => {
    const e = window.__t.eye();
    const d = Math.hypot(x - e[0], z - e[2]);
    window.__t.aim('right', 'ray', [e[0], e[1] - 0.3, e[2]], [e[0] + (x - e[0]) / d, e[1] - 0.3, e[2] + (z - e[2]) / d]);
    window.__xr.buttons.right[1] = true;
  }, BEACON);
  await frames(40);
  const r = await page.evaluate(({ x, z }) => {
    const { tools } = window.__landnav;
    const p = tools.compass.group.getWorldPosition(tools.compass.group.position.clone());
    return {
      visible: tools.compass.group.visible, body: tools.hands.right.body?.visible,
      dial: tools.compass.dialReading, beacon: window.__t.magOf(x - p.x, z - p.z), tilt: tools.compass.heading.tilt,
    };
  }, BEACON);
  console.log(`     dial ${r.dial.toFixed(2)}, beacon ${r.beacon.toFixed(2)}, tilt ${r.tilt.toFixed(1)}`);
  assert.ok(r.visible && r.body === false, 'compass replaces the controller model');
  assert.ok(await page.evaluate(([a, b]) => window.__t.angleDiff(a, b), [r.dial, r.beacon]) <= 1);
});

await check('M2 VR: tilted past 15 degrees the dial sticks, and frees when level', async () => {
  const level = await page.evaluate(() => window.__landnav.tools.compass.dialReading);
  // Pitch the compass up 30 degrees and swing it 40 degrees right.
  await page.evaluate(() => {
    const e = window.__t.eye();
    const a = Math.PI / 4.5;
    window.__t.aim('right', 'ray', [e[0], e[1] - 0.3, e[2]], [e[0] + Math.sin(a), e[1] - 0.3 + Math.tan(Math.PI / 6), e[2] - Math.cos(a)]);
  });
  await frames(30);
  const stuck = await page.evaluate(() => ({ dial: window.__landnav.tools.compass.dialReading, stuck: window.__landnav.tools.compass.stuck }));
  assert.ok(stuck.stuck, 'reports stuck');
  assert.ok(await page.evaluate(([a, b]) => window.__t.angleDiff(a, b), [stuck.dial, level]) < 0.5, `dial moved to ${stuck.dial}`);
  await page.evaluate(() => {
    const e = window.__t.eye();
    window.__t.aim('right', 'ray', [e[0], e[1] - 0.3, e[2]], [e[0] + 1, e[1] - 0.3, e[2]]);
  });
  await frames(40);
  const free = await page.evaluate(() => window.__landnav.tools.compass.dialReading);
  const east = await page.evaluate(() => window.__t.magOf(1, 0));
  assert.ok(await page.evaluate(([a, b]) => window.__t.angleDiff(a, b), [free, east]) <= 1, `level again reads ${free}, want ${east}`);
});

await check('M2 VR: right stick clicks the bezel while the compass is held (and does not snap turn)', async () => {
  const b0 = await page.evaluate(() => window.__landnav.tools.compass.bezelDeg);
  const yaw0 = await page.evaluate(() => window.__landnav.player.rotation.y);
  await page.evaluate(() => { window.__landnav.settings.snapTurn = true; window.__xr.axes.right = [0, 0, 1, 0]; });
  await frames(2);
  const first = await page.evaluate(() => window.__landnav.tools.compass.bezelDeg) - b0;
  // Holding repeats after a pause (frame time, which is slow headless): wait for it.
  await page.waitForFunction((b) => window.__landnav.tools.compass.bezelDeg - b > 3, b0, { timeout: 30000, polling: 50 });
  const held = await page.evaluate(() => window.__landnav.tools.compass.bezelDeg) - b0;
  await page.evaluate(() => { window.__xr.axes.right = [0, 0, 0, 0]; window.__landnav.settings.snapTurn = false; });
  await frames(2);
  assert.equal(first, 3);
  assert.ok(held > 3 && held % 3 === 0, `held ${held}`);
  assert.equal(await page.evaluate(() => window.__landnav.player.rotation.y), yaw0);
  await page.evaluate(() => { window.__xr.buttons.right[1] = false; });
  await frames(2);
  assert.equal(await page.evaluate(() => window.__landnav.tools.compass.group.visible), false);
});

await check('M2 VR: map in the left hand; pencil dots, line, protractor, long-press erase', async () => {
  await page.evaluate(() => { window.__landnav.tools.map.clear(); window.__xr.buttons.left[1] = true; });
  await frames(3);
  assert.ok(await page.evaluate(() => window.__landnav.tools.map.group.visible), 'map shown');
  const A = { x: 700, z: 1300 }, B = { x: 1100, z: 900 };
  const aimAt = (pt) => page.evaluate(({ x, z }) => {
    const { w, n } = window.__t.onBoard(x, z);
    window.__t.aim('right', 'ray', [w[0] + n[0] * 0.15, w[1] + n[1] * 0.15, w[2] + n[2] * 0.15], w);
  }, pt);
  const tap = async (pt, button = 0) => {
    await aimAt(pt); await frames(2);
    // One frame only: the headless renderer is slow enough that two frames can pass
    // the long-press (erase) threshold.
    await page.evaluate((b) => { window.__xr.buttons.right[b] = true; }, button); await frames(1);
    await page.evaluate((b) => { window.__xr.buttons.right[b] = false; }, button); await frames(2);
  };
  await tap(A); await tap(B);
  let dots = await page.evaluate(() => window.__landnav.tools.map.dots.map((d) => [d.x, d.z]));
  assert.equal(dots.length, 2);
  assert.ok(Math.hypot(dots[0][0] - A.x, dots[0][1] - A.z) < 1 && Math.hypot(dots[1][0] - B.x, dots[1][1] - B.z) < 1, JSON.stringify(dots));
  await tap(A); await tap(B);
  const m = await page.evaluate(() => { const map = window.__landnav.tools.map; return { lines: map.lines.length, meas: map.measure(map.lastLine) }; });
  assert.equal(m.lines, 1);
  assert.ok(Math.abs(m.meas.grid - 45) < 0.2, `line az ${m.meas.grid}`);
  await tap(A, 5);
  const prot = await page.evaluate(() => { const map = window.__landnav.tools.map; return { v: map.protractor.visible, p: map.protractor.position.toArray(), a: map.boardOf(map.dots[0]) }; });
  assert.ok(prot.v && Math.hypot(prot.p[0] - prot.a.bx, prot.p[1] - prot.a.by) < 1e-6, 'protractor centred on A');
  // Pencil is off while the compass is out.
  await page.evaluate(() => { window.__xr.buttons.right[1] = true; });
  await tap({ x: 1500, z: 1500 });
  assert.equal(await page.evaluate(() => window.__landnav.tools.map.dots.length), 2);
  await page.evaluate(() => { window.__xr.buttons.right[1] = false; });
  // Long press on B erases it and its line.
  await aimAt(B); await frames(2);
  // Hold until the app erases (frame time can be slower than wall time headless), then
  // check it did so while the trigger was still down.
  await page.evaluate(() => { window.__xr.buttons.right[0] = true; });
  await frames(1);
  await page.waitForFunction(() => window.__landnav.tools.map.dots.length === 1, null, { timeout: 30000, polling: 50 });
  await page.evaluate(() => { window.__xr.buttons.right[0] = false; }); await frames(2);
  const st = await page.evaluate(() => { const map = window.__landnav.tools.map; return { dots: map.dots.length, lines: map.lines.length }; });
  assert.deepEqual(st, { dots: 1, lines: 0 }, `after long press: ${JSON.stringify(st)}`);
  await page.evaluate(() => { window.__xr.buttons.left[1] = false; window.__xr.pose = { left: {}, right: {} }; });
  await frames(2);
  assert.equal(await page.evaluate(() => window.__landnav.tools.map.group.visible), false);
});

await check('M3 VR: course on the wrist; X card, A beads (hold resets), trigger punches, hold Y ends', async () => {
  const c = await page.evaluate(() => window.__t.course({ seed: 99 }));
  await frames(3);
  let st = await page.evaluate(() => {
    const { camera, run, wrist } = window.__landnav;
    const h = camera.getWorldPosition(camera.position.clone());
    return { hx: h.x, hz: h.z, sx: run.course.start.x, sz: run.course.start.z, cardParent: wrist.card.mesh.parent?.userData.handedness, card: wrist.card.mesh.visible };
  });
  assert.ok(Math.hypot(st.hx - st.sx, st.hz - st.sz) < 0.05, 'head over the start');
  assert.equal(st.cardParent, 'left');
  assert.ok(st.card);
  const press = async (hand, b, n = 1) => {
    await page.evaluate(([h, i]) => { window.__xr.buttons[h][i] = true; }, [hand, b]); await frames(n);
    await page.evaluate(([h, i]) => { window.__xr.buttons[h][i] = false; }, [hand, b]); await frames(2);
  };
  await press('left', 4); // X hides the card
  assert.equal(await page.evaluate(() => window.__landnav.wrist.card.mesh.visible), false);
  await press('left', 4);
  await press('right', 4); await press('right', 4);
  assert.equal(await page.evaluate(() => window.__landnav.run.beads.metres), 200);
  await page.evaluate(() => { window.__xr.buttons.right[4] = true; });
  await page.waitForFunction(() => window.__landnav.run.beads.metres === 0, null, { timeout: 30000, polling: 50 });
  await page.evaluate(() => { window.__xr.buttons.right[4] = false; }); await frames(2);
  // Walk the head to point 1 and punch with the trigger.
  await page.evaluate(([x, z]) => window.__t.goTo(x, z), [c.points[0].x + 1, c.points[0].z]);
  await frames(2);
  await press('right', 0);
  assert.deepEqual(await page.evaluate(() => window.__landnav.run.entries), [c.points[0].code, null, null, null]);
  // Y taps move the row; holding Y ends the course.
  await press('left', 5);
  assert.equal(await page.evaluate(() => window.__landnav.run.row), 2);
  await page.evaluate(([x, z]) => window.__t.goTo(x, z), [c.start.x, c.start.z + 2]);
  await frames(2);
  await page.evaluate(() => { window.__xr.buttons.left[5] = true; });
  await page.waitForFunction(() => window.__landnav.run.state === 'ended', null, { timeout: 30000, polling: 50 });
  await page.evaluate(() => { window.__xr.buttons.left[5] = false; }); await frames(2);
  const r = await page.evaluate(() => window.__landnav.run.result);
  assert.equal(r.correct, 1);
  assert.ok(r.endedAtStart);
  assert.ok(await page.evaluate(() => window.__xr.pulses.some((p) => p.hand === 'right' && p.ms === 80)), 'punch haptic');
});

await check('M4 VR: the review table appears in front of you; B hides and shows it', async () => {
  const at = () => page.evaluate(() => {
    const { reviewBoard, camera } = window.__landnav;
    const b = reviewBoard.mesh.position, h = camera.getWorldPosition(camera.position.clone());
    return { visible: reviewBoard.mesh.visible, d: Math.hypot(b.x - h.x, b.z - h.z), below: h.y - b.y };
  });
  const r = await at();
  assert.ok(r.visible, 'shown when the course ended');
  assert.ok(r.d > 0.5 && r.d < 1 && r.below > 0.3, JSON.stringify(r));
  const tapB = async () => {
    await page.evaluate(() => { window.__xr.buttons.right[5] = true; }); await frames(2);
    await page.evaluate(() => { window.__xr.buttons.right[5] = false; }); await frames(2);
  };
  await tapB();
  assert.equal((await at()).visible, false);
  await tapB();
  assert.equal((await at()).visible, true);
  await tapB();
});

await check('Lost lifeline (VR): hold the left stick press', async () => {
  await page.evaluate(() => window.__t.course({ seed: 5 }));
  await frames(2);
  await page.evaluate(() => { window.__xr.buttons.left[3] = true; });
  await page.waitForFunction(() => window.__landnav.run.reveals === 1, null, { timeout: 30000, polling: 50 });
  await page.evaluate(() => { window.__xr.buttons.left[3] = false; }); await frames(2);
  const r = await page.evaluate(() => ({ v: window.__landnav.tools.map.here.visible, n: window.__landnav.run.reveals }));
  assert.ok(r.v);
  assert.equal(r.n, 1, 'one hold, one reveal');
  assert.ok(await page.evaluate(() => window.__xr.pulses.some((p) => p.hand === 'left' && p.ms === 60)));
  await page.evaluate(() => window.__landnav.tools.map.hidePosition());
});

await check('M3 VR: ruler along a drawn line (right stick press)', async () => {
  await page.evaluate(() => { window.__landnav.tools.map.clear(); window.__xr.buttons.left[1] = true; });
  await frames(3);
  const A = { x: 700, z: 1300 }, B = { x: 1100, z: 900 };
  const aimTap = async (pt, b = 0) => {
    await page.evaluate(({ x, z }) => {
      const { w, n } = window.__t.onBoard(x, z);
      window.__t.aim('right', 'ray', [w[0] + n[0] * 0.15, w[1] + n[1] * 0.15, w[2] + n[2] * 0.15], w);
    }, pt);
    await frames(2);
    await page.evaluate((i) => { window.__xr.buttons.right[i] = true; }, b); await frames(1);
    await page.evaluate((i) => { window.__xr.buttons.right[i] = false; }, b); await frames(2);
  };
  await aimTap(A); await aimTap(B); await aimTap(A); await aimTap(B);
  await aimTap(B, 3);
  const r = await page.evaluate(() => {
    const m = window.__landnav.tools.map;
    const a = m.boardOf(m.dots[0]);
    return { v: m.ruler.visible, p: m.ruler.position.toArray(), a, rot: m.ruler.rotation.z };
  });
  assert.ok(r.v, 'ruler shown');
  assert.ok(Math.hypot(r.p[0] - r.a.bx, r.p[1] - r.a.by) < 1e-9, 'zero on the first dot');
  // A to B runs north-east on the board: +x and +y, 45 degrees.
  assert.ok(Math.abs(r.rot - Math.PI / 4) < 1e-3, `angle ${r.rot}`);
  await page.evaluate(() => { window.__landnav.tools.map.clear(); window.__xr.buttons.left[1] = false; window.__xr.pose = { left: {}, right: {} }; });
  await frames(2);
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

await check('physical walking into a trunk pushes you back out', async () => {
  const tree = await page.evaluate(() => {
    const l = window.__landnav;
    l.settings.preset = 'woods'; l.vegetation.setPreset('woods');
    window.__xr.head.x = 0;
    l.player.rotation.y = 0;
    const h = l.camera.getWorldPosition(l.camera.position.clone());
    const tree = window.__t.clearTrunk(h.x, h.z);
    if (tree) window.__t.goTo(tree.x + 2, tree.z);
    return tree;
  });
  assert.ok(tree, 'found a trunk');
  try {
    await frames(2);
    await page.evaluate(() => { window.__landnav.settings.collisions = true; window.__xr.head.x = -2; }); // step 2 m west, into it
    await frames(3);
    const d = await page.evaluate((t) => {
      const h = window.__landnav.camera.getWorldPosition(window.__landnav.camera.position.clone());
      return Math.hypot(h.x - t.x, h.z - t.z);
    }, tree);
    assert.ok(d > tree.r + 0.24, `head ${d} m from the trunk centre`);
  } finally {
    await page.evaluate(() => {
      const l = window.__landnav;
      l.settings.collisions = false; l.settings.preset = 'open'; l.vegetation.setPreset('open');
      window.__xr.head.x = 0;
    });
  }
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
