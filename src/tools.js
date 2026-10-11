// The hand tools: compass (right hand) and map board (left hand), for desktop and VR
// (spec sections 7.1, 7.2 and 7.5).
import * as THREE from 'three';
import { Compass } from './compass.js';
import { MapBoard } from './map.js';

const RAY_COLOR = 0xd02020;
const MAP_FAR = 0.5;   // desktop board distance, zoomed out (metres)
const MAP_NEAR = 0.16; // zoomed all the way in

export class Tools {
  constructor({ renderer, camera, site, mapTexture, settings }) {
    this.renderer = renderer;
    this.camera = camera;
    this.settings = settings;
    this.compass = new Compass(settings, site, renderer);
    this.map = new MapBoard(renderer, site, mapTexture, settings);
    this.compass.group.visible = false;
    this.map.group.visible = false;

    // Desktop state.
    this.desktopMap = false;
    this.desktopCompass = false;
    this.pointer = null; // NDC of the mouse while the map is up
    this.mapDistance = MAP_FAR; // desktop zoom: how far in front of the camera the board sits
    this.hovered = null; // board-local point under the pointer or ray

    // XR state.
    this.hands = { left: {}, right: {} }; // { grip, ray, body }
    this.trigger = null;  // pending press on a dot: { local, t }
    this.bezelRepeat = null; // seconds to the next repeat click, null when not pushed
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = settings.pencilRayLength;

    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    this.rayLine = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: RAY_COLOR }));
    this.rayLine.visible = false;
  }

  // ---- XR controller wiring (called from 'connected' events) ----

  attach(hand, { grip, ray, body }) {
    const h = this.hands[hand];
    if (grip) h.grip = grip;
    if (ray) h.ray = ray;
    if (body) h.body = body;
    if (hand === 'right' && ray && !this.rayLine.parent) ray.add(this.rayLine);
  }

  // Put a tool in a hand, or in front of the desktop camera.
  mountCompassInHand() {
    const ray = this.hands.right.ray;
    if (!ray || this.compass.group.parent === ray) return;
    ray.add(this.compass.group);
    this.compass.group.position.set(0, this.settings.compassOffsetY, this.settings.compassOffsetZ);
    this.compass.group.rotation.set(0, 0, 0);
  }

  mountMapInHand() {
    const grip = this.hands.left.grip;
    if (!grip || this.map.group.parent === grip) return;
    grip.add(this.map.group);
    this.map.group.position.set(0, this.settings.mapOffsetY, this.settings.mapOffsetZ);
    this.map.group.rotation.set(-THREE.MathUtils.degToRad(this.settings.mapTiltDeg), 0, 0);
  }

  mountDesktop() {
    const both = this.desktopMap && this.desktopCompass;
    if (this.desktopMap) {
      this.camera.add(this.map.group);
      this.mapDistance = MAP_FAR;
      this.map.group.position.set(both ? -0.1 : 0, -0.02, -MAP_FAR);
      this.map.group.rotation.set(0, 0, 0);
    }
    if (this.desktopCompass) {
      this.camera.add(this.compass.group);
      this.compass.group.position.set(both ? 0.16 : 0, -0.11, -0.27);
    }
    this.map.group.visible = this.desktopMap;
    this.compass.group.visible = this.desktopCompass;
  }

  // ---- Desktop ----

  toggleDesktopMap() {
    this.desktopMap = !this.desktopMap;
    if (!this.desktopMap) { this.pointer = null; this.setHover(null); }
    this.mountDesktop();
    return this.desktopMap;
  }

  toggleDesktopCompass() {
    this.desktopCompass = !this.desktopCompass;
    this.mountDesktop();
    return this.desktopCompass;
  }

  // In VR the pencil works only with the compass put away: the right hand holds one
  // or the other (spec 7.2). On desktop the mouse is free, so it always works.
  get pencilReady() {
    return this.map.group.visible && (this.desktopMap || !this.compass.group.visible);
  }

  setHover(local) {
    this.hovered = local;
    this.map.hover(local);
  }

  // Raycast the pointer now, rather than trusting the last frame's hover: the mouse
  // can move and click between frames.
  refreshDesktopHover() {
    if (!this.pencilReady || !this.pointer) return;
    this.camera.updateMatrixWorld(true);
    this.map.group.updateMatrixWorld(true);
    this.raycaster.far = Infinity;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.setHover(this.map.hitTest(this.raycaster));
  }

  // Returns what happened, so the page can say so:
  // 'dot' | 'select' | 'deselect' | 'line' | 'outside' | 'miss'
  // | 'protractor' | 'protractor-off' | 'protractor-miss' | null
  desktopClick(button) {
    this.refreshDesktopHover();
    if (!this.pencilReady) return null;
    if (!this.hovered) return 'miss';
    if (button === 0) return this.map.trigger(this.hovered) ?? 'outside';
    if (button === 2) {
      if (!this.map.dotAt(this.hovered)) {
        this.map.toggleProtractor(null);
        return 'protractor-miss';
      }
      return this.map.toggleProtractor(this.hovered) ? 'protractor' : 'protractor-off';
    }
    return null;
  }

  desktopErase() {
    this.refreshDesktopHover();
    return this.pencilReady && this.hovered ? this.map.erase(this.hovered) : false;
  }

  // Wheel: bezel clicks while the compass is out, otherwise zoom the map toward the cursor.
  desktopWheel(deltaY) {
    if (this.compass.group.visible) {
      this.compass.clickBezel(deltaY > 0 ? 1 : -1);
      return;
    }
    if (!this.desktopMap) return;
    const g = this.map.group;
    const old = this.mapDistance;
    const d = THREE.MathUtils.clamp(old * (deltaY > 0 ? 1.15 : 1 / 1.15), MAP_NEAR, MAP_FAR);
    if (d === old) return;
    if (d >= MAP_FAR - 1e-6) {
      this.mountDesktop();
      return;
    }
    // Keep the board point under the cursor fixed. The board faces the camera, so a
    // cursor ray (rx, ry, -1) meets it at (rx*d, ry*d).
    const p = this.pointer ?? new THREE.Vector2();
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const rx = p.x * t * this.camera.aspect, ry = p.y * t;
    const lx = rx * old - g.position.x, ly = ry * old - g.position.y;
    g.position.set(rx * d - lx, ry * d - ly, -d);
    this.mapDistance = d;
  }

  updateDesktop(dt, pitch) {
    if (this.compass.group.visible) {
      // Keep the compass level whatever the camera pitch: its heading is the camera's yaw.
      this.compass.group.rotation.set(-pitch, 0, 0);
      this.compass.group.updateMatrixWorld(true);
      this.compass.update(dt);
    }
    if (this.pencilReady && this.pointer) {
      this.refreshDesktopHover();
    } else if (this.hovered) {
      this.setHover(null);
    }
  }

  // ---- VR ----

  // Returns true while the compass is in hand (the right stick belongs to the bezel then).
  updateXR(dt, xr) {
    const mapHeld = xr.isDown('left', 'grip');
    const compassHeld = xr.isDown('right', 'grip');
    if (mapHeld) this.mountMapInHand();
    if (compassHeld) this.mountCompassInHand();
    this.map.group.visible = mapHeld && this.map.group.parent === this.hands.left.grip;
    this.compass.group.visible = compassHeld && this.compass.group.parent === this.hands.right.ray;
    if (this.hands.right.body) this.hands.right.body.visible = !this.compass.group.visible;

    if (this.compass.group.visible) {
      this.compass.group.updateMatrixWorld(true);
      this.compass.update(dt);
      this.updateBezel(dt, xr);
    }

    // Pencil ray from the right controller onto the board.
    let local = null;
    if (this.pencilReady && this.hands.right.ray) {
      const ray = this.hands.right.ray;
      ray.updateMatrixWorld(true);
      this.map.group.updateMatrixWorld(true);
      const origin = new THREE.Vector3().setFromMatrixPosition(ray.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(ray.matrixWorld);
      this.raycaster.set(origin, dir);
      this.raycaster.far = this.settings.pencilRayLength;
      local = this.map.hitTest(this.raycaster);
      this.rayLine.visible = true;
      this.rayLine.scale.z = local ? local.distance : this.settings.pencilRayLength;
    } else {
      this.rayLine.visible = false;
    }
    this.setHover(local);

    if (this.pencilReady) this.updatePencil(xr, local);
    else this.trigger = null;
    return this.compass.group.visible;
  }

  updatePencil(xr, local) {
    const now = performance.now() / 1000;
    if (xr.justPressed('right', 'trigger') && local) {
      if (this.map.dotAt(local)) {
        // Wait: a short press selects or draws a line, a long press erases.
        this.trigger = { local, t: now };
      } else if (this.map.trigger(local)) {
        xr.pulse('right', 0.35, 15);
      }
    }
    if (this.trigger) {
      // Release first: a long press means still held when the threshold passes, so a
      // late frame after a quick tap must not count as one.
      if (!xr.isDown('right', 'trigger')) {
        if (this.map.trigger(this.trigger.local)) xr.pulse('right', 0.35, 15);
        this.trigger = null;
      } else if (now - this.trigger.t >= this.settings.eraseHoldSec) {
        if (this.map.erase(this.trigger.local)) xr.pulse('right', 0.7, 40);
        this.trigger = null;
      }
    }
    if (xr.justPressed('right', 'secondary')) this.map.toggleProtractor(local);
  }

  updateBezel(dt, xr) {
    const x = xr.stick('right').x;
    if (Math.abs(x) < 0.5) {
      this.bezelRepeat = null;
      return;
    }
    // One click on the push, then repeats after a short pause while held.
    if (this.bezelRepeat === null) this.bezelRepeat = 0;
    else this.bezelRepeat -= dt;
    if (this.bezelRepeat <= 0) {
      const first = this.bezelRepeat === 0;
      this.compass.clickBezel(x > 0 ? 1 : -1);
      xr.pulse('right', 0.25, 8);
      this.bezelRepeat = this.settings.bezelRepeatSec * (first ? 2 : 1);
    }
  }
}
