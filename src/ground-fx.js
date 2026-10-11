// What weather and season do to the ground: wet ground goes darker, snow lies on
// the flatter ground, winter grass goes straw-coloured, and the far forest canopy
// changes colour with the leaves. Shared uniforms, patched into the ground
// materials of the terrain and the roads and trails.
import * as THREE from 'three';

export const GROUND_FX = {
  wet: { value: 0 },
  snow: { value: 0 },
  dormant: { value: 0 },
  canopyColor: { value: new THREE.Color(0x3d5428) },
};

const CANOPY = {
  summer: new THREE.Color(0x3d5428),
  autumn: new THREE.Color(0x76582a),
  bare: new THREE.Color(0x5a534b),
  spring: new THREE.Color(0x587a30),
};

// phen: { leaf, autumn, spring } (weather-logic phenology); fx: weatherEffects().
export function setGroundFx(phen, fx) {
  GROUND_FX.wet.value = fx.wet;
  GROUND_FX.snow.value = fx.snowCover;
  GROUND_FX.dormant.value = 1 - Math.min(1, phen.leaf * 1.4);
  const c = GROUND_FX.canopyColor.value.copy(CANOPY.summer);
  c.lerp(CANOPY.spring, phen.spring * 0.7);
  c.lerp(CANOPY.autumn, phen.autumn * phen.leaf);
  c.lerp(CANOPY.bare, 1 - phen.leaf);
  // Snow shows through a bare canopy from afar.
  c.lerp(new THREE.Color(0.75, 0.77, 0.8), fx.snowCover * (1 - phen.leaf) * 0.45);
}

// Patch a Lambert material's shader. withCover: the terrain's per-vertex tree
// cover (grass goes straw only where there are no trees). snowShare: how much
// of the snow sticks (roads get less).
export function patchGround(shader, { withCover = false, snowShare = 1 } = {}) {
  Object.assign(shader.uniforms, { gfxWet: GROUND_FX.wet, gfxSnow: GROUND_FX.snow, gfxDormant: GROUND_FX.dormant });
  shader.vertexShader = 'varying float vUpness;\nvarying vec3 vWorldXZ;\n' + shader.vertexShader
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vUpness = objectNormal.y;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWorldXZ = position;');
  const cover = withCover ? 'vCover' : '0.0';
  shader.fragmentShader = 'uniform float gfxWet;\nuniform float gfxSnow;\nuniform float gfxDormant;\nvarying float vUpness;\nvarying vec3 vWorldXZ;\n'
    + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  {
    float n = fract(sin(dot(floor(vWorldXZ.xz * 1.3), vec2(12.9898, 78.233))) * 43758.5453);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.37, 0.24), gfxDormant * 0.7 * (1.0 - ${cover}));
    diffuseColor.rgb *= 1.0 - 0.3 * gfxWet;
    float lie = smoothstep(0.62, 0.86, vUpness) * (0.82 + 0.18 * n);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.93), clamp(gfxSnow * ${snowShare.toFixed(2)} * lie * 1.2, 0.0, 1.0));
  }`);
}
