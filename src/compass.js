// Lensatic compass (spec section 7.1).
//
// Local frame: -Z is the sighting axis (cover and wire at the far end), +Y is the
// face normal, +X is right. The dial card floats inside and turns so its north
// points to magnetic north; the number under the fixed index line at the far edge
// is the magnetic azimuth of the sighting axis. The lens at the near end shows the
// card's graduations around the index, as the real lens does.
import * as THREE from 'three';
import { compassHeading, DialDamper, BEZEL_CLICK_DEG } from './compass-math.js';
import { degToMils, normalizeDeg } from './coords.js';

const R = 0.042;          // dial card radius, metres (a little larger than real, for legibility)
const HOUSING_R = R + 0.007;
const H = 0.012;          // housing height
const OLIVE = 0x4a5232;
const RED = '#c0261d';
const INK = '#151515';
const LUME = 0xb8ffb0;

function drawDial(size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2;
  g.fillStyle = '#efe9d8';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  const at = (deg, rad) => {
    const a = (deg * Math.PI) / 180;
    return [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  };
  const tick = (deg, r0, r1, w, color) => {
    const [x0, y0] = at(deg, r0), [x1, y1] = at(deg, r1);
    g.strokeStyle = color; g.lineWidth = w;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  };
  const label = (deg, rad, text, font, color) => {
    const [x, y] = at(deg, rad);
    g.save();
    g.translate(x, y);
    g.rotate((deg * Math.PI) / 180);
    g.fillStyle = color; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 0, 0);
    g.restore();
  };

  // Outer ring: mils in black. Ticks every 20, longer every 100, labels every 400 (hundreds).
  for (let m = 0; m < 6400; m += 20) {
    const d = (m * 360) / 6400;
    const long = m % 100 === 0;
    tick(d, r * (long ? 0.88 : 0.93), r * 0.985, long ? 3 : 1.6, INK);
  }
  for (let m = 0; m < 6400; m += 400) label((m * 360) / 6400, r * 0.8, String(m / 100), 'bold 46px system-ui, sans-serif', INK);

  // Inner ring: degrees in red. Ticks every 5, longer every 10, labels every 30.
  for (let d = 0; d < 360; d += 5) {
    const long = d % 10 === 0;
    tick(d, r * (long ? 0.6 : 0.64), r * 0.7, long ? 4 : 2.4, RED);
  }
  for (let d = 0; d < 360; d += 30) {
    if (d % 90 === 0) continue;
    label(d, r * 0.53, String(d), 'bold 50px system-ui, sans-serif', RED);
  }
  label(90, r * 0.5, 'E', 'bold 64px system-ui, sans-serif', INK);
  label(180, r * 0.5, 'S', 'bold 64px system-ui, sans-serif', INK);
  label(270, r * 0.5, 'W', 'bold 64px system-ui, sans-serif', INK);

  // Luminous north arrow.
  g.fillStyle = '#62b85a';
  g.strokeStyle = INK; g.lineWidth = 3;
  g.beginPath();
  g.moveTo(cx, cy - r * 0.55);
  g.lineTo(cx - r * 0.09, cy - r * 0.3);
  g.lineTo(cx + r * 0.09, cy - r * 0.3);
  g.closePath(); g.fill(); g.stroke();
  g.fillStyle = INK;
  g.beginPath(); g.arc(cx, cy, r * 0.03, 0, Math.PI * 2); g.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function lumeBox(w, h, d) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: LUME }));
}

export class Compass {
  constructor(settings, site, renderer) {
    this.settings = settings;
    this.gm = site.gm_angle_deg;
    this.damper = new DialDamper();
    this.bezelDeg = 0;
    this.heading = { grid: null, magnetic: null, tilt: 0 };
    this.stuck = false;
    this.lastTarget = null;
    this._lens = { key: '' };

    const g = new THREE.Group();
    g.name = 'compass';
    this.group = g;
    const olive = new THREE.MeshLambertMaterial({ color: OLIVE });

    // Housing.
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(HOUSING_R, HOUSING_R * 1.02, H, 48), olive);
    housing.position.y = -H / 2;
    g.add(housing);

    // Dial card (floats, rotates about +Y).
    const dialTex = drawDial();
    dialTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.card = new THREE.Mesh(
      new THREE.CircleGeometry(R, 72).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: dialTex }),
    );
    this.card.position.y = 0.0006;
    g.add(this.card);

    // Fixed black index line across the far edge of the card, plus a luminous dot.
    const index = new THREE.Mesh(new THREE.BoxGeometry(0.0007, 0.0003, R * 0.42), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    index.position.set(0, 0.0016, -R * 0.79);
    g.add(index);
    const indexDot = lumeBox(0.002, 0.0006, 0.002);
    indexDot.position.set(0, 0.0018, -R * 1.04);
    g.add(indexDot);

    // Bezel ring with its luminous line. Rotates in 3 degree clicks.
    this.bezel = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(R + 0.0005, HOUSING_R, 60).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x2a2f1f }),
    );
    ring.position.y = 0.0012;
    this.bezel.add(ring);
    const bezelLine = lumeBox(0.0012, 0.0008, HOUSING_R - R + 0.004);
    bezelLine.position.set(0, 0.0018, -(R + HOUSING_R) / 2);
    this.bezel.add(bezelLine);
    g.add(this.bezel);

    // Cover at the far end, standing up, with the sighting wire.
    const cover = new THREE.Group();
    cover.position.set(0, 0, -HOUSING_R);
    const coverH = 0.06, coverW = 0.05, bar = 0.005;
    for (const x of [-coverW / 2 + bar / 2, coverW / 2 - bar / 2]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(bar, coverH, 0.002), olive);
      side.position.set(x, coverH / 2, 0);
      cover.add(side);
    }
    const top = new THREE.Mesh(new THREE.BoxGeometry(coverW, bar, 0.002), olive);
    top.position.set(0, coverH - bar / 2, 0);
    cover.add(top);
    const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.00035, 0.00035, coverH - bar, 6), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    wire.position.set(0, (coverH - bar) / 2, 0);
    cover.add(wire);
    g.add(cover);

    // Rear sight with its slot, and the lens just behind it.
    const rear = new THREE.Group();
    rear.position.set(0, 0, HOUSING_R + 0.004);
    for (const x of [-0.006, 0.006]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.028, 0.002), olive);
      post.position.set(x, 0.014, 0);
      rear.add(post);
    }
    g.add(rear);

    const lensCanvas = document.createElement('canvas');
    lensCanvas.width = 512; lensCanvas.height = 160;
    this._lens.canvas = lensCanvas;
    this._lens.ctx = lensCanvas.getContext('2d');
    this._lens.tex = new THREE.CanvasTexture(lensCanvas);
    this._lens.tex.colorSpace = THREE.SRGBColorSpace;
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.0156), new THREE.MeshBasicMaterial({ map: this._lens.tex }));
    lens.position.set(0, 0.012, HOUSING_R + 0.016);
    lens.rotation.x = -0.75; // tipped back toward the eye
    lens.name = 'compass-lens';
    g.add(lens);
    const lensFrame = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.019, 0.002), olive);
    lensFrame.position.copy(lens.position);
    lensFrame.rotation.copy(lens.rotation);
    lensFrame.translateZ(-0.0013);
    g.add(lensFrame);

    this.drawLens(0);
  }

  // Rotate the bezel by whole clicks (positive is clockwise from above).
  clickBezel(clicks) {
    this.bezelDeg = normalizeDeg(this.bezelDeg + clicks * BEZEL_CLICK_DEG);
    this.bezel.rotation.y = -THREE.MathUtils.degToRad(this.bezelDeg);
  }

  // Call each frame while the compass is out, after its world matrix is current.
  update(dt) {
    const e = this.group.matrixWorld.elements;
    // Columns of the world matrix: Y is the face normal, -Z the sighting axis.
    const up = { x: e[4], y: e[5], z: e[6] };
    const fwd = { x: -e[8], y: -e[9], z: -e[10] };
    this.heading = compassHeading(fwd, up, this.gm);
    const s = this.settings;
    this.stuck = s.compassTiltSticks && this.heading.tilt > s.compassTiltLimit;
    // A tilted card binds against the housing and turns with it: keep the last target.
    if (!this.stuck && this.heading.magnetic !== null) this.lastTarget = this.heading.magnetic;
    if (this.lastTarget === null) return;
    const reading = this.damper.update(this.lastTarget, dt);
    this.card.rotation.y = THREE.MathUtils.degToRad(reading);
    this.drawLens(reading);
  }

  // The number under the index line, as the user would read it.
  get dialReading() {
    return this.damper.reading;
  }

  drawLens(reading) {
    const units = this.settings.units;
    const key = `${reading.toFixed(1)}|${units}`;
    if (key === this._lens.key) return;
    this._lens.key = key;
    const { ctx: g, canvas: c, tex } = this._lens;
    const W = c.width, Hh = c.height, mid = W / 2;
    g.fillStyle = '#efe9d8';
    g.fillRect(0, 0, W, Hh);
    const pxPerDeg = 15;
    const mils = units === 'mils';
    const step = mils ? 360 / 6400 * 10 : 1;          // tick every 1 deg or 10 mils
    const span = W / 2 / pxPerDeg + 2;
    const first = Math.ceil((reading - span) / step) * step;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let d = first; d <= reading + span; d += step) {
      const x = mid + (d - reading) * pxPerDeg;
      const n = Math.round(mils ? degToMils(normalizeDeg(d)) : normalizeDeg(d));
      const unit = mils ? n % 6400 : n % 360;
      const major = mils ? unit % 100 === 0 : unit % 10 === 0;
      const mid5 = mils ? unit % 50 === 0 : unit % 5 === 0;
      g.strokeStyle = mils ? INK : RED;
      g.lineWidth = major ? 3 : 2;
      const len = major ? 52 : mid5 ? 38 : 24;
      g.beginPath(); g.moveTo(x, Hh - 8); g.lineTo(x, Hh - 8 - len); g.stroke();
      if (major) {
        g.fillStyle = mils ? INK : RED;
        g.font = 'bold 44px system-ui, sans-serif';
        g.fillText(String(unit), x, 10);
      }
    }
    // Fixed hairline at the index.
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(mid, 0); g.lineTo(mid, Hh); g.stroke();
    tex.needsUpdate = true;
  }
}
