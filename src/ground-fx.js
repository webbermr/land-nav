// What weather and season do to the ground: wet ground goes darker, snow lies on
// the flatter ground, winter grass goes straw-coloured, and the far forest canopy
// changes colour with the leaves. Shared uniforms, patched into the ground
// materials of the terrain and the roads and trails.
import * as THREE from 'three';

// A grey pixel until the aerial photographs arrive (src/aerial.js).
const NO_AERIAL = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
NO_AERIAL.needsUpdate = true;

export const GROUND_FX = {
  wet: { value: 0 },
  snow: { value: 0 },
  dormant: { value: 0 },
  canopyColor: { value: new THREE.Color(0x3d5428) },
  season: { value: 0 },        // 0 summer .. 1: how far the photographs' greens turn (autumn, bare)
  aerial: { value: NO_AERIAL },
  aerialBox: { value: new THREE.Vector4(0, 0, 1, 0) }, // x0, z0, size, on
  aerialRange: { value: new THREE.Vector2(160, 320) },  // fade in from .. to (metres from the eye)
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
  GROUND_FX.season.value = Math.max(phen.autumn * phen.leaf * 0.8, 1 - phen.leaf);
}

// Turn summer photograph greens toward the season's canopy colour.
const SEASON_TINT = `
    {
      float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
      float green = smoothstep(0.0, 0.06, diffuseColor.g - max(diffuseColor.r, diffuseColor.b) * 0.92);
      vec3 cc = canopyColor / max(0.05, dot(canopyColor, vec3(0.3, 0.59, 0.11)));
      diffuseColor.rgb = mix(diffuseColor.rgb, lum * cc, gfxSeason * green * 0.85);
    }`;

// Patch a Lambert material's shader. withCover: the terrain's per-vertex tree
// cover (grass goes straw only where there are no trees). snowShare: how much
// of the snow sticks (roads get less).
// aerial: fade into the aerial photographs at a distance (terrain). seasonTint: the
// material's own colour is a summer photograph (the far ring).
export function patchGround(shader, { withCover = false, snowShare = 1, aerial = false, seasonTint = false } = {}) {
  Object.assign(shader.uniforms, {
    gfxWet: GROUND_FX.wet, gfxSnow: GROUND_FX.snow, gfxDormant: GROUND_FX.dormant, gfxSeason: GROUND_FX.season,
    canopyColor: GROUND_FX.canopyColor, gfxAerial: GROUND_FX.aerial, gfxAerialBox: GROUND_FX.aerialBox, gfxAerialRange: GROUND_FX.aerialRange,
  });
  shader.vertexShader = 'varying float vUpness;\nvarying vec3 vWorldXZ;\n' + shader.vertexShader
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vUpness = objectNormal.y;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vWorldXZ = position;');
  const cover = withCover ? 'vCover' : '0.0';
  const declared = /uniform vec3 canopyColor;/.test(shader.fragmentShader) ? '' : 'uniform vec3 canopyColor;\n';
  shader.fragmentShader = `${declared}uniform float gfxWet;\nuniform float gfxSnow;\nuniform float gfxDormant;\nuniform float gfxSeason;
uniform sampler2D gfxAerial;\nuniform vec4 gfxAerialBox;\nuniform vec2 gfxAerialRange;\nvarying float vUpness;\nvarying vec3 vWorldXZ;\n`
    + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  ${seasonTint ? SEASON_TINT : ''}
  ${aerial ? `if (gfxAerialBox.w > 0.5) {
    vec2 auv = (vWorldXZ.xz - gfxAerialBox.xy) / gfxAerialBox.z;
    auv.y = 1.0 - auv.y;
    float inside = step(0.0, auv.x) * step(auv.x, 1.0) * step(0.0, auv.y) * step(auv.y, 1.0);
    float k = smoothstep(gfxAerialRange.x, gfxAerialRange.y, length(vViewPosition)) * inside;
    vec3 keep = diffuseColor.rgb;
    diffuseColor.rgb = texture2D(gfxAerial, auv).rgb;
    ${SEASON_TINT}
    diffuseColor.rgb = mix(keep, diffuseColor.rgb, k);
  }` : ''}
  {
    float n = fract(sin(dot(floor(vWorldXZ.xz * 1.3), vec2(12.9898, 78.233))) * 43758.5453);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.37, 0.24), gfxDormant * 0.7 * (1.0 - ${cover}));
    diffuseColor.rgb *= 1.0 - 0.3 * gfxWet;
    float lie = smoothstep(0.62, 0.86, vUpness) * (0.82 + 0.18 * n);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.93), clamp(gfxSnow * ${snowShare.toFixed(2)} * lie * 1.2, 0.0, 1.0));
  }`);
}
