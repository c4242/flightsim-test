// Flocks of birds circling over the coast and the farmland. Each flock wanders around a home
// point at its own height; birds keep a loose formation, flap and glide. One instanced draw call
// for all birds (a simple flapping "V" silhouette). Flying into a bird is a bird strike.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

const HOMES = [
  // [x, z, height above ground, radius] — coastline, fields and the valley north of Skyhaven.
  [-6200, 1500, 60, 350], [-2800, 4300, 90, 400], [800, 7600, 40, 300], [5600, 2600, 120, 350],
  [-500, -3000, 150, 450], [3900, -5600, 80, 300], [-4200, -900, 110, 380], [1800, 1600, 70, 320],
];
const PER = 14;

export class Birds {
  constructor(scene) {
    // One bird: two wings as a thin "V", flapping is done in the vertex shader.
    const geo = new THREE.InstancedBufferGeometry();
    const w = 0.55; // half-span (m), about a gull
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, -0.18, -w, 0, 0.05, 0, 0, 0.12,   // left wing
      0, 0, -0.18, 0, 0, 0.12, w, 0, 0.05,    // right wing
    ], 3));
    const n = HOMES.length * PER;
    this.n = n;
    this.offset = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.dir = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.phase = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aOffset', this.offset);
    geo.setAttribute('aDir', this.dir);
    geo.setAttribute('aPhase', this.phase);
    geo.instanceCount = n;
    this.uniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(0.12, 0.12, 0.13) } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.DoubleSide, fog: false,
      vertexShader: /* glsl */`
        uniform float uTime;
        attribute vec3 aOffset, aDir;
        attribute float aPhase;
        void main() {
          vec3 p = position;
          // Flap: wingtips move up and down; some of the time the bird glides with wings level.
          float glide = step(0.55, fract(aPhase * 0.37 + uTime * 0.11));
          float flap = sin(uTime * 9.0 + aPhase * 6.28) * (1.0 - glide) + 0.12 * glide;
          p.y += abs(p.x) * flap * 0.9;
          // Orient along the flight direction (z forward along aDir), with a little bank.
          vec3 fwd = normalize(aDir);
          vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
          vec3 up = cross(right, fwd);
          vec3 world = aOffset + right * p.x + up * p.y - fwd * p.z;
          // Never smaller than about 2 px, so distant flocks still read as specks.
          vec4 mv = viewMatrix * vec4(world, 1.0);
          vec4 mvc = viewMatrix * vec4(aOffset, 1.0);
          float k = max(1.0, -mvc.z * 0.0012 / 0.55);
          mv.xyz = mvc.xyz + (mv.xyz - mvc.xyz) * k;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    // Per-bird state: angle round the home, radius, height offset, speed.
    this.birds = [];
    let s = 31337;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    HOMES.forEach(([x, z, h, r], f) => {
      const ground = Math.max(0, terrainHeight(x, z));
      const flock = { x, z, y: ground + h, r, a: rnd() * 6.28, speed: 11 + rnd() * 4, wander: rnd() * 100 };
      for (let i = 0; i < PER; i++) {
        this.birds.push({ flock, dx: (rnd() - 0.5) * 30, dy: (rnd() - 0.5) * 10, dz: (rnd() - 0.5) * 30, ph: rnd(), alive: true });
        this.phase.array[f * PER + i] = rnd();
      }
    });
    this.phase.needsUpdate = true;
    this.time = 0;
    this._p = new THREE.Vector3();
  }

  // Returns a bird-strike event { pos } if the aircraft hit a bird this frame.
  update(dt, ac, night) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.mesh.visible = !night; // roosting
    if (night) return null;
    const o = this.offset.array, d = this.dir.array;
    const flocks = new Set(this.birds.map((b) => b.flock));
    for (const f of flocks) {
      f.a += (f.speed / f.r) * dt;
      f.wander += dt * 0.05;
    }
    let strike = null;
    this.birds.forEach((b, i) => {
      const f = b.flock;
      // Flock centre runs round a wobbly circle; birds hold loose offsets that drift slowly.
      const a = f.a + Math.sin(f.wander + b.ph * 3) * 0.05;
      const rr = f.r * (0.85 + 0.15 * Math.sin(f.wander * 1.7));
      const cx = f.x + Math.cos(a) * rr, cz = f.z + Math.sin(a) * rr;
      const cy = f.y + Math.sin(f.wander * 2.3) * 15;
      const wob = this.time * 0.3 + b.ph * 10;
      const x = cx + b.dx + Math.sin(wob) * 4, y = cy + b.dy + Math.sin(wob * 1.3) * 2, z = cz + b.dz + Math.cos(wob) * 4;
      o[i * 3] = b.alive ? x : 0; o[i * 3 + 1] = b.alive ? y : -1e4; o[i * 3 + 2] = b.alive ? z : 0;
      d[i * 3] = -Math.sin(a); d[i * 3 + 1] = 0; d[i * 3 + 2] = Math.cos(a);
      if (b.alive && ac && !ac.crashed && !strike) {
        const p = this._p.set(x, y, z);
        if (p.distanceToSquared(ac.pos) < 25) {
          // Within 5 m of the centre of gravity: check against the forward fuselage / intake.
          const local = p.sub(ac.pos).applyQuaternion(ac.quat.clone().invert());
          if (Math.abs(local.x) < 1.6 && Math.abs(local.y) < 1.4 && local.z < 1 && local.z > -6) {
            b.alive = false;
            b.respawn = this.time + 60;
            strike = { pos: new THREE.Vector3(x, y, z) };
          }
        }
      }
      if (!b.alive && this.time > b.respawn) b.alive = true;
    });
    this.offset.needsUpdate = true;
    this.dir.needsUpdate = true;
    return strike;
  }
}
