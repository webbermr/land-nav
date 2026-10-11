// Map board (spec section 7.2): map.png on a 40 cm board, with pencil dots, lines
// and a protractor. Marks are stored in scene metres so later milestones (AAR,
// scoring) can use them. The board never shows where you are.
import * as THREE from 'three';
import { BOARD_SIZE_M, boardScale, boardToScene, insideTerrain, sceneToBoard, sceneToMapPx } from './map-math.js';
import { gridAzimuth, gridToMagnetic, degToMils, horizontalDistance } from './coords.js';

const OVERLAY_PX = 2048;
const DOT_PICK_M = 0.01;       // board metres: how close counts as "on a dot"
const PROTRACTOR_R = 0.065;    // board metres
const PENCIL = '#161616';

function drawProtractor(size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2 - 2;
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#000';
  g.lineWidth = 4;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, r * 0.72, 0, Math.PI * 2); g.stroke();
  const ray = (deg, r0, r1, w, color) => {
    const a = (deg * Math.PI) / 180;
    g.strokeStyle = color; g.lineWidth = w;
    g.beginPath();
    g.moveTo(cx + r0 * Math.sin(a), cy - r0 * Math.cos(a));
    g.lineTo(cx + r1 * Math.sin(a), cy - r1 * Math.cos(a));
    g.stroke();
  };
  const text = (deg, rad, s, font, color) => {
    const a = (deg * Math.PI) / 180;
    g.save();
    g.translate(cx + rad * Math.sin(a), cy - rad * Math.cos(a));
    g.rotate(a);
    g.fillStyle = color; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(s, 0, 0);
    g.restore();
  };
  // Outer band: mils, ticks every 20, labels every 200 (in hundreds).
  for (let m = 0; m < 6400; m += 20) {
    const d = (m * 360) / 6400;
    const long = m % 100 === 0;
    ray(d, r * (long ? 0.9 : 0.95), r, long ? 3 : 1.6, '#000');
  }
  for (let m = 0; m < 6400; m += 200) text((m * 360) / 6400, r * 0.84, String(m / 100), 'bold 28px system-ui, sans-serif', '#000');
  // Inner band: degrees, ticks every 1, labels every 10.
  for (let d = 0; d < 360; d++) {
    const len = d % 10 === 0 ? 0.08 : d % 5 === 0 ? 0.055 : 0.03;
    ray(d, r * (0.72 - len), r * 0.72, d % 10 === 0 ? 3.2 : 1.8, '#b00000');
  }
  for (let d = 0; d < 360; d += 10) text(d, r * 0.57, String(d), 'bold 30px system-ui, sans-serif', '#b00000');
  // Crosshair, with grid north marked.
  g.strokeStyle = '#000'; g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(cx - r * 0.45, cy); g.lineTo(cx + r * 0.45, cy); g.moveTo(cx, cy - r * 0.45); g.lineTo(cx, cy + r * 0.45); g.stroke();
  text(0, r * 0.4, 'GN', 'bold 26px system-ui, sans-serif', '#111');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A measuring strip at map scale, like the scale edge of a GTA protractor: 0 to
// 1000 m, ticks every 10 m. It's laid along the last line drawn, zero on its first dot.
function makeRuler(site) {
  const metres = 1000;
  const groundPerBoard = boardScale(site);
  const len = metres / groundPerBoard;   // board metres for 1000 m on the ground
  const pad = 0.006;                     // paper past each end
  const W = 2048, H = 112;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,253,240,0.93)';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#000'; g.lineWidth = 2;
  g.strokeRect(1, 1, W - 2, H - 2);
  const px0 = (pad / (len + 2 * pad)) * W;
  const pxPerM = (len / (len + 2 * pad)) * W / metres;
  g.textAlign = 'center'; g.textBaseline = 'bottom';
  for (let m = 0; m <= metres; m += 10) {
    const x = px0 + m * pxPerM;
    const big = m % 100 === 0, mid = m % 50 === 0;
    g.strokeStyle = '#000';
    g.lineWidth = big ? 3 : 1.6;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, big ? 46 : mid ? 34 : 22); g.stroke();
    if (big) {
      g.fillStyle = '#000';
      g.font = 'bold 34px system-ui, sans-serif';
      g.fillText(String(m), x, H - 8);
    }
  }
  g.font = '24px system-ui, sans-serif';
  g.textAlign = 'right';
  g.fillText('metres', W - 12, H - 10);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const width = 0.016;
  // Local origin at the zero mark; the strip hangs below the line it measures.
  const geo = new THREE.PlaneGeometry(len + 2 * pad, width).translate((len + 2 * pad) / 2 - pad, -width / 2, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  mesh.name = 'ruler';
  mesh.visible = false;
  return mesh;
}

export class MapBoard {
  constructor(renderer, site, mapTexture, settings) {
    this.site = site;
    this.settings = settings;
    this.dots = [];          // { id, x, z } scene metres
    this.lines = [];         // { a, b } dot ids, drawn a -> b
    this.selected = null;    // dot id
    this.protractorDot = null;
    this.lastLine = null;
    this._nextId = 1;

    const group = new THREE.Group();
    group.name = 'map-board';
    this.group = group;
    const S = BOARD_SIZE_M;

    const backing = new THREE.Mesh(
      new THREE.BoxGeometry(S + 0.02, S + 0.02, 0.006),
      new THREE.MeshLambertMaterial({ color: 0x6b5236 }),
    );
    backing.position.z = -0.003;
    group.add(backing);

    mapTexture.colorSpace = THREE.SRGBColorSpace;
    mapTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    mapTexture.minFilter = THREE.LinearMipmapLinearFilter;
    mapTexture.generateMipmaps = true;
    mapTexture.needsUpdate = true;
    this.paper = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshBasicMaterial({ map: mapTexture }));
    this.paper.position.z = 0.0003;
    this.paper.name = 'map-paper';
    group.add(this.paper);

    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.width = this.overlayCanvas.height = OVERLAY_PX;
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    this.overlayTex = new THREE.CanvasTexture(this.overlayCanvas);
    this.overlayTex.colorSpace = THREE.SRGBColorSpace;
    this.overlayTex.anisotropy = mapTexture.anisotropy;
    const overlay = new THREE.Mesh(
      new THREE.PlaneGeometry(S, S),
      new THREE.MeshBasicMaterial({ map: this.overlayTex, transparent: true, depthWrite: false }),
    );
    overlay.position.z = 0.0006;
    group.add(overlay);

    this.protractor = new THREE.Mesh(
      new THREE.PlaneGeometry(PROTRACTOR_R * 2, PROTRACTOR_R * 2),
      new THREE.MeshBasicMaterial({ map: drawProtractor(), transparent: true, depthWrite: false }),
    );
    this.protractor.position.z = 0.0009;
    this.protractor.visible = false;
    group.add(this.protractor);

    this.ruler = makeRuler(site);
    this.ruler.position.z = 0.001;
    this.rulerLine = null;
    group.add(this.ruler);

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.0028, 0.0045, 24),
      new THREE.MeshBasicMaterial({ color: 0xd02020, depthWrite: false, transparent: true }),
    );
    this.cursor.position.z = 0.0012;
    this.cursor.visible = false;
    group.add(this.cursor);

    // "You are here": only when the user asks for it (the lost lifeline), briefly.
    const here = new THREE.Group();
    const red = new THREE.MeshBasicMaterial({ color: 0xe0161b, depthWrite: false, transparent: true });
    const arrow = new THREE.Shape();
    arrow.moveTo(0, 0.011); arrow.lineTo(0.0055, -0.005); arrow.lineTo(0, -0.002); arrow.lineTo(-0.0055, -0.005); arrow.closePath();
    here.add(new THREE.Mesh(new THREE.ShapeGeometry(arrow), red));
    here.add(new THREE.Mesh(new THREE.RingGeometry(0.013, 0.0155, 32), red));
    here.position.z = 0.0015;
    here.visible = false;
    here.name = 'you-are-here';
    this.here = here;
    group.add(here);

    this.redraw();
  }

  // Board-local point (metres from centre, x right, y up) where a ray hits the
  // paper, or null.
  hitTest(raycaster) {
    const hit = raycaster.intersectObject(this.paper, false)[0];
    if (!hit) return null;
    const p = this.paper.worldToLocal(hit.point.clone());
    return { bx: p.x, by: p.y, distance: hit.distance };
  }

  hover(local) {
    this.cursor.visible = !!local;
    if (local) this.cursor.position.set(local.bx, local.by, this.cursor.position.z);
  }

  boardOf(dot) {
    return sceneToBoard(this.site, dot.x, dot.z);
  }

  dotAt(local) {
    let best = null, bestD = DOT_PICK_M;
    for (const d of this.dots) {
      const b = this.boardOf(d);
      const dist = Math.hypot(b.bx - local.bx, b.by - local.by);
      if (dist <= bestD) { best = d; bestD = dist; }
    }
    return best;
  }

  // Trigger on the board. Empty paper: place a dot. On a dot: select it, or if
  // another dot is selected, draw a line from that one to this one.
  // Returns what happened, for haptics and tests.
  trigger(local) {
    const hit = this.dotAt(local);
    if (!hit) {
      const p = boardToScene(this.site, local.bx, local.by);
      if (!insideTerrain(this.site, p.x, p.z)) return null;
      this.dots.push({ id: this._nextId++, x: p.x, z: p.z });
      this.redraw();
      return 'dot';
    }
    if (this.selected === null || this.selected === hit.id) {
      this.selected = this.selected === hit.id ? null : hit.id;
      this.redraw();
      return this.selected ? 'select' : 'deselect';
    }
    const from = this.selected;
    const exists = this.lines.some((l) => (l.a === from && l.b === hit.id) || (l.a === hit.id && l.b === from));
    if (!exists) this.lines.push({ a: from, b: hit.id });
    this.lastLine = { a: from, b: hit.id };
    this.selected = null;
    this.redraw();
    return 'line';
  }

  // B on a dot: centre the protractor there, aligned to grid north. B elsewhere hides it.
  toggleProtractor(local) {
    const hit = local && this.dotAt(local);
    this.protractorDot = hit && this.protractorDot !== hit.id ? hit.id : null;
    this.placeProtractor();
    return this.protractorDot !== null;
  }

  // Erase a dot and the lines through it.
  erase(local) {
    const hit = this.dotAt(local);
    if (!hit) return false;
    this.dots = this.dots.filter((d) => d !== hit);
    this.lines = this.lines.filter((l) => l.a !== hit.id && l.b !== hit.id);
    if (this.selected === hit.id) this.selected = null;
    if (this.protractorDot === hit.id) this.protractorDot = null;
    if (this.lastLine && (this.lastLine.a === hit.id || this.lastLine.b === hit.id)) this.lastLine = null;
    this.placeProtractor();
    this.placeRuler();
    this.redraw();
    return true;
  }

  // Show the true position and facing (grid azimuth, degrees) on the map.
  showPosition(x, z, gridAzDeg) {
    const b = sceneToBoard(this.site, x, z);
    this.here.position.set(b.bx, b.by, this.here.position.z);
    // Board +y is grid north; turn the arrow clockwise by the azimuth.
    this.here.rotation.set(0, 0, -THREE.MathUtils.degToRad(gridAzDeg));
    this.here.visible = true;
  }

  hidePosition() {
    this.here.visible = false;
  }

  // Lay the strip along the last line drawn, or take it away.
  // Returns 'shown' | 'hidden' | 'no-line'.
  toggleRuler() {
    if (this.ruler.visible) {
      this.ruler.visible = false;
      this.rulerLine = null;
      return 'hidden';
    }
    if (!this.lastLine) return 'no-line';
    this.rulerLine = this.lastLine;
    this.placeRuler();
    return this.ruler.visible ? 'shown' : 'no-line';
  }

  placeRuler() {
    const l = this.rulerLine;
    const a = l && this.dots.find((d) => d.id === l.a);
    const b = l && this.dots.find((d) => d.id === l.b);
    this.ruler.visible = !!(a && b);
    if (!a || !b) { this.rulerLine = null; return; }
    const pa = this.boardOf(a), pb = this.boardOf(b);
    this.ruler.position.set(pa.bx, pa.by, this.ruler.position.z);
    this.ruler.rotation.set(0, 0, Math.atan2(pb.by - pa.by, pb.bx - pa.bx));
  }

  placeProtractor() {
    const d = this.dots.find((x) => x.id === this.protractorDot);
    this.protractor.visible = !!d;
    if (d) {
      const b = this.boardOf(d);
      this.protractor.position.set(b.bx, b.by, this.protractor.position.z);
    }
  }

  // Grid azimuth, magnetic azimuth and distance of a line, for assisted mode and tests.
  measure(line) {
    const a = this.dots.find((d) => d.id === line.a);
    const b = this.dots.find((d) => d.id === line.b);
    if (!a || !b) return null;
    const grid = gridAzimuth(b.x - a.x, b.z - a.z);
    return { grid, magnetic: gridToMagnetic(grid, this.site.gm_angle_deg), distance: horizontalDistance(a.x, a.z, b.x, b.z) };
  }

  redraw() {
    const g = this.overlayCtx;
    const k = OVERLAY_PX / this.site.map.px;
    g.clearRect(0, 0, OVERLAY_PX, OVERLAY_PX);
    const at = (d) => {
      const { px, py } = sceneToMapPx(this.site, d.x, d.z);
      return [px * k, py * k];
    };
    const byId = new Map(this.dots.map((d) => [d.id, d]));
    g.strokeStyle = PENCIL;
    g.lineWidth = 4.5;
    g.lineCap = 'round';
    for (const l of this.lines) {
      const a = byId.get(l.a), b = byId.get(l.b);
      if (!a || !b) continue;
      const [x0, y0] = at(a), [x1, y1] = at(b);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
    for (const d of this.dots) {
      const [x, y] = at(d);
      g.fillStyle = PENCIL;
      g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
      g.strokeStyle = PENCIL; g.lineWidth = 3.5;
      g.beginPath(); g.arc(x, y, 19, 0, Math.PI * 2); g.stroke();
      if (d.id === this.selected) {
        g.strokeStyle = '#1f5fd0'; g.lineWidth = 7;
        g.beginPath(); g.arc(x, y, 30, 0, Math.PI * 2); g.stroke();
      }
    }
    if (this.settings.assisted && this.lastLine) {
      const m = this.measure(this.lastLine);
      if (m) {
        const mils = this.settings.units === 'mils';
        const fmt = (az) => (mils ? `${Math.round(degToMils(az)) % 6400} mils` : `${az.toFixed(0).padStart(3, '0')}°`);
        const text = `ASSISTED  grid ${fmt(m.grid)}   mag ${fmt(m.magnetic)}   ${Math.round(m.distance)} m`;
        g.font = 'bold 30px system-ui, sans-serif';
        const w = g.measureText(text).width + 24;
        g.fillStyle = 'rgba(255,255,240,0.92)';
        g.fillRect(16, 10, w, 44);
        g.fillStyle = '#1f3f78';
        g.textBaseline = 'middle';
        g.fillText(text, 28, 33);
      }
    }
    this.overlayTex.needsUpdate = true;
  }

  clear() {
    this.dots = [];
    this.lines = [];
    this.selected = null;
    this.protractorDot = null;
    this.lastLine = null;
    this.rulerLine = null;
    this.ruler.visible = false;
    this.placeProtractor();
    this.redraw();
  }
}

export function loadMapTexture(baseUrl) {
  return new THREE.TextureLoader().loadAsync(`${baseUrl}/map.png`);
}
