// Draw a site's topographic map on a canvas, for sites built in the browser: the
// same layout and look as tools/make_site.py's map.png (contours with labelled
// index lines, roads, trails, streams, buildings, the 1 km grid with its numbers,
// 100 m ticks, and the margin with the scale bar and declination diagram).

// Font sizes are in points, as matplotlib draws map.png at 100 dpi.
const PT = 100 / 72;
const PAPER = '#f6f1e3', BROWN = '#9a5b2c', INK = '#1d1d1d', GRID = '#1f3f78';

export function mapLayout(px = 4096) {
  const side = Math.round((px * 3450) / 4096);
  const left = Math.floor((px - side) / 2);
  const top = Math.round((px * 110) / 4096);
  return { px, area: [left, top, left + side, top + side] };
}

// Contour segments for one level by marching squares over a grid of heights
// (row 0 north). Returns a flat array [x0, z0, x1, z1, ...] in scene metres.
export function contourSegments(h, grid, spacing, level, out = []) {
  for (let r = 0; r < grid - 1; r++) {
    for (let c = 0; c < grid - 1; c++) {
      const i = r * grid + c;
      const a = h[i], b = h[i + 1], d = h[i + grid + 1], e = h[i + grid];
      const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (d > level ? 2 : 0) | (e > level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const x = c * spacing, z = r * spacing;
      // Edge crossings: top (a-b), right (b-d), bottom (e-d), left (a-e).
      const t = (p, q) => (level - p) / (q - p);
      const top = () => [x + t(a, b) * spacing, z];
      const right = () => [x + spacing, z + t(b, d) * spacing];
      const bottom = () => [x + t(e, d) * spacing, z + spacing];
      const left = () => [x, z + t(a, e) * spacing];
      const seg = (p, q) => out.push(p[0], p[1], q[0], q[1]);
      switch (code) {
        case 1: case 14: seg(left(), bottom()); break;
        case 2: case 13: seg(bottom(), right()); break;
        case 3: case 12: seg(left(), right()); break;
        case 4: case 11: seg(top(), right()); break;
        case 6: case 9: seg(top(), bottom()); break;
        case 7: case 8: seg(left(), top()); break;
        case 5: { // saddle: decide by the centre
          const m = (a + b + d + e) / 4;
          if (m > level) { seg(left(), top()); seg(bottom(), right()); } else { seg(left(), bottom()); seg(top(), right()); }
          break;
        }
        case 10: {
          const m = (a + b + d + e) / 4;
          if (m > level) { seg(top(), right()); seg(left(), bottom()); } else { seg(left(), top()); seg(bottom(), right()); }
          break;
        }
        default: break;
      }
    }
  }
  return out;
}

// heights: absolute elevations (metres), grid x grid, row 0 north.
export function drawTopoMap(canvas, { site, heights, features, contourInterval = 10, indexInterval = 50 }) {
  const { px, area: [x0, y0, x1] } = site.map;
  canvas.width = canvas.height = px;
  const g = canvas.getContext('2d');
  const size = site.size_m, spacing = site.spacing_m, grid = site.grid;
  const areaPx = x1 - x0;
  const ppm = areaPx / size;
  const s = px / 4096;
  const X = (x) => x0 + x * ppm, Y = (z) => y0 + z * ppm;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, px, px);

  g.save();
  g.beginPath(); g.rect(x0, y0, areaPx, areaPx); g.clip();

  // Contours: thin every interval, thick index lines, labelled.
  let lo = Infinity, hi = -Infinity;
  for (const v of heights) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const first = Math.ceil(lo / contourInterval) * contourInterval;
  const labels = [];
  const isIndex = (lv) => Math.abs(lv / indexInterval - Math.round(lv / indexInterval)) < 1e-6;
  g.strokeStyle = BROWN; g.lineCap = 'round';
  for (let lv = first; lv <= hi; lv += contourInterval) {
    const segs = contourSegments(heights, grid, spacing, lv + 1e-4);
    const index = isIndex(lv);
    g.lineWidth = (index ? 5 : 2.4) * s;
    g.beginPath();
    for (let k = 0; k < segs.length; k += 4) { g.moveTo(X(segs[k]), Y(segs[k + 1])); g.lineTo(X(segs[k + 2]), Y(segs[k + 3])); }
    g.stroke();
    if (index) {
      // A label every so often along the line.
      for (let k = 0; k < segs.length; k += 4 * 37) labels.push({ lv, x: (segs[k] + segs[k + 2]) / 2, z: (segs[k + 1] + segs[k + 3]) / 2, a: Math.atan2(segs[k + 3] - segs[k + 1], segs[k + 2] - segs[k]) });
    }
  }
  const placed = [];
  g.font = `bold ${Math.round(26 * PT * s)}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const l of labels) {
    const lx = X(l.x), ly = Y(l.z);
    if (placed.some((p) => Math.hypot(p[0] - lx, p[1] - ly) < 520 * s)) continue;
    placed.push([lx, ly]);
    let a = l.a;
    if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;
    const text = String(l.lv);
    const w = g.measureText(text).width + 10 * s;
    g.save(); g.translate(lx, ly); g.rotate(a);
    g.fillStyle = PAPER; g.fillRect(-w / 2, -22 * s, w, 44 * s);
    g.fillStyle = BROWN; g.fillText(text, 0, 1);
    g.restore();
  }

  if (features) drawFeatures(g, features, X, Y, s, ppm);
  g.restore();

  // 1 km grid lines, labelled with the two principal digits.
  const eWest = site.e_west, nNorth = site.n_north;
  g.strokeStyle = GRID; g.lineWidth = 2.6 * s;
  g.fillStyle = GRID; g.font = `bold ${Math.round(44 * PT * s)}px system-ui, sans-serif`;
  for (let e = Math.ceil(eWest / 1000) * 1000; e <= eWest + size; e += 1000) {
    const x = X(e - eWest);
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + areaPx); g.stroke();
    const lab = String(Math.floor(e / 1000) % 100).padStart(2, '0');
    g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(lab, x, y0 - 8 * s);
    g.textBaseline = 'top'; g.fillText(lab, x, y0 + areaPx + 8 * s);
  }
  for (let n = Math.ceil((nNorth - size) / 1000) * 1000; n <= nNorth; n += 1000) {
    const y = Y(nNorth - n);
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x0 + areaPx, y); g.stroke();
    const lab = String(Math.floor(n / 1000) % 100).padStart(2, '0');
    g.textBaseline = 'middle';
    g.textAlign = 'right'; g.fillText(lab, x0 - 14 * s, y);
    g.textAlign = 'left'; g.fillText(lab, x0 + areaPx + 14 * s, y);
  }
  // 100 m ticks outside the neatline.
  g.lineWidth = 2.2 * s;
  g.beginPath();
  for (let e = Math.ceil(eWest / 100) * 100; e <= eWest + size; e += 100) {
    const x = X(e - eWest), ln = (e % 1000 === 0 ? 26 : e % 500 === 0 ? 18 : 12) * s;
    g.moveTo(x, y0); g.lineTo(x, y0 - ln); g.moveTo(x, y0 + areaPx); g.lineTo(x, y0 + areaPx + ln);
  }
  for (let n = Math.ceil((nNorth - size) / 100) * 100; n <= nNorth; n += 100) {
    const y = Y(nNorth - n), ln = (n % 1000 === 0 ? 26 : n % 500 === 0 ? 18 : 12) * s;
    g.moveTo(x0, y); g.lineTo(x0 - ln, y); g.moveTo(x0 + areaPx, y); g.lineTo(x0 + areaPx + ln, y);
  }
  g.stroke();
  g.strokeStyle = INK; g.lineWidth = 4 * s;
  g.strokeRect(x0, y0, areaPx, areaPx);

  drawMargin(g, site, { x0, x1, mtop: y0 + areaPx + 70 * s, s, ppm, areaPx, px, contourInterval, indexInterval, features });
  return canvas;
}

function drawFeatures(g, f, X, Y, s, ppm) {
  const poly = (pts) => { g.beginPath(); pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Y(z)) : g.moveTo(X(x), Y(z)))); g.closePath(); };
  const AREA = {
    campground: ['#cfe3b8', '#2f7a2f', 2.5, [6, 3]], clearing: ['#e6ecc2', null, 0, null],
    parking: ['#c9c6c0', '#555', 1.5, null], water: ['#9cc3e6', '#2f6fb5', 1.5, null], building: ['#111', '#111', 1, null],
  };
  for (const kind of ['clearing', 'campground', 'water', 'parking', 'building']) {
    const [fill, stroke, w, dash] = AREA[kind];
    for (const a of f.areas || []) {
      if (a.kind !== kind) continue;
      poly(a.pts);
      g.globalAlpha = kind === 'campground' ? 0.85 : 1;
      g.fillStyle = fill; g.fill();
      g.globalAlpha = 1;
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = w * s; g.setLineDash(dash ? dash.map((d) => d * w * s) : []); g.stroke(); g.setLineDash([]); }
    }
  }
  const line = (pts) => { g.beginPath(); pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Y(z)) : g.moveTo(X(x), Y(z)))); };
  const stroke = (color, w, dash = []) => { g.strokeStyle = color; g.lineWidth = w * s; g.setLineDash(dash.map((d) => d * w * s)); g.stroke(); g.setLineDash([]); };
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const l of f.lines || []) if (l.kind === 'stream') { line(l.pts); stroke('#2f6fb5', 2.4); }
  for (const l of f.lines || []) {
    if (l.kind === 'trail') { line(l.pts); g.lineCap = 'butt'; stroke('#111', 2, [3.5, 2.5]); g.lineCap = 'round'; }
    else if (l.kind === 'track') { line(l.pts); g.lineCap = 'butt'; stroke('#111', 2.6, [8, 3]); g.lineCap = 'round'; }
  }
  const major = (l) => ['motorway', 'trunk', 'primary', 'secondary'].includes(l.osm);
  for (const l of f.lines || []) if (l.kind === 'road') { line(l.pts); stroke('#111', major(l) ? 8 : 6); }
  for (const l of f.lines || []) if (l.kind === 'road') { line(l.pts); stroke(major(l) ? '#d23a2a' : '#fbfaf4', major(l) ? 4.6 : 3); }
  // One label per named road or trail, at the middle of its longest run.
  const seen = new Set();
  g.font = `${Math.round(17 * PT * s)}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'bottom';
  for (const l of [...(f.lines || [])].sort((a, b) => b.pts.length - a.pts.length)) {
    if (!l.name || l.kind === 'stream' || seen.has(l.name.toLowerCase())) continue;
    const p = l.pts;
    let len = 0;
    for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    if (len < 250) continue;
    seen.add(l.name.toLowerCase());
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const seg = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      if (acc + seg >= len / 2) {
        const t = seg ? (len / 2 - acc) / seg : 0;
        const mx = p[i - 1][0] + t * (p[i][0] - p[i - 1][0]), mz = p[i - 1][1] + t * (p[i][1] - p[i - 1][1]);
        let a = Math.atan2(p[i][1] - p[i - 1][1], p[i][0] - p[i - 1][0]);
        if (a > Math.PI / 2) a -= Math.PI; else if (a < -Math.PI / 2) a += Math.PI;
        g.save(); g.translate(X(mx), Y(mz)); g.rotate(a);
        g.lineWidth = 6 * s; g.strokeStyle = PAPER; g.strokeText(l.name, 0, 0);
        g.fillStyle = '#111'; g.fillText(l.name, 0, 0);
        g.restore();
        break;
      }
      acc += seg;
    }
  }
  for (const a of f.areas || []) {
    if (a.kind !== 'campground' || !a.name) continue;
    const cx = a.pts.reduce((v, q) => v + q[0], 0) / a.pts.length, cz = a.pts.reduce((v, q) => v + q[1], 0) / a.pts.length;
    g.font = `bold ${Math.round(19 * PT * s)}px system-ui, sans-serif`; g.textBaseline = 'middle';
    g.lineWidth = 6 * s; g.strokeStyle = PAPER; g.strokeText(a.name, X(cx), Y(cz));
    g.fillStyle = '#2f7a2f'; g.fillText(a.name, X(cx), Y(cz));
  }
  g.font = `${Math.round(16 * PT * s)}px system-ui, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle';
  for (const p of f.points || []) {
    g.fillStyle = '#111';
    if (p.kind === 'peak') { g.beginPath(); g.moveTo(X(p.x), Y(p.z) - 9 * s); g.lineTo(X(p.x) + 8 * s, Y(p.z) + 6 * s); g.lineTo(X(p.x) - 8 * s, Y(p.z) + 6 * s); g.fill(); }
    else if (p.kind === 'viewpoint') g.fillText('*', X(p.x) - 6 * s, Y(p.z));
    if (p.name) { g.lineWidth = 6 * s; g.strokeStyle = PAPER; g.strokeText(p.name, X(p.x + 25), Y(p.z)); g.fillText(p.name, X(p.x + 25), Y(p.z)); }
  }
}

function drawMargin(g, site, { x0, x1, mtop, s, ppm, areaPx, px, contourInterval, indexInterval, features }) {
  const text = (t, x, y, size, { weight = 'normal', color = INK, align = 'left', base = 'top' } = {}) => {
    g.font = `${weight} ${Math.round(size * PT * s)}px system-ui, sans-serif`;
    g.fillStyle = color; g.textAlign = align; g.textBaseline = base;
    g.fillText(t, x, y);
  };
  text(site.name, x0, mtop, 64, { weight: 'bold' });
  text(`${site.mgrs_gzd} ${site.mgrs_100km}   UTM ${site.utm_zone}   Contour interval ${contourInterval} m, index every ${indexInterval} m`, x0, mtop + 105 * s, 30);
  text('Grid lines 1 km. Ticks every 100 m. Elevations in metres.', x0, mtop + 155 * s, 26);
  text(features ? 'Elevation USGS 3DEP. Roads, trails and streams (c) OpenStreetMap contributors (ODbL). Built in the browser.' : 'Elevation USGS 3DEP. Built in the browser.', x0, mtop + 200 * s, 22);
  // Scale bar: 0..1000 m, alternating 100 m blocks for the first 500 m.
  const sbTop = mtop + 250 * s, sbH = 22 * s;
  [[0, 100], [100, 200], [200, 300], [300, 400], [400, 500], [500, 1000]].forEach(([a, b], i) => {
    g.fillStyle = i % 2 === 0 ? INK : PAPER;
    g.fillRect(x0 + a * ppm, sbTop, (b - a) * ppm, sbH);
    g.strokeStyle = INK; g.lineWidth = 2 * s; g.strokeRect(x0 + a * ppm, sbTop, (b - a) * ppm, sbH);
  });
  for (const m of [0, 100, 200, 300, 400, 500, 1000]) text(String(m), x0 + m * ppm, sbTop + sbH + 10 * s, 24, { align: 'center' });
  text('metres', x0 + 1000 * ppm + 30 * s, sbTop + sbH / 2, 24, { base: 'middle' });
  const den = Math.round(site.size_m / ((0.4 * areaPx) / px) / 100) * 100;
  text(`About 1:${den.toLocaleString('en-US')} on the 40 cm map board`, x0, sbTop + sbH + 60 * s, 24);

  // Declination diagram: grid north up, magnetic and true north either side.
  const gm = site.gm_angle_deg, conv = site.convergence_deg, decl = site.declination_deg;
  const shown = (v) => (v === 0 ? 0 : Math.sign(v) * Math.min(Math.max(Math.abs(v), 14), 30));
  let aMn = shown(gm), aTn = shown(-conv);
  if (aMn * aTn > 0 && Math.abs(aMn - aTn) < 12) {
    const sign = Math.sign(Math.abs(gm) >= Math.abs(conv) ? aMn : aTn);
    [aMn, aTn] = Math.abs(gm) >= Math.abs(conv) ? [sign * 28, sign * 14] : [sign * 14, sign * 28];
  }
  const dcx = x1 - 1050 * s, base = mtop + 380 * s, len = 260 * s;
  const ray = (deg, label, dash) => {
    const a = (deg * Math.PI) / 180;
    const ex = dcx + len * Math.sin(a), ey = base - len * Math.cos(a);
    g.strokeStyle = INK; g.lineWidth = 3 * s; g.setLineDash(dash);
    g.beginPath(); g.moveTo(dcx, base); g.lineTo(ex, ey); g.stroke(); g.setLineDash([]);
    text(label, ex, ey - 10 * s, 22, { weight: 'bold', align: 'center', base: 'bottom' });
  };
  ray(0, 'GN', []); ray(aMn, 'MN', []); ray(aTn, 'TN', [3 * s, 5 * s]);
  const side = gm >= 0 ? 'east' : 'west';
  const lines = [
    [`G-M angle ${Math.abs(gm).toFixed(1)}° ${side} (${Math.round((Math.abs(gm) * 6400) / 360)} mils)`, 30, 'bold'],
    [`Grid to magnetic: ${gm >= 0 ? 'subtract' : 'add'} G-M angle`, 24, 'normal'],
    [`Magnetic to grid: ${gm >= 0 ? 'add' : 'subtract'} G-M angle`, 24, 'normal'],
    [`Declination ${Math.abs(decl).toFixed(1)}° ${decl >= 0 ? 'E' : 'W'} (${site.declination_date})`, 22, 'normal'],
    [`Grid convergence ${Math.abs(conv).toFixed(1)}° ${conv >= 0 ? 'E' : 'W'}`, 22, 'normal'],
    ['Diagram angles not to scale', 20, 'normal'],
  ];
  let y = mtop + 40 * s;
  for (const [t, size, weight] of lines) { text(t, dcx + 200 * s, y, size, { weight }); y += (size * 1.9 + 8) * s; }
}
