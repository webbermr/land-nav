// The sky dome that follows the viewer: a gradient from horizon to zenith, the
// sun's disc and glow, and stars that come out after dusk and turn with the
// earth. Colours come from environment.js; the fog colour matches the horizon so
// distant terrain fades into the sky.
import * as THREE from 'three';

export const SKY = Object.freeze({
  top: new THREE.Color(0x6f9fd4),
  horizon: new THREE.Color(0xc4d6e4),
  ground: new THREE.Color(0x9aa49a),
});

const RADIUS = 8000;
const STARS = 2400;

export function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      top: { value: SKY.top.clone() },
      horizon: { value: SKY.horizon.clone() },
      ground: { value: SKY.ground.clone() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      sunDisc: { value: 1 },   // 0 behind cloud .. 1 clear
      sunset: { value: 0 },    // 0..1, how much the horizon glows toward the sun
      cloud: { value: 0 },     // 0..1 cover (weather)
      cloudColor: { value: new THREE.Color(0.8, 0.8, 0.82) },
      cloudShift: { value: new THREE.Vector2() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 ground;
      uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunDisc; uniform float sunset;
      uniform float cloud; uniform vec3 cloudColor; uniform vec2 cloudShift;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
        return v;
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(min(1.0, h * 1.6), 0.7)) : mix(horizon, ground, min(1.0, -h * 4.0));
        float toward = max(dot(d, sunDir), 0.0);
        // Dawn and dusk: the horizon glows on the sun's side.
        vec2 hd = normalize(d.xz + 1e-5), hs = normalize(sunDir.xz + 1e-5);
        float side = pow(max(dot(hd, hs), 0.0), 3.0) * (1.0 - smoothstep(0.0, 0.45, abs(h)));
        c = mix(c, sunColor * 0.9, sunset * side * 0.7);
        // Clouds: a flat layer seen from below, thicker toward the horizon.
        if (h > 0.0 && cloud > 0.0) {
          vec2 uv = d.xz / (h + 0.08) * 1.2 + cloudShift;
          float n = fbm(uv);
          float cover = smoothstep(1.0 - cloud * 1.05, 1.2 - cloud * 0.6, n);
          cover = max(cover, smoothstep(0.75, 1.0, cloud));
          vec3 cc = cloudColor * (0.85 + 0.3 * n);
          cc += sunColor * pow(toward, 6.0) * 0.25 * sunDisc;
          c = mix(c, cc, cover * smoothstep(0.0, 0.12, h));
        }
        // The sun: a bright disc and a soft halo.
        float disc = smoothstep(0.99955, 0.99975, toward);
        float halo = pow(toward, 600.0) * 0.6 + pow(toward, 12.0) * 0.12;
        c += sunColor * (disc * 6.0 + halo) * sunDisc * step(-0.02, sunDir.y);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 48, 24), mat);
  mesh.name = 'sky';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;

  // Stars on the celestial sphere: random, not a catalogue. The group turns about
  // the celestial pole, so they rise in the east and wheel round Polaris.
  const pos = new Float32Array(STARS * 3);
  const col = new Float32Array(STARS * 3);
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < STARS; i++) {
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    pos.set([r * Math.cos(a) * RADIUS * 0.95, z * RADIUS * 0.95, r * Math.sin(a) * RADIUS * 0.95], i * 3);
    // Most stars faint, a few bright; a little colour.
    const b = 0.25 + 0.75 * rnd() ** 6;
    const warm = rnd();
    col.set([b * (0.9 + 0.1 * warm), b * 0.95, b * (1 - 0.15 * warm)], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const starMat = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const stars = new THREE.Points(geo, starMat);
  stars.name = 'stars';
  stars.frustumCulled = false;
  stars.renderOrder = -9;
  stars.visible = false;
  const pole = new THREE.Group();
  pole.add(stars);
  mesh.add(pole);

  return {
    mesh,
    uniforms: mat.uniforms,
    // brightness 0..1; lat in degrees; northDir: scene direction of true north
    // (unit, horizontal); siderealDeg: local sidereal time in degrees.
    setStars(brightness, lat, northDir, siderealDeg) {
      starMat.opacity = brightness;
      stars.visible = brightness > 0.01;
      if (!stars.visible) return;
      // Celestial pole: toward true north, raised by the latitude.
      const la = THREE.MathUtils.degToRad(lat);
      const axis = new THREE.Vector3(northDir.x * Math.cos(la), Math.sin(la), northDir.z * Math.cos(la)).normalize();
      pole.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      stars.rotation.y = -THREE.MathUtils.degToRad(siderealDeg);
    },
  };
}
