// Left-wrist kit: pace beads (spec 7.3) and the score card (spec 7.4).
import * as THREE from 'three';
import { formatClock } from './course.js';

const BEAD_R = 0.0055;
const STEP = BEAD_R * 2 + 0.0006;

// A cord with 4 upper (1 km) beads above a knot and 9 lower (100 m) beads below.
// Counted beads slide down to the bottom of their section.
export function createBeadsModel() {
  const group = new THREE.Group();
  group.name = 'beads';
  const cordLen = 0.26;
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, cordLen, 6), new THREE.MeshLambertMaterial({ color: 0x1b1b1b }));
  group.add(cord);
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 10, 8), new THREE.MeshLambertMaterial({ color: 0x1b1b1b }));
  const top = cordLen / 2;
  const upperTop = top - 0.004, upperBottom = upperTop - 0.07;
  const knotY = upperBottom - 0.006;
  const lowerTop = knotY - 0.006, lowerBottom = -top + 0.004;
  knot.position.y = knotY;
  group.add(knot);
  const geo = new THREE.SphereGeometry(BEAD_R, 12, 10);
  const upperMat = new THREE.MeshLambertMaterial({ color: 0x2f4a2a });
  const lowerMat = new THREE.MeshLambertMaterial({ color: 0xb08a55 });
  const upper = Array.from({ length: 4 }, () => new THREE.Mesh(geo, upperMat));
  const lower = Array.from({ length: 9 }, () => new THREE.Mesh(geo, lowerMat));
  for (const b of [...upper, ...lower]) group.add(b);

  const layout = (beads, slid, yTop, yBottom) => {
    const n = beads.length;
    beads.forEach((b, i) => {
      // Beads 0..n-slid-1 stay up; the last `slid` sit at the bottom.
      const up = i < n - slid;
      b.position.y = up ? yTop - BEAD_R - i * STEP : yBottom + BEAD_R + (n - 1 - i) * STEP;
    });
  };
  const update = (counter) => {
    layout(upper, counter.upper, upperTop, upperBottom);
    layout(lower, counter.lower, lowerTop, lowerBottom);
  };
  update({ upper: 0, lower: 0 });
  return { group, update };
}

// The score card: a canvas drawn only when its text changes.
export function createScoreCard() {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.16), new THREE.MeshBasicMaterial({ map: tex }));
  mesh.name = 'score-card';
  mesh.visible = false;
  let lastKey = '';

  // run: CourseRun or null. hints: control reminder line for this mode.
  const draw = (run, hints) => {
    const clock = run ? Math.floor(run.elapsed) : 0;
    const key = run ? JSON.stringify([run.course.id, run.state, clock, run.row, run.entries, run.reveals, hints]) : 'none';
    if (key === lastKey) return;
    lastKey = key;
    g.fillStyle = '#f7f3e3';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = '#333'; g.lineWidth = 6;
    g.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
    g.fillStyle = '#111';
    g.textBaseline = 'top';
    if (!run) {
      g.font = 'bold 40px system-ui, sans-serif';
      g.fillText('No course loaded', 30, 40);
      g.font = '28px system-ui, sans-serif';
      g.fillText('Pick one on the page before', 30, 110);
      g.fillText('entering VR (Course button).', 30, 150);
      tex.needsUpdate = true;
      return;
    }
    const grids = run.grids;
    g.font = 'bold 38px system-ui, sans-serif';
    g.fillText(run.course.name, 30, 28, canvas.width - 60);
    g.font = '28px ui-monospace, Menlo, Consolas, monospace';
    g.fillText(`START ${grids.start}`, 30, 84);
    let y = 140;
    const res = run.result;
    grids.points.forEach((grid, i) => {
      const entered = run.entries[i];
      if (!res && i === run.row) {
        g.fillStyle = '#ffe28a';
        g.fillRect(16, y - 6, canvas.width - 32, 52);
      }
      g.fillStyle = '#111';
      g.font = 'bold 30px ui-monospace, Menlo, Consolas, monospace';
      g.fillText(`${i + 1}`, 30, y + 4);
      g.font = '28px ui-monospace, Menlo, Consolas, monospace';
      g.fillText(grid, 64, y + 6);
      g.strokeStyle = '#555'; g.lineWidth = 2;
      g.strokeRect(470, y - 2, 100, 44);
      g.font = 'bold 32px system-ui, sans-serif';
      if (entered) g.fillText(entered, 492, y + 4);
      if (res) {
        const row = res.rows[i];
        g.fillStyle = row.correct ? '#1d7a2c' : '#b3161b';
        g.font = 'bold 30px system-ui, sans-serif';
        g.fillText(row.correct ? 'OK' : row.code, 400, y + 4);
      }
      y += 60;
    });
    y += 10;
    g.fillStyle = '#111';
    g.font = '28px system-ui, sans-serif';
    const status = run.state === 'ready' ? 'The clock starts when you move.' : run.state === 'running' ? 'Running.' : 'Ended.';
    g.fillText(`Time ${formatClock(run.elapsed)} of ${formatClock(run.timeLimitSec)}`, 30, y);
    y += 36;
    g.fillStyle = '#444';
    g.fillText(status, 30, y);
    g.fillStyle = '#111';
    y += 46;
    if (res) {
      g.font = 'bold 40px system-ui, sans-serif';
      g.fillStyle = res.pass ? '#1d7a2c' : '#b3161b';
      g.fillText(`${res.correct}/${res.total} correct: ${res.pass ? 'PASS' : 'FAIL'}`, 30, y);
      y += 54;
      g.fillStyle = '#111';
      g.font = '26px system-ui, sans-serif';
      const notes = [];
      if (!res.timeOk || res.reason === 'time') notes.push('out of time');
      if (!res.endedAtStart) notes.push('not back at the start');
      if (res.correct < run.course.pass_threshold) notes.push(`needed ${run.course.pass_threshold}`);
      if (notes.length) { g.fillText(notes.join(', '), 30, y); y += 38; }
      g.fillText(`Walked ${(res.walked / 1000).toFixed(2)} km, ideal ${(res.ideal / 1000).toFixed(2)} km`, 30, y);
      y += 38;
      if (res.reveals) {
        g.fillText(`Position shown ${res.reveals} time${res.reveals === 1 ? '' : 's'}`, 30, y);
        y += 38;
      }
    } else if (run.reveals) {
      g.fillStyle = '#7a4b00';
      g.fillText(`Position shown ${run.reveals} time${run.reveals === 1 ? '' : 's'}`, 30, y);
      g.fillStyle = '#111';
      y += 38;
    }
    g.fillStyle = '#555';
    g.font = '22px system-ui, sans-serif';
    const words = hints.split(' ');
    let line = '';
    let hy = canvas.height - 100;
    for (const w of words) {
      if (g.measureText(line + w).width > canvas.width - 60) { g.fillText(line, 30, hy); hy += 30; line = ''; }
      line += w + ' ';
    }
    g.fillText(line, 30, hy);
    tex.needsUpdate = true;
  };
  return { mesh, draw };
}
