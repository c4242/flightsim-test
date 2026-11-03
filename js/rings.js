// Timed ring course. Rings are placed at fixed map positions; their heights are
// computed from the terrain so every leg between rings clears the ground.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

// Across the western lowlands, a low pass over Skyhaven, up the canyon, a turn out over
// the northern sea, and back down the canyon to finish over the airfield.
const ROUTE = [
  [-3400, 3000], [-1500, 4500], [0, 3000], [0, 600], [-300, -2000], [0, -4200], [300, -6400],
  [0, -8700], [-350, -6300], [350, -3700], [-250, -1300], [0, 1400],
];
export const RING_RADIUS = 20;

function terrainMaxAround(x, z, r) {
  let m = 0;
  for (let a = -r; a <= r; a += r / 3) for (let b = -r; b <= r; b += r / 3) m = Math.max(m, terrainHeight(x + a, z + b));
  return m;
}

export function computeCourse() {
  const pts = ROUTE.map(([x, z]) => new THREE.Vector3(x, terrainMaxAround(x, z, 150) + 80, z));
  // Raise rings until each straight leg keeps 45 m above the terrain.
  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      for (let t = 0; t <= 1; t += 0.02) {
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const y = a.y + (b.y - a.y) * t;
        const need = terrainMaxAround(x, z, 60) + 45;
        if (y < need) { a.y += (need - y) * (1 - t) + 2; b.y += (need - y) * t + 2; changed = true; break; }
      }
    }
    if (!changed) break;
  }
  return pts;
}

export class RingCourse {
  constructor(scene) {
    this.points = computeCourse();
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    const geo = new THREE.TorusGeometry(RING_RADIUS, 1.4, 10, 48);
    this.rings = this.points.map((p, i) => {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffb21a, transparent: true, opacity: 0.85, fog: false });
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(p);
      // Face the ring towards the aircraft arriving from the previous ring.
      const dir = i > 0 ? new THREE.Vector3().subVectors(p, this.points[i - 1]) : new THREE.Vector3().subVectors(this.points[1], p);
      dir.y = 0;
      m.lookAt(p.clone().add(dir));
      this.group.add(m);
      return m;
    });
    this.active = false;
    this.best = null;
    try { this.best = Number(localStorage.getItem('skyhaven.ringsBest')) || null; } catch { /* storage unavailable */ }
  }

  spawn(kind = 'prop') {
    const a = this.points[0], b = this.points[1];
    const back = new THREE.Vector3().subVectors(a, b).setY(0).normalize();
    const start = a.clone().addScaledVector(back, 1500);
    start.y = Math.max(a.y + 40, terrainMaxAround(start.x, start.z, 300) + 100);
    const heading = Math.atan2(-back.x, back.z);
    if (kind === 'jet') return { x: start.x, y: start.y + 60, z: start.z, heading, speed: 150, pitch: 0.05, gamma: -0.02, throttle: 0.7, gearUp: true };
    return { x: start.x, y: start.y, z: start.z, heading, speed: 55, pitch: 0.0, gamma: -0.02, flaps: 0, throttle: 0.7 };
  }

  start() {
    this.active = true;
    this.index = 0;
    this.time = 0;
    this.finished = false;
    this.group.visible = true;
    this.prevSide = null;
    this.refresh();
  }

  stop() {
    this.active = false;
    this.group.visible = false;
  }

  refresh() {
    this.rings.forEach((r, i) => {
      r.visible = i >= this.index;
      r.material.color.setHex(i === this.index ? 0x3dff7a : 0xffb21a);
      r.material.opacity = i === this.index ? 0.95 : 0.55;
    });
  }

  get next() { return this.active && !this.finished ? this.points[this.index] : null; }

  // Returns an event string when a ring is passed or the course is finished.
  update(ac, dt) {
    if (!this.active || this.finished) return null;
    this.time += dt;
    const ring = this.rings[this.index];
    // Which side of the ring's plane the aircraft is on (ring normal is its local +Z).
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(ring.quaternion);
    const rel = new THREE.Vector3().subVectors(ac.pos, ring.position);
    const side = Math.sign(rel.dot(normal));
    let result = null;
    if (this.prevSide !== null && side !== this.prevSide && side !== 0) {
      const inPlane = rel.addScaledVector(normal, -rel.dot(normal)).length();
      if (inPlane < RING_RADIUS + 1) {
        this.index++;
        if (this.index >= this.rings.length) {
          this.finished = true;
          const isBest = !this.best || this.time < this.best;
          if (isBest) {
            this.best = this.time;
            try { localStorage.setItem('skyhaven.ringsBest', String(this.time)); } catch { /* ignore */ }
          }
          result = { type: 'finish', time: this.time, best: isBest };
        } else {
          result = { type: 'ring', index: this.index, total: this.rings.length };
        }
        this.refresh();
        this.prevSide = null;
        return result;
      }
    }
    this.prevSide = side;
    // Gentle spin to catch the eye.
    ring.rotateZ(dt * 0.5);
    return result;
  }
}
