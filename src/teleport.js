// Teleport visuals (Explore mode): a dotted arc from the controller, a ring where
// you'd land (green: you can; red: you can't), and a short fade to black around
// the jump so it doesn't feel like being yanked. The arc itself is traced in
// teleport-logic.js.
import * as THREE from 'three';
import { traceArc } from './teleport-logic.js';

const MAX_DOTS = 400;

// A soft round dot, so the arc isn't drawn in squares.
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(16, 16, 14, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
}
const OK = new THREE.Color(0x7ee08a), BAD = new THREE.Color(0xff5a4f);

export class Teleporter {
  constructor(scene, camera) {
    const pos = new Float32Array(MAX_DOTS * 3);
    this.dotsGeo = new THREE.BufferGeometry();
    this.dotsGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.dotsMat = new THREE.PointsMaterial({
      color: OK, size: 0.07, sizeAttenuation: true, depthWrite: false, transparent: true, opacity: 0.9,
      map: dotTexture(), alphaTest: 0.5,
    });
    this.dots = new THREE.Points(this.dotsGeo, this.dotsMat);
    this.dots.frustumCulled = false;
    this.dots.visible = false;
    this.dots.name = 'teleport-arc';

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.42, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.ring.visible = false;
    this.ring.name = 'teleport-ring';
    scene.add(this.dots, this.ring);

    // Fade: a black card just in front of the eyes.
    this.fadeMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    );
    this.fadeMesh.position.z = -0.12;
    this.fadeMesh.renderOrder = 999;
    this.fadeMesh.visible = false;
    camera.add(this.fadeMesh);
    this.fadeState = null; // { t, half, onMid, done }
    this.target = null;
  }

  // Show the arc from `origin` along `dir` (unit Vector3s). Returns the landing
  // point if it's a valid one, else null.
  aim(origin, dir, { range, heightAt, size }) {
    const r = traceArc(origin, dir, { range, heightAt, size, maxPoints: MAX_DOTS - 1 });
    const n = Math.min(r.points.length, MAX_DOTS);
    const pos = this.dotsGeo.attributes.position.array;
    for (let i = 0; i < n; i++) { pos[i * 3] = r.points[i].x; pos[i * 3 + 1] = r.points[i].y; pos[i * 3 + 2] = r.points[i].z; }
    this.dotsGeo.setDrawRange(0, n);
    this.dotsGeo.attributes.position.needsUpdate = true;
    const color = r.valid ? OK : BAD;
    this.dotsMat.color.copy(color);
    this.ring.material.color.copy(color);
    this.dots.visible = true;
    this.ring.visible = !!r.hit;
    if (r.hit) this.ring.position.set(r.hit.x, r.hit.y + 0.05, r.hit.z);
    this.target = r.valid ? r.hit : null;
    return this.target;
  }

  hide() {
    this.dots.visible = this.ring.visible = false;
    this.target = null;
  }

  get fading() {
    return !!this.fadeState;
  }

  // Fade out, call onMid() (do the jump) at black, fade back in.
  jump(onMid, seconds = 0.2) {
    if (this.fadeState) return;
    this.fadeState = { t: 0, half: Math.max(0.01, seconds / 2), onMid, done: false };
    this.fadeMesh.visible = true;
  }

  // Call every frame.
  tick(dt) {
    const f = this.fadeState;
    if (!f) return;
    f.t += dt;
    if (!f.done && f.t >= f.half) { f.done = true; f.onMid(); }
    const k = f.t < f.half ? f.t / f.half : Math.max(0, 2 - f.t / f.half);
    this.fadeMesh.material.opacity = Math.min(1, k);
    if (f.t >= 2 * f.half) { this.fadeState = null; this.fadeMesh.visible = false; this.fadeMesh.material.opacity = 0; }
  }
}
