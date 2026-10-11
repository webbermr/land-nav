// Night (spec 5.4): a dark scene, a red headlamp, luminous compass markings, and
// stakes you only see within 10 m.
//
// Things you read (map, compass dial and lens, score card, stake placards) are
// unlit materials, so a light can't reach them. At night they are tinted instead:
// red while the headlamp is on, almost black while it's off. Luminous parts are
// tagged userData.lume and keep glowing.
import * as THREE from 'three';

export const NIGHT_SKY = Object.freeze({
  top: new THREE.Color(0x03050a),
  horizon: new THREE.Color(0x0a0e16),
  ground: new THREE.Color(0x040505),
});

// Paper under a red light: reds wash out, everything else goes red-black. That is
// why red map symbols are hard to read by red light, here as in the field.
// Linear values: 0.004 shows as about 5% grey on screen, 0.07 as about 30%.
export const RED_LIGHT = new THREE.Color(0.85, 0.07, 0.045);
export const NO_LIGHT = new THREE.Color(0.003, 0.0035, 0.0045);
const WHITE = new THREE.Color(1, 1, 1);

// Multiply every unlit (MeshBasicMaterial) colour under root by `tint`, remembering
// the day colour so it can be put back. Pass null to restore.
export function tintUnlit(root, tint) {
  root?.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m?.isMeshBasicMaterial || m.userData.lume) continue;
      if (!m.userData.dayColor) m.userData.dayColor = m.color.clone();
      m.color.copy(m.userData.dayColor).multiply(tint || WHITE);
    }
  });
}

// A red headlamp: a spotlight that rides the camera. It always exists (intensity 0
// when off) so turning it on doesn't make every material recompile.
export function createHeadlamp(camera) {
  const lamp = new THREE.SpotLight(0xff3020, 0, 35, 0.5, 0.45, 1.6);
  lamp.name = 'headlamp';
  lamp.position.set(0, 0.05, 0);
  lamp.target.position.set(0, -0.35, -1); // a little below eye level, where you walk
  camera.add(lamp, lamp.target);
  return lamp;
}

export const HEADLAMP_INTENSITY = 18;
