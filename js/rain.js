// Rain: streaks falling in a box around the camera, stretched along the motion of the rain
// relative to the camera (so they slant and lengthen with airspeed). One draw call.

import * as THREE from 'three';

const N = 2600;
const BOX = 70;            // half-size of the box around the camera (m)
const FALL = 8.5;          // terminal velocity of raindrops (m/s)

export class Rain {
  constructor(scene) {
    this.drops = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) this.drops[i] = (Math.random() * 2 - 1) * BOX;
    this.pos = new Float32Array(N * 6);
    this.alpha = new Float32Array(N * 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aA', new THREE.BufferAttribute(this.alpha, 1));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.75, 0.78, 0.82) }, uIntensity: { value: 0 } },
      transparent: true, depthWrite: false, fog: false,
      vertexShader: /* glsl */`
        attribute float aA;
        varying float vA;
        void main() { vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uIntensity;
        varying float vA;
        void main() { gl_FragColor = vec4(uColor, vA * uIntensity); }`,
    });
    this.lines = new THREE.LineSegments(geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);
    this.origin = new THREE.Vector3();
    this.rel = new THREE.Vector3();
  }

  // intensity 0..1; camVel: velocity of the camera (the aircraft's); wind: air velocity.
  update(dt, camera, camVel, wind, intensity, groundY, light) {
    this.lines.visible = intensity > 0.01;
    if (!this.lines.visible) return;
    this.mat.uniforms.uIntensity.value = intensity * 0.55;
    this.mat.uniforms.uColor.value.setRGB(0.55, 0.58, 0.62).multiplyScalar(0.6 + 0.6 * light);
    // Raindrop velocity relative to the camera.
    const rel = this.rel.set(wind.x, -FALL, wind.z).sub(camVel);
    const speed = rel.length();
    // Streak length: what the eye integrates in about 1/30 s, at least 0.4 m.
    const len = Math.max(0.4, Math.min(speed * 0.035, 6));
    const dir = rel.clone().normalize();
    const c = camera.position;
    const d = this.drops;
    // Move the drops in the camera's frame and wrap them around inside the box.
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 3; k++) {
        let v = d[i * 3 + k] + (k === 0 ? rel.x : k === 1 ? rel.y : rel.z) * dt;
        if (v > BOX) v -= 2 * BOX; else if (v < -BOX) v += 2 * BOX;
        d[i * 3 + k] = v;
      }
      const x = c.x + d[i * 3], y = c.y + d[i * 3 + 1], z = c.z + d[i * 3 + 2];
      const j = i * 6;
      this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
      this.pos[j + 3] = x - dir.x * len; this.pos[j + 4] = y - dir.y * len; this.pos[j + 5] = z - dir.z * len;
      // Fade drops near the edge of the box and below the ground.
      const r = Math.max(Math.abs(d[i * 3]), Math.abs(d[i * 3 + 1]), Math.abs(d[i * 3 + 2])) / BOX;
      const a = (1 - r * r) * (y > groundY ? 1 : 0);
      this.alpha[i * 2] = a; this.alpha[i * 2 + 1] = a * 0.15;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aA.needsUpdate = true;
  }
}
