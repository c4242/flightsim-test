// Sprite particles: crash fire and smoke, tyre smoke, dust on grass, wingtip vapour.

import * as THREE from 'three';

function softTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const MAX = 400;

export class Effects {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const tex = softTexture();
    this.pool = [];
    for (let i = 0; i < MAX; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      s.visible = false;
      this.group.add(s);
      this.pool.push({ s, v: new THREE.Vector3(), age: 0, life: 0, size0: 1, size1: 1, alpha: 1, alive: false, drag: 0, rise: 0, follow: null });
    }
    this.next = 0;
    this.burning = null;
    this.burnTimer = 0;
  }

  emit(pos, vel, { color = 0xffffff, life = 2, size0 = 1, size1 = 4, alpha = 0.6, additive = false, drag = 0.5, rise = 0, delay = 0 } = {}) {
    const p = this.pool[this.next];
    this.next = (this.next + 1) % MAX;
    p.s.position.copy(pos);
    p.v.copy(vel);
    p.age = -delay;
    p.life = life;
    p.size0 = size0;
    p.size1 = size1;
    p.alpha = alpha;
    p.drag = drag;
    p.rise = rise;
    p.alive = true;
    const m = p.s.material;
    m.color.set(color);
    const blend = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    if (m.blending !== blend) { m.blending = blend; m.needsUpdate = true; }
    p.s.visible = false;
  }

  crash(pos) {
    const v = new THREE.Vector3();
    for (let i = 0; i < 30; i++) {
      v.set((Math.random() - 0.5) * 14, 2 + Math.random() * 10, (Math.random() - 0.5) * 14);
      this.emit(pos, v, { color: new THREE.Color(1, 0.5 + Math.random() * 0.35, 0.12), life: 0.8 + Math.random() * 0.8,
        size0: 4, size1: 16, alpha: 1, additive: true, drag: 1.5, delay: Math.random() * 0.15 });
    }
    this.burning = pos.clone();
    this.burnTimer = 0;
  }

  stopBurning() { this.burning = null; }

  tyreSmoke(pos, strength) {
    const v = new THREE.Vector3();
    const n = Math.round(3 + strength * 8);
    for (let i = 0; i < n; i++) {
      v.set((Math.random() - 0.5) * 2, 0.5 + Math.random(), (Math.random() - 0.5) * 2);
      this.emit(pos, v, { color: 0xdddddd, life: 1.2 + Math.random(), size0: 0.8, size1: 5, alpha: 0.5, drag: 1.2 });
    }
  }

  dust(pos) {
    const v = new THREE.Vector3((Math.random() - 0.5) * 1.5, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 1.5);
    this.emit(pos, v, { color: 0xb59d72, life: 1.5, size0: 1, size1: 5, alpha: 0.35, drag: 1 });
  }

  vapour(pos, vel) {
    this.emit(pos, vel, { color: 0xffffff, life: 0.5, size0: 0.4, size1: 1.6, alpha: 0.45, drag: 0.2 });
  }

  update(dt) {
    // Burning wreck keeps emitting fire and smoke.
    if (this.burning) {
      this.burnTimer += dt;
      const fade = Math.max(0, 1 - this.burnTimer / 40);
      if (Math.random() < dt * 25 * fade) {
        this.emit(this.burning, new THREE.Vector3((Math.random() - 0.5) * 2, 5 + Math.random() * 4, (Math.random() - 0.5) * 2),
          { color: 0x1c1a18, life: 6 + Math.random() * 3, size0: 3, size1: 26, alpha: 0.7, drag: 0.2, rise: 0.5 });
      }
      if (Math.random() < dt * 20 * fade) {
        this.emit(this.burning, new THREE.Vector3((Math.random() - 0.5) * 2, 3 + Math.random() * 3, (Math.random() - 0.5) * 2),
          { color: new THREE.Color(1, 0.55, 0.15), life: 0.6, size0: 2.5, size1: 6, alpha: 0.9, additive: true, drag: 1 });
      }
    }
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age < 0) continue;
      const t = p.age / p.life;
      if (t >= 1) { p.alive = false; p.s.visible = false; continue; }
      p.s.visible = true;
      p.v.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.v.y += p.rise * dt;
      p.s.position.addScaledVector(p.v, dt);
      const size = p.size0 + (p.size1 - p.size0) * Math.sqrt(t);
      p.s.scale.set(size, size, 1);
      p.s.material.opacity = p.alpha * (1 - t) * Math.min(1, p.age * 8 + 0.3);
    }
  }

  clear() {
    for (const p of this.pool) { p.alive = false; p.s.visible = false; }
    this.burning = null;
  }
}
