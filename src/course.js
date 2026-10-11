// A course run (spec section 8): stakes in the world, punching, the course clock,
// pace beads, the run log and the result.
import * as THREE from 'three';
import { scoreRun, idealDistance, END_AT_START_M } from './course-logic.js';
import { BeadCounter } from './beads.js';
import { RunLog } from './runlog.js';
import { eightDigitGrid } from './coords.js';
import { storage } from './settings.js';
import { dataUrl } from './data-url.js';

export const PUNCH_RANGE_M = 2;
const HISTORY_KEY = 'landnav.history.v1';

export async function loadCourseIndex(base) {
  try {
    const res = await fetch(dataUrl(`${base}/courses/index.json`));
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function loadCourse(base, file) {
  const res = await fetch(dataUrl(`${base}/courses/${file}`));
  if (!res.ok) throw new Error(`Could not load course ${file} (${res.status})`);
  return res.json();
}

// Shared stake parts.
const POST_GEO = new THREE.BoxGeometry(0.07, 1.2, 0.07).translate(0, 0.6, 0);
const POST_MAT = new THREE.MeshLambertMaterial({ color: 0xc9692a });
const BAND_GEO = new THREE.BoxGeometry(0.075, 0.12, 0.075).translate(0, 1.14, 0);
const BAND_MAT = new THREE.MeshLambertMaterial({ color: 0xf2f2ec });
const PLACARD_GEO = new THREE.BoxGeometry(0.22, 0.13, 0.012);

function placardTexture(text, color = '#111') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 152;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f1e6';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#333'; g.lineWidth = 6;
  g.strokeRect(3, 3, c.width - 6, c.height - 6);
  g.fillStyle = color;
  g.font = `bold ${text.length > 3 ? 60 : 100}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeStake(code, rotY) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(POST_GEO, POST_MAT));
  g.add(new THREE.Mesh(BAND_GEO, BAND_MAT));
  const face = new THREE.MeshBasicMaterial({ map: placardTexture(code) });
  const edge = new THREE.MeshLambertMaterial({ color: 0x555555 });
  // Box faces: +x, -x, +y, -y, +z, -z. The code shows on both broad faces.
  const placard = new THREE.Mesh(PLACARD_GEO, [edge, edge, edge, edge, face, face]);
  placard.position.set(0, 0.95, 0.045);
  g.add(placard);
  g.rotation.y = rotY;
  return g;
}

function makeStartFlag() {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.6, 8).translate(0, 1.3, 0), new THREE.MeshLambertMaterial({ color: 0xdddddd }));
  g.add(pole);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(0.7, -0.22); shape.lineTo(0, -0.44); shape.closePath();
  const flag = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ color: 0xd42a1f, side: THREE.DoubleSide }));
  flag.position.set(0.03, 2.55, 0);
  g.add(flag);
  const face = new THREE.MeshBasicMaterial({ map: placardTexture('START', '#a01010') });
  const edge = new THREE.MeshLambertMaterial({ color: 0x555555 });
  const placard = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.012), [edge, edge, edge, edge, face, face]);
  placard.position.set(0, 1.4, 0.04);
  g.add(placard);
  return g;
}

export class CourseRun {
  constructor({ scene, terrain, site, course, settings }) {
    this.scene = scene;
    this.site = site;
    this.course = course;
    this.settings = settings;
    this.state = 'ready';     // 'ready' (clock not started) | 'running' | 'ended'
    this.elapsed = 0;         // course seconds; runs faster under time compression
    this.entries = course.points.map(() => null);
    this.row = 0;             // the score-card row the next punch fills
    this.beads = new BeadCounter();
    this.log = new RunLog();
    this.result = null;
    this.reveals = 0;         // times the user asked to see their position
    this.ideal = idealDistance(course);

    this.group = new THREE.Group();
    this.group.name = 'course';
    this.stakes = [];
    // Stakes face a random way: walk round to read the placard.
    let k = course.seed ?? 1;
    const turn = () => { k = (k * 9301 + 49297) % 233280; return (k / 233280) * Math.PI * 2; };
    const add = (s, kind, mesh) => {
      mesh.position.set(s.x, terrain.heightAt(s.x, s.z), s.z);
      mesh.visible = false;
      this.group.add(mesh);
      this.stakes.push({ code: s.code ?? 'START', kind, x: s.x, z: s.z, mesh });
    };
    add(course.start, 'start', makeStartFlag());
    for (const p of course.points) add(p, 'point', makeStake(p.code, turn()));
    for (const d of course.decoys) add(d, 'decoy', makeStake(d.code, turn()));
    scene.add(this.group);
  }

  dispose() {
    this.scene.remove(this.group);
  }

  // What the score card shows: grids only, never positions.
  get grids() {
    return {
      start: eightDigitGrid(this.site, this.course.start.x, this.course.start.z),
      points: this.course.points.map((p) => eightDigitGrid(this.site, p.x, p.z)),
    };
  }

  get timeLimitSec() {
    return this.course.time_limit_min * 60;
  }

  // pos: true horizontal position. flags: { moving, mapOut, compassOut }.
  update(dt, pos, flags) {
    const vis2 = (this.settings.night ? this.settings.nightStakeVisibility : this.settings.stakeVisibility) ** 2;
    for (const s of this.stakes) {
      s.mesh.visible = (s.x - pos.x) ** 2 + (s.z - pos.z) ** 2 <= vis2;
    }
    if (this.state === 'ready' && flags.moving) this.begin(pos);
    if (this.state !== 'running') return;
    this.elapsed += dt * this.settings.timeScale;
    this.log.sample(this.elapsed, pos.x, pos.z);
    this.log.tool('map', !!flags.mapOut, this.elapsed);
    this.log.tool('compass', !!flags.compassOut, this.elapsed);
    if (this.elapsed >= this.timeLimitSec) this.end(pos, 'time');
  }

  begin(pos) {
    if (this.state !== 'ready') return;
    this.state = 'running';
    this.log.event('start', 0, { x: pos.x, z: pos.z });
    this.log.sample(0, pos.x, pos.z);
  }

  nearestStake(pos, range = PUNCH_RANGE_M) {
    let best = null, bestD = range;
    for (const s of this.stakes) {
      if (s.kind === 'start') continue;
      const d = Math.hypot(s.x - pos.x, s.z - pos.z);
      if (d <= bestD) { best = s; bestD = d; }
    }
    return best;
  }

  // Punch the stake within 2 m: its code goes in the current row, and the row moves
  // on to the next blank. No word on whether it's right until the end.
  punch(pos) {
    if (this.state === 'ended') return { kind: 'ended' };
    const s = this.nearestStake(pos);
    if (!s) return { kind: 'none' };
    this.begin(pos);
    const row = this.row;
    this.entries[row] = s.code;
    this.log.event('punch', this.elapsed, { code: s.code, row, x: pos.x, z: pos.z });
    const n = this.entries.length;
    for (let i = 1; i <= n; i++) {
      const r = (row + i) % n;
      if (this.entries[r] === null) { this.row = r; break; }
    }
    return { kind: 'punch', code: s.code, row };
  }

  selectRow(delta) {
    const n = this.entries.length;
    this.row = (this.row + delta + n) % n;
  }

  // The lost lifeline: counted, logged with the true position, shown in the result.
  revealPosition(pos) {
    this.reveals++;
    this.log.event('reveal', this.elapsed, { x: pos.x, z: pos.z });
  }

  slideBead(pos) {
    this.beads.slide(this.elapsed, pos);
  }

  resetBeads(pos) {
    this.beads.reset(this.elapsed, pos);
  }

  end(pos, reason = 'ended') {
    if (this.state === 'ended') return this.result;
    this.state = 'ended';
    this.log.finish(this.elapsed, pos.x, pos.z);
    const endedAtStart = Math.hypot(pos.x - this.course.start.x, pos.z - this.course.start.z) <= END_AT_START_M;
    this.result = {
      ...scoreRun(this.course, this.entries, { elapsedSec: this.elapsed, endedAtStart }),
      reason,
      walked: this.log.distance(),
      ideal: this.ideal,
      reveals: this.reveals,
    };
    this.log.event('end', this.elapsed, { reason, endedAtStart });
    saveHistory({
      course: this.course.id,
      site: this.site.id,
      date: new Date().toISOString(),
      correct: this.result.correct,
      total: this.result.total,
      pass: this.result.pass,
      reveals: this.reveals,
      elapsedSec: Math.round(this.elapsed),
    });
    return this.result;
  }
}

function saveHistory(entry) {
  const s = storage();
  if (!s) return;
  try {
    const list = JSON.parse(s.getItem(HISTORY_KEY) || '[]');
    list.push(entry);
    s.setItem(HISTORY_KEY, JSON.stringify(list.slice(-50)));
  } catch {
    // History is a nicety; never let storage break the run.
  }
}

export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
