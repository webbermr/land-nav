// A simple gradient sky dome that follows the viewer. The fog colour matches its
// horizon so distant terrain fades into the sky.
import * as THREE from 'three';

export const SKY = Object.freeze({
  top: new THREE.Color(0x6f9fd4),
  horizon: new THREE.Color(0xc4d6e4),
  ground: new THREE.Color(0x9aa49a),
});

export function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      top: { value: SKY.top },
      horizon: { value: SKY.horizon },
      ground: { value: SKY.ground },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 ground;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(min(1.0, h * 1.6), 0.7)) : mix(horizon, ground, min(1.0, -h * 4.0));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(8000, 32, 16), mat);
  mesh.name = 'sky';
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}
