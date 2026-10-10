// Comfort vignette (spec section 6): darkens peripheral vision while stick-moving.
// A small inverted sphere parented to the camera, so it follows the head in XR.
import * as THREE from 'three';

export function createVignette() {
  const material = new THREE.ShaderMaterial({
    uniforms: { amount: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float amount;
      varying vec3 vDir;
      void main() {
        // Angle from straight ahead (-Z in camera space).
        float ang = acos(clamp(-vDir.z, -1.0, 1.0));
        float inner = mix(1.35, 0.5, amount);
        float a = smoothstep(inner, inner + 0.4, ang) * clamp(amount * 3.0, 0.0, 1.0);
        gl_FragColor = vec4(0.0, 0.0, 0.0, a);
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.25, 32, 16), material);
  mesh.name = 'vignette';
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  mesh.visible = false;

  let current = 0;
  return {
    mesh,
    // target: 0..1. Eased so starting and stopping don't pop.
    update(target, dt) {
      current += (target - current) * Math.min(1, dt * 6);
      if (current < 0.005) current = 0;
      material.uniforms.amount.value = current;
      mesh.visible = current > 0;
    },
  };
}
