// Map board (spec section 7.2): map.png on a 40 cm board, with pencil dots, lines
// and a protractor. Marks are stored in scene metres so later milestones (AAR,
// scoring) can use them. The board never shows where you are.
import * as THREE from 'three';
import { BOARD_SIZE_M, boardToScene, insideTerrain, sceneToBoard, sceneToMapPx } from './map-math.js';
import { gridAzimuth, gridToMagnetic, degToMils, horizontalDistance } from './coords.js';

const OVERLAY_PX = 2048;
const DOT_PICK_M = 0.006;      // board metres: how close counts as "on a dot"
const PROTRACTOR_R = 0.065;    // board metres
const PENCIL = '#2b2b2b';

function drawProtractor(size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2 - 2;
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(20,20,20,0.9)';
  g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
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
    ray(d, r * (long ? 0.9 : 0.95), r, long ? 2 : 1, '#111');
  }
  for (let m = 0; m < 6400; m += 200) text((m * 360) / 6400, r * 0.84, String(m / 100), 'bold 22px system-ui, sans-serif', '#111');
  // Inner band: degrees, ticks every 1, labels every 10.
  for (let d = 0; d < 360; d++) {
    const len = d % 10 === 0 ? 0.08 : d % 5 === 0 ? 0.055 : 0.03;
    ray(d, r * (0.72 - len), r * 0.72, d % 10 === 0 ? 2.2 : 1.2, '#a01818');
  }
  for (let d = 0; d < 360; d += 10) text(d, r * 0.57, String(d), 'bold 24px system-ui, sans-serif', '#a01818');
  // Crosshair, with grid north marked.
  g.strokeStyle = 'rgba(20,20,20,0.75)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(cx - r * 0.45, cy); g.lineTo(cx + r * 0.45, cy); g.moveTo(cx, cy - r * 0.45); g.lineTo(cx, cy + r * 0.45); g.stroke();
  text(0, r * 0.4, 'GN', 'bold 26px system-ui, sans-serif', '#111');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.0018, 0.003, 20),
      new THREE.MeshBasicMaterial({ color: 0xd02020, depthWrite: false, transparent: true }),
    );
    this.cursor.position.z = 0.0012;
    this.cursor.visible = false;
    group.add(this.cursor);

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
    this.redraw();
    return true;
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
    g.lineWidth = 2.2;
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
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
      g.strokeStyle = PENCIL; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke();
      if (d.id === this.selected) {
        g.strokeStyle = '#1f5fd0'; g.lineWidth = 4;
        g.beginPath(); g.arc(x, y, 22, 0, Math.PI * 2); g.stroke();
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
    this.placeProtractor();
    this.redraw();
  }
}

export function loadMapTexture(baseUrl) {
  return new THREE.TextureLoader().loadAsync(`${baseUrl}/map.png`);
}
