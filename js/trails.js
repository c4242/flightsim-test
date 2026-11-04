// Contrails: condensation trails behind the engine at high altitude. A ring buffer of points,
// drawn in one call; each point is a soft sprite that grows and fades with age. The trail only
// becomes visible a short distance behind the nozzle, as real contrails form once the exhaust cools.

import * as THREE from 'three';

const N = 6000;
const LIFE = 45;          // seconds a trail stays visible
const SPACING = 0.012;    // seconds between points (about 3 m at cruise speed)

export class Contrails {
  constructor(scene) {
    this.pos = new Float32Array(N * 3);
    this.birth = new Float32Array(N).fill(-1e9);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    this.geo = geo;
    this.uniforms = {
      uTime: { value: 0 }, uLife: { value: LIFE }, uScale: { value: 600 },
      uColor: { value: new THREE.Color(1, 1, 1) },
      fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 1000 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, fog: true,
      vertexShader: /* glsl */`
        uniform float uTime, uLife, uScale;
        attribute float aBirth;
        varying float vA;
        varying float vFogDepth;
        void main() {
          float age = uTime - aBirth;
          float t = clamp(age / uLife, 0.0, 1.0);
          // Invisible for the first moment (exhaust still hot), then thick, then spreading out.
          vA = smoothstep(0.03, 0.18, age) * (1.0 - t) * (1.0 - t) * step(age, uLife);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFogDepth = -mv.z;
          // Narrow just behind the aircraft, spreading as the trail ages.
          float size = 2.6 + 30.0 * sqrt(t) + 2.0 * smoothstep(0.0, 3.0, age);
          gl_PointSize = size * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor, fogColor;
        uniform float fogNear, fogFar;
        varying float vA;
        varying float vFogDepth;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          float a = vA * (1.0 - r) * 0.5;
          vec3 c = mix(uColor, fogColor, smoothstep(fogNear, fogFar, vFogDepth));
          gl_FragColor = vec4(c, a);
        }`,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.next = 0;
    this.acc = 0;
    this.time = 0;
    this._p = new THREE.Vector3();
  }

  clear() { this.birth.fill(-1e9); this.geo.attributes.aBirth.needsUpdate = true; }

  // emitters: body-frame points (e.g. the nozzle); active: whether conditions make a contrail.
  update(dt, ac, emitters, active, scene, camera, envColor) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uScale.value = innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
    this.uniforms.uColor.value.copy(envColor);
    if (scene.fog) {
      this.uniforms.fogColor.value.copy(scene.fog.color);
      this.uniforms.fogNear.value = scene.fog.near;
      this.uniforms.fogFar.value = scene.fog.far;
    }
    if (!active || ac.crashed) return;
    this.acc += dt;
    let changed = false;
    while (this.acc >= SPACING) {
      this.acc -= SPACING;
      for (const e of emitters) {
        const p = this._p.copy(e).applyQuaternion(ac.quat).add(ac.pos);
        // Spread the points along the path travelled during this frame.
        p.addScaledVector(ac.vel, -this.acc);
        this.pos.set([p.x + (Math.random() - 0.5) * 0.6, p.y + (Math.random() - 0.5) * 0.6, p.z + (Math.random() - 0.5) * 0.6], this.next * 3);
        this.birth[this.next] = this.time - this.acc;
        this.next = (this.next + 1) % N;
        changed = true;
      }
    }
    if (changed) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aBirth.needsUpdate = true;
    }
  }
}
