// Lightning in heavy rain: occasional cloud-to-ground strikes a few kilometres away. Each strike
// draws a jagged, branching bolt from the cloud base to the ground for a fraction of a second and
// lights up the sky with a flickering flash; the caller plays the thunder after the sound delay.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

const MAX_SEG = 260;

export class Lightning {
  constructor(scene) {
    // Each segment is a ribbon facing the camera (6 vertices), a few pixels wide at any distance.
    this.pos = new Float32Array(MAX_SEG * 6 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setDrawRange(0, 0);
    // HDR white-violet so the bolt blooms.
    this.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 9, 14), fog: false, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    this.bolt = new THREE.Mesh(geo, this.mat);
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    scene.add(this.bolt);
    this.geo = geo;
    this.timer = 8 + Math.random() * 10;
    this.flash = 0;       // 0..~1.5: how much the sky is lit right now
    this.t = 1e9;         // time since the current strike
    this.pulses = [];
  }

  // active: storm intensity 0..1 (0 = none). base: cloud base height (m).
  // Returns a strike { dist, pos } on the frame one happens, else null.
  update(dt, camera, active, base) {
    this.t += dt;
    // Flash: a few bright return strokes in quick succession, each decaying fast.
    let f = 0;
    for (const p of this.pulses) { const a = this.t - p[0]; if (a >= 0) f = Math.max(f, p[1] * Math.exp(-a / 0.05)); }
    this.flash = f;
    this.bolt.visible = this.t < 0.35 && f > 0.05;
    this.mat.opacity = Math.min(1, f * 1.5);
    if (active < 0.5) { this.timer = Math.max(this.timer, 5); return null; }
    this.timer -= dt * (active - 0.4) * 1.6;
    if (this.timer > 0) return null;
    this.timer = 10 + Math.random() * 25;
    // Somewhere 1.5–8 km away, usually not straight ahead of the camera.
    const ang = Math.random() * Math.PI * 2, dist = 1500 + Math.random() * 6500;
    const x = camera.position.x + Math.cos(ang) * dist, z = camera.position.z + Math.sin(ang) * dist;
    const ground = Math.max(0, terrainHeight(x, z));
    this.build(x, z, ground, base, camera.position);
    this.t = 0;
    const n = 2 + Math.floor(Math.random() * 3);
    this.pulses = [];
    for (let i = 0; i < n; i++) this.pulses.push([i * (0.06 + Math.random() * 0.08), (i === 0 ? 1 : 0.5 + Math.random() * 0.5) * (1.3 - dist / 12000)]);
    const pos = new THREE.Vector3(x, (ground + base) / 2, z);
    return { dist: pos.distanceTo(camera.position), pos };
  }

  build(x, z, ground, base, eye) {
    let n = 0;
    const P = this.pos;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), d = new THREE.Vector3(), v = new THREE.Vector3(), side = new THREE.Vector3();
    const wMain = Math.max(2, Math.hypot(x - eye.x, z - eye.z) * 0.003);
    let width = wMain;
    const seg = (a, b) => {
      if (n + 6 > MAX_SEG * 6) return;
      A.fromArray(a); B.fromArray(b);
      d.subVectors(B, A); v.subVectors(A, eye);
      side.crossVectors(d, v).normalize().multiplyScalar(width / 2);
      const q = [A.clone().add(side), A.clone().sub(side), B.clone().add(side), B.clone().sub(side)];
      for (const k of [0, 1, 2, 2, 1, 3]) { q[k].toArray(P, n * 3); n++; }
    };
    const walk = (sx, sy, sz, ey, spread, depth) => {
      let px = sx, py = sy, pz = sz;
      const steps = Math.max(4, Math.floor((sy - ey) / 25));
      const dy = (sy - ey) / steps;
      for (let i = 0; i < steps; i++) {
        const nx = px + (Math.random() - 0.5) * spread, ny = py - dy * (0.6 + Math.random() * 0.8), nz = pz + (Math.random() - 0.5) * spread;
        seg([px, py, pz], [nx, Math.max(ey, ny), nz]);
        px = nx; py = Math.max(ey, ny); pz = nz;
        // Side branches that fizzle out part way down.
        if (depth < 2 && Math.random() < 0.12) {
          const w = width; width = wMain * (depth === 0 ? 0.55 : 0.35);
          walk(px, py, pz, py - (py - ey) * (0.2 + Math.random() * 0.4), spread * 0.8, depth + 1);
          width = w;
        }
        if (py <= ey) break;
      }
    };
    walk(x, base, z, ground, 30, 0);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.setDrawRange(0, n);
  }
}
