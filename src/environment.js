// The sky, sun and light for the site's real place and time: the sun where it
// really is, colours that run from noon through dusk to night, stars after dark,
// and shadows near the viewer. Weather (weather.js) dims and greys it.
import * as THREE from 'three';
import { createSky } from './sky.js';
import { solarPosition, skyState, sceneDirection, siderealDeg, guessUtcOffsetMin } from './sun-logic.js';

const SHADOW_HALF_M = 45;   // the shadow map covers this far around you
const SHADOW_MAP = 2048;

export class Environment {
  constructor(scene, renderer, site) {
    this.site = site;
    this.renderer = renderer;
    this.sky = createSky();
    scene.add(this.sky.mesh);
    // Sky light plus warm bounce from the ground, so tree undersides and trunks aren't black.
    this.hemi = new THREE.HemisphereLight(0xdfe9f3, 0x6b6250, 0.95);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.sun.name = 'sun';
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_HALF_M;
    cam.right = cam.top = SHADOW_HALF_M;
    cam.near = 1;
    cam.far = 600;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
    this.offsetMin = guessUtcOffsetMin(site?.center_lon ?? -77, new Date());
    this.state = skyState(30);
    this.elevation = 30;
    this.azimuth = 180;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    // Weather's say: cloud cover 0..1, how much it darkens, cloud colour.
    this.weather = { cloud: 0, gloom: 0 };
    this.shadows = false;
    this.hemiBase = this.hemi.intensity;
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._inv = new THREE.Matrix4();
    this.horizon = new THREE.Color();
  }

  // Work out the sun for `date` and colour everything to match. forceNight: a
  // night course or N; the sun is put well below the horizon.
  setTime(date, { forceNight = false } = {}) {
    const lat = this.site?.center_lat ?? 38.9, lon = this.site?.center_lon ?? -77;
    const p = solarPosition(date, lat, lon);
    this.date = date;
    this.azimuth = p.azimuth;
    this.elevation = forceNight ? Math.min(p.elevation, -20) : p.elevation;
    const s = skyState(this.elevation);
    this.state = s;
    const conv = this.site?.convergence_deg ?? 0;
    // At night the sun's direction is meaningless; keep the light pointing down so
    // nothing odd happens if its intensity isn't quite zero.
    const d = sceneDirection(p.azimuth, Math.max(this.elevation, 2), conv);
    this.sunDir.set(d.x, d.y, d.z);

    const w = this.weather;
    const grey = Math.min(1, w.cloud * 0.85 + w.gloom);
    const u = this.sky.uniforms;
    const toColor = (out, rgb) => out.setRGB(rgb[0], rgb[1], rgb[2]);
    toColor(u.top.value, s.sky.top);
    toColor(u.horizon.value, s.sky.horizon);
    toColor(u.ground.value, s.sky.ground);
    // Overcast: the whole sky goes toward one flat grey, as bright as the light allows.
    const day = THREE.MathUtils.smoothstep(this.elevation, -8, 10);
    const overcast = new THREE.Color().setRGB(0.42, 0.45, 0.5).multiplyScalar(0.08 + 0.92 * day).multiplyScalar(1 - 0.45 * w.gloom);
    u.top.value.lerp(overcast, grey);
    u.horizon.value.lerp(overcast.clone().multiplyScalar(1.12), grey);
    u.sunDir.value.copy(this.sunDir);
    if (this.elevation < 2) u.sunDir.value.set(d.x, Math.sin(THREE.MathUtils.degToRad(this.elevation)), d.z).normalize();
    toColor(u.sunColor.value, s.sunColor);
    u.sunDisc.value = (1 - THREE.MathUtils.smoothstep(w.cloud, 0.55, 0.9)) * (forceNight ? 0 : 1);
    u.sunset.value = (1 - THREE.MathUtils.smoothstep(Math.abs(this.elevation - 1), 0, 10)) * (1 - grey);
    u.cloud.value = w.cloud;
    u.cloudColor.value.setRGB(0.78, 0.8, 0.84).multiplyScalar(0.06 + 0.94 * day).multiplyScalar(1 - 0.55 * w.gloom);
    this.horizon.copy(u.horizon.value);

    // Light: cloud takes the sun away and leaves a soft, flat sky light.
    toColor(this.sun.color, s.sunColor);
    this.sun.intensity = s.sunIntensity * (1 - 0.9 * THREE.MathUtils.smoothstep(w.cloud, 0.3, 0.95)) * (1 - w.gloom * 0.6);
    this.hemi.intensity = s.hemiIntensity * (1 + 0.25 * grey) * (1 - w.gloom * 0.5);
    this.hemi.color.setHex(s.dark ? 0x8a9cc8 : 0xdfe9f3);
    this.hemiBase = this.hemi.intensity;

    const northGrid = sceneDirection(0, 0, conv);
    this.sky.setStars(s.stars * (1 - grey), lat, northGrid, siderealDeg(date, lon));
    this.updateShadowSwitch();
  }

  get dark() {
    return this.state.dark;
  }

  setShadows(on) {
    this.shadows = on;
    this.updateShadowSwitch();
  }

  // Shadows only while the sun is up and strong enough to cast them.
  updateShadowSwitch() {
    const want = this.shadows && this.sun.intensity > 0.5;
    if (want === this.sun.castShadow) return;
    this.sun.castShadow = want;
    if (!this.renderer.shadowMap.enabled && want) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
    }
  }

  // Every frame: the sky and the shadow box follow the viewer. The box moves in
  // whole shadow-map texels so shadow edges don't crawl as you walk.
  follow(head) {
    this.sky.mesh.position.copy(head);
    const L = this.sun;
    const texel = (2 * SHADOW_HALF_M) / SHADOW_MAP;
    // Light space: looking down the sun's rays.
    this._m.lookAt(this.sunDir, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
    this._inv.copy(this._m).invert();
    const v = this._v.copy(head).applyMatrix4(this._inv);
    v.x = Math.round(v.x / texel) * texel;
    v.y = Math.round(v.y / texel) * texel;
    v.applyMatrix4(this._m);
    L.target.position.copy(v);
    L.position.copy(v).addScaledVector(this.sunDir, 300);
    L.target.updateMatrixWorld();
  }
}

// Mark what casts and receives shadows. Call after building each part of the world.
export function castShadows(root, { cast = true, receive = false } = {}) {
  root?.traverse((o) => {
    if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; }
  });
}
