// The after-action review board (spec section 9): your track over the map with the
// ideal legs, and the numbers for each leg. One canvas, shown as a page overlay on
// desktop and as a table in front of you in VR.
import * as THREE from 'three';
import { sceneToMapPx } from './map-math.js';
import { formatDuration, formatDrift, formatPaceError } from './aar-logic.js';

const W = 2400, H = 1400, MAP = 1400; // canvas, and the square map on its left
const PAD_M = 150;                    // map margin around the course and track
const LEG_COLORS = ['#d0202a', '#7a1fa2', '#d86a00', '#0a7d4f', '#1f5fbf', '#8a6d00'];
const IDEAL = '#1a3fa0';
const STAKE = '#c0168a';

// The part of the site to show: everything that happened, plus a margin, square.
function cropBox(site, run) {
  const pts = [run.course.start, ...run.course.points, ...run.course.decoys, ...run.log.track];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
  }
  const size = Math.min(site.size_m, Math.max(x1 - x0, z1 - z0) + 2 * PAD_M);
  const clamp = (lo) => Math.min(site.size_m - size, Math.max(0, lo));
  return { x: clamp((x0 + x1) / 2 - size / 2), z: clamp((z0 + z1) / 2 - size / 2), size };
}

function drawMap(g, site, mapImage, run, analysis) {
  const box = cropBox(site, run);
  const s = MAP / box.size; // canvas px per metre
  const P = (p) => [(p.x - box.x) * s, (p.z - box.z) * s];
  g.fillStyle = '#f4efe2';
  g.fillRect(0, 0, MAP, MAP);
  if (mapImage) {
    const a = sceneToMapPx(site, box.x, box.z), b = sceneToMapPx(site, box.x + box.size, box.z + box.size);
    g.drawImage(mapImage, a.px, a.py, b.px - a.px, b.py - a.py, 0, 0, MAP, MAP);
  }
  g.save();
  g.beginPath(); g.rect(0, 0, MAP, MAP); g.clip();
  g.lineCap = 'round'; g.lineJoin = 'round';

  // Ideal legs: the straight lines you should have plotted.
  g.setLineDash([22, 14]);
  g.strokeStyle = IDEAL; g.lineWidth = 5;
  for (const l of analysis.legs) {
    g.beginPath(); g.moveTo(...P(l.from)); g.lineTo(...P(l.to)); g.stroke();
  }
  g.setLineDash([]);

  // Your track, one colour per leg, on a white halo so it reads over contours.
  const legPts = analysis.legs.map((l) => run.log.track.filter((p) => p.t >= l.t0 && p.t <= l.t1));
  for (const [halo, w] of [[true, 11], [false, 6]]) {
    analysis.legs.forEach((l, i) => {
      const pts = legPts[i];
      if (pts.length < 2) return;
      g.strokeStyle = halo ? 'rgba(255,255,255,0.85)' : LEG_COLORS[i % LEG_COLORS.length];
      g.lineWidth = w;
      g.beginPath(); g.moveTo(...P(pts[0]));
      for (const p of pts.slice(1)) g.lineTo(...P(p));
      g.stroke();
    });
  }

  // Where you were once you'd walked the leg distance, tied back to the ideal line.
  analysis.legs.forEach((l, i) => {
    if (!l.drift) return;
    const [dx, dz] = P(l.drift);
    const len = Math.hypot(l.to.x - l.from.x, l.to.z - l.from.z) || 1;
    const along = Math.max(0, Math.min(len, l.drift.along));
    const foot = { x: l.from.x + ((l.to.x - l.from.x) / len) * along, z: l.from.z + ((l.to.z - l.from.z) / len) * along };
    g.setLineDash([8, 8]); g.strokeStyle = LEG_COLORS[i % LEG_COLORS.length]; g.lineWidth = 3;
    g.beginPath(); g.moveTo(dx, dz); g.lineTo(...P(foot)); g.stroke();
    g.setLineDash([]);
    g.fillStyle = LEG_COLORS[i % LEG_COLORS.length]; g.strokeStyle = '#fff'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(dx, dz - 14); g.lineTo(dx + 14, dz); g.lineTo(dx, dz + 14); g.lineTo(dx - 14, dz); g.closePath();
    g.fill(); g.stroke();
  });

  const label = (text, x, y, color = '#111', size = 30) => {
    g.font = `bold ${size}px system-ui, sans-serif`;
    g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.strokeText(text, x, y);
    g.fillStyle = color; g.fillText(text, x, y);
  };
  g.textAlign = 'left'; g.textBaseline = 'middle';

  // Decoys, then points (numbered circles), then the start triangle.
  for (const d of run.course.decoys) {
    const [x, z] = P(d);
    g.fillStyle = '#777'; g.beginPath(); g.arc(x, z, 8, 0, Math.PI * 2); g.fill();
    label(d.code, x + 14, z, '#666', 24);
  }
  run.course.points.forEach((p, i) => {
    const [x, z] = P(p);
    g.strokeStyle = STAKE; g.lineWidth = 5;
    g.beginPath(); g.arc(x, z, 26, 0, Math.PI * 2); g.stroke();
    label(`${i + 1} ${p.code}`, x + 32, z - 26, STAKE, 30);
  });
  const [sx, sz] = P(run.course.start);
  g.strokeStyle = STAKE; g.lineWidth = 5;
  g.beginPath(); g.moveTo(sx, sz - 34); g.lineTo(sx + 30, sz + 18); g.lineTo(sx - 30, sz + 18); g.closePath(); g.stroke();
  label('START', sx + 36, sz + 22, STAKE, 28);

  // Punches (what you recorded where) and every "show my position".
  for (const e of run.log.events) {
    if (e.type === 'punch') {
      const [x, z] = P(e);
      g.strokeStyle = '#111'; g.lineWidth = 5;
      g.beginPath(); g.moveTo(x - 12, z - 12); g.lineTo(x + 12, z + 12); g.moveTo(x + 12, z - 12); g.lineTo(x - 12, z + 12); g.stroke();
      label(e.code, x - 12, z + 30, '#111', 24);
    } else if (e.type === 'reveal') {
      const [x, z] = P(e);
      g.fillStyle = '#ff8c00'; g.beginPath(); g.arc(x, z, 16, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 24px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('?', x, z + 1); g.textAlign = 'left';
    }
  }
  g.restore();

  // Scale bar, 100 m.
  const bar = 100 * s;
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(20, MAP - 76, bar + 140, 56);
  g.fillStyle = '#111'; g.fillRect(36, MAP - 44, bar, 10);
  g.font = '24px system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText('100 m', 50 + bar, MAP - 40);
  g.strokeStyle = '#333'; g.lineWidth = 2; g.strokeRect(0.5, 0.5, MAP - 1, MAP - 1);
}

function drawPanel(g, run, analysis, hint) {
  const x0 = MAP + 48, right = W - 40;
  let y = 64;
  g.fillStyle = '#f7f5ef'; g.fillRect(MAP, 0, W - MAP, H);
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  const line = (text, { size = 28, color = '#222', bold = false, gap = 1.35, x = x0 } = {}) => {
    g.font = `${bold ? '600 ' : ''}${size}px system-ui, sans-serif`;
    g.fillStyle = color;
    g.fillText(text, x, y, right - x);
    y += size * gap;
  };
  const r = run.result || {};
  const t = analysis.totals;
  line('After-action review', { size: 26, color: '#777', gap: 1.9 });
  line(run.course.name, { size: 44, bold: true, gap: 1.2 });
  line(`${new Date(run.date).toLocaleString()}`, { size: 22, color: '#777', gap: 1.8 });
  if (r.total !== undefined) {
    line(`${r.correct}/${r.total} correct   ${r.pass ? 'PASS' : 'FAIL'}`, { size: 40, bold: true, color: r.pass ? '#0a7d4f' : '#b3261e', gap: 1.3 });
    const why = [];
    if (r.correct < run.course.pass_threshold) why.push(`needs ${run.course.pass_threshold} right`);
    if (r.timeOk === false) why.push('over time');
    if (r.endedAtStart === false) why.push('not ended at the start');
    if (why.length) line(why.join(', '), { size: 24, color: '#b3261e' });
  }
  const over = t.ideal > 0 ? Math.round((t.walked / t.ideal - 1) * 100) : 0;
  line(`Time ${formatDuration(t.time)} of ${formatDuration(run.course.time_limit_min * 60)}   Walked ${(t.walked / 1000).toFixed(2)} km, ideal ${(t.ideal / 1000).toFixed(2)} km (${over >= 0 ? '+' : ''}${over}%)`, { size: 25 });
  line(`Map out ${formatDuration(t.mapSec)}   Compass out ${formatDuration(t.compassSec)}${t.reveals ? `   Position shown ${t.reveals}x` : ''}`, { size: 25, gap: 1.7 });

  analysis.legs.forEach((l, i) => {
    const color = LEG_COLORS[i % LEG_COLORS.length];
    g.fillStyle = color; g.fillRect(x0, y - 26, 14, 30);
    const mark = l.correct === true ? '  ✓' : l.correct === false ? `  ✗ (card: ${l.entered ?? 'blank'})` : '';
    line(`Leg ${l.n} to ${l.label}${l.code ? ` ${l.code}` : ''}${mark}`, { size: 29, bold: true, x: x0 + 26, gap: 1.25 });
    const jogged = l.walked > 0 && l.jogged / l.walked >= 0.05 ? ` (${Math.round((100 * l.jogged) / l.walked)}% jogged)` : '';
    line(`${Math.round(l.gridAz)}° grid / ${Math.round(l.magAz)}° mag, ${Math.round(l.distance)} m   took ${formatDuration(l.time)}, covered ${Math.round(l.walked)} m${jogged}`, { size: 23, x: x0 + 26, gap: 1.3 });
    const reach = l.found ? 'reached it' : `closest ${Math.round(l.closest?.d ?? 0)} m`;
    const drift = l.drift
      ? (l.drift.short ? `leg ended before ${Math.round(l.distance)} m` : `at ${Math.round(l.distance)} m: ${formatDrift(l.drift.lateral)}, ${Math.round(l.drift.toTarget)} m from it`)
      : '';
    line(`${reach}   ${drift}`, { size: 23, x: x0 + 26, gap: 1.3 });
    const pace = l.pace
      ? `beads ${l.pace.beads} (${l.pace.claimed} m) for ${Math.round(l.pace.walked)} m covered: ${formatPaceError(l.pace.error)}`
      : 'no beads slid';
    line(pace, { size: 23, x: x0 + 26, color: l.pace ? '#222' : '#888', gap: 1.75 });
  });

  if (analysis.pace) {
    const p = analysis.pace;
    const jogShare = t.walked > 0 ? t.jogged / t.walked : 0;
    // Bead error against one count only makes sense if you mostly used one gait.
    const gait = jogShare >= 0.9 ? 'jog' : jogShare <= 0.1 ? 'walk' : null;
    const count = gait === 'jog' ? run.settings?.jogPaceCountPer100m : gait === 'walk' ? run.settings?.paceCountPer100m : null;
    line(`Pace overall: beads ${formatPaceError(p.error)} against distance covered`, { size: 26, bold: true, gap: 1.3 });
    if (count && p.walked > 0) {
      const effective = count * (p.claimed / p.walked);
      line(`Your ${gait}ing count worked out to ${effective.toFixed(0)} paces per 100 m here (setting ${count}).`, { size: 23, gap: 1.6 });
    } else if (!gait) {
      line(`You jogged ${Math.round(jogShare * 100)}% of the way, so this mixes your walking and jogging counts.`, { size: 23, gap: 1.6 });
    }
  }
  g.font = '22px system-ui, sans-serif'; g.fillStyle = '#777';
  g.fillText(hint, x0, H - 36, right - x0);
}

// Legend strip along the bottom of the map.
function drawLegend(g) {
  const y = MAP - 40, x = MAP - 780;
  g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(x - 16, y - 36, 790, 56);
  g.font = '22px system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillStyle = '#111';
  g.setLineDash([16, 10]); g.strokeStyle = IDEAL; g.lineWidth = 4;
  g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 50, y - 8); g.stroke(); g.setLineDash([]);
  g.fillText('ideal', x + 58, y - 8);
  g.strokeStyle = LEG_COLORS[0]; g.lineWidth = 6;
  g.beginPath(); g.moveTo(x + 130, y - 8); g.lineTo(x + 180, y - 8); g.stroke();
  g.fillText('you', x + 188, y - 8);
  g.fillText('✕ punch   ◆ at leg distance   ? position shown', x + 250, y - 8);
}

export function drawReview(canvas, { site, mapImage, run, analysis, hint = '' }) {
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  drawMap(g, site, mapImage, run, analysis);
  drawLegend(g);
  drawPanel(g, run, analysis, hint);
  return canvas;
}

// The review as a table-top board in VR: placed in front of the viewer, tipped
// back like a map on a table.
export function createReviewBoard() {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const width = 1.4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, (width * H) / W),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
  );
  mesh.name = 'review-board';
  mesh.visible = false;
  return {
    mesh,
    canvas,
    draw(args) {
      drawReview(canvas, args);
      tex.anisotropy = 8;
      tex.needsUpdate = true;
    },
    // head: world position of the eyes; dir: horizontal facing (unit vector).
    placeBefore(head, dir) {
      mesh.position.set(head.x + dir.x * 0.75, head.y - 0.5, head.z + dir.z * 0.75);
      mesh.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0, 'YXZ');
      mesh.rotateX(-0.75); // tipped back toward you
      mesh.visible = true;
    },
  };
}

// Save a run file (JSON) to the user's downloads.
export function downloadRun(run) {
  const blob = new Blob([JSON.stringify(run)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = run.date.slice(0, 16).replace(/[:T]/g, '-');
  a.download = `land-nav-${run.course.id}-${stamp}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
