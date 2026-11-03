// Air-to-air refuelling: a four-engine boom tanker flying a left-hand racetrack at 20,000 ft,
// about 300 KCAS. A receiver that flies its receptacle into the boom envelope and holds it
// steady gets "contact" and takes on fuel; leaving the envelope disconnects.

import * as THREE from 'three';

const G = 9.81;
const DEG = 180 / Math.PI;
export const TANKER_ALT = 6100;    // m (20,000 ft)
const SPEED = 205;                 // m/s true airspeed
const R = 7300;                    // turn radius for about 30° of bank
const HALF = 9000;                 // half length of the straight legs
const CENTRE = new THREE.Vector3(0, TANKER_ALT, 1500);
const BOOM_PIVOT = new THREE.Vector3(0, -2.0, 15.5);   // tanker body frame (-Z forward)
const RECEPTACLE = new THREE.Vector3(0, 0.82, -2.0);   // F-16 body frame, on the spine behind the canopy
const IDEAL = { elev: 30, az: 0, r: 15 };
const TRANSFER = 7.5;              // kg/s (about 1,000 lb/min)

function buildModel() {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xaab0b6, roughness: 0.55, metalness: 0.2 });
  const darker = new THREE.MeshStandardMaterial({ color: 0x8b9197, roughness: 0.6, metalness: 0.2 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.8 });
  const add = (geo, mat, parent = root) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; parent.add(m); return m; };
  // Fuselage with nose and tail cones.
  add(new THREE.CylinderGeometry(1.95, 1.95, 30, 20).rotateX(Math.PI / 2), skin);
  add(new THREE.SphereGeometry(1.95, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2).scale(1, 1, 2.2).translate(0, 0, -15), skin);
  add(new THREE.ConeGeometry(1.95, 11, 20).rotateX(Math.PI / 2).translate(0, 0.4, 20.5), skin);
  add(new THREE.BoxGeometry(2.2, 0.5, 1.2), black).position.set(0, 0.9, -16.6);    // cockpit windows
  // Swept wings.
  for (const side of [-1, 1]) {
    const shape = new THREE.Shape();
    [[1.6, -5], [19.9, 7.5], [19.9, 9.8], [1.6, 4]].forEach(([x, z], i) => (i ? shape.lineTo(side * x, z) : shape.moveTo(side * x, z)));
    const wing = add(new THREE.ExtrudeGeometry(shape, { depth: 0.45, bevelEnabled: false }).rotateX(Math.PI / 2), skin);
    wing.position.y = -0.6;
    for (const x of [7.2, 13.2]) {
      const pod = add(new THREE.CylinderGeometry(0.85, 0.75, 4.6, 14).rotateX(Math.PI / 2), darker);
      pod.position.set(side * x, -2.0, (x - 1.6) * 0.68 - 6.5);
      add(new THREE.BoxGeometry(0.3, 1.0, 2.2), skin).position.set(side * x, -1.2, (x - 1.6) * 0.68 - 5.6);
    }
    // Horizontal tail.
    const ts = new THREE.Shape();
    [[1, 20], [6.8, 24.5], [6.8, 26], [1, 24.5]].forEach(([x, z], i) => (i ? ts.lineTo(side * x, z) : ts.moveTo(side * x, z)));
    add(new THREE.ExtrudeGeometry(ts, { depth: 0.3, bevelEnabled: false }).rotateX(Math.PI / 2), skin).position.y = 0.6;
  }
  // Fin.
  const fs = new THREE.Shape();
  [[0, 18], [0, 25.5], [7.5, 26.3], [7.5, 23.5]].forEach(([y, z], i) => (i ? fs.lineTo(y, z) : fs.moveTo(y, z)));
  // Shape x is height, shape y runs aft: stand it upright on the tail.
  const fin = add(new THREE.ExtrudeGeometry(fs, { depth: 0.35, bevelEnabled: false }).rotateX(Math.PI / 2).rotateZ(Math.PI / 2), skin);
  fin.position.set(-0.17, 1.5, 0);
  // Refuelling boom: pivots under the tail, ruddervators near its end.
  const boom = new THREE.Group();
  boom.position.copy(BOOM_PIVOT);
  root.add(boom);
  const tube = add(new THREE.CylinderGeometry(0.22, 0.28, 1, 10).translate(0, -0.5, 0).rotateX(-Math.PI / 2), darker, boom);
  const nozzle = add(new THREE.CylinderGeometry(0.1, 0.12, 1, 8).translate(0, -0.5, 0).rotateX(-Math.PI / 2), black, boom);
  const vanes = new THREE.Group();
  boom.add(vanes);
  for (const side of [-1, 1]) {
    const v = add(new THREE.BoxGeometry(2.6, 0.08, 0.9), darker, vanes);
    v.position.x = side * 1.2;
    v.rotation.z = side * 0.6;
  }
  // Lights: navigation, beacons and the pilot director lights under the fuselage.
  const glow = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 32;
    const g = cv.getContext('2d');
    const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(cv);
  })();
  const light = (c, x, y, z, s) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: c, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    sp.position.set(x, y, z); sp.scale.set(s, s, 1); root.add(sp); return sp;
  };
  light(0xff2020, -19.9, -0.6, 8.6, 1.4);
  light(0x20ff40, 19.9, -0.6, 8.6, 1.4);
  const beacons = [light(0xff3010, 0, 2.0, 2, 2.2), light(0xff3010, 0, -2.0, 4, 2.2)];
  const director = [light(0xffe060, -1.6, -1.9, -6, 0.9), light(0x60ff80, 1.6, -1.9, -6, 0.9)];
  return { root, boom, tube, nozzle, vanes, beacons, director };
}

export class Tanker {
  constructor(scene) {
    this.model = buildModel();
    scene.add(this.model.root);
    this.length = 4 * HALF + 2 * Math.PI * R;
    this.s = 0;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.state = 'none';          // none | precontact | contact
    this.contactTimer = 0;
    this.transferred = 0;          // kg this contact
    this.totalTransferred = 0;
    this.cues = null;
    this.events = [];
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._v = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._inv = new THREE.Quaternion();
    this.time = 0;
    this.update(0, null);
  }

  reset(s = 0) { this.s = s; this.state = 'none'; this.transferred = 0; this.totalTransferred = 0; this.update(0, null); }

  // Position, heading and bank along the racetrack at distance s.
  sample(s, out) {
    const L1 = 2 * HALF, T = Math.PI * R;
    s = ((s % this.length) + this.length) % this.length;
    let x, z, dx, dz, turn = 0;
    if (s < L1) { x = R; z = HALF - s; dx = 0; dz = -1; turn = edge(s, L1); }
    else if ((s -= L1) < T) { const t = s / R; x = R * Math.cos(t); z = -HALF - R * Math.sin(t); dx = -Math.sin(t); dz = -Math.cos(t); turn = 1; }
    else if ((s -= T) < L1) { x = -R; z = -HALF + s; dx = 0; dz = 1; turn = edge(s, L1); }
    else { s -= L1; const t = s / R; x = -R * Math.cos(t); z = HALF + R * Math.sin(t); dx = Math.sin(t); dz = Math.cos(t); turn = 1; }
    out.x = CENTRE.x + x; out.z = CENTRE.z + z; out.dx = dx; out.dz = dz; out.turn = turn;
    return out;
  }

  // Where to start a receiver: behind and slightly below the tanker.
  joinSpawn(behind = 1800, below = 120) {
    const p = this.sample(this.s, {});
    const heading = Math.atan2(p.dx, -p.dz);
    return { x: p.x - p.dx * behind, y: TANKER_ALT - below, z: p.z - p.dz * behind, heading, speed: SPEED + 12, pitch: 0.03, throttle: 0.62, gearUp: true };
  }

  update(dt, ac) {
    this.time += dt;
    this.s += SPEED * dt;
    const p = this.sample(this.s, this._p ?? (this._p = {}));
    // Bank smoothly into the turns (left-hand racetrack).
    const bankFull = Math.atan(SPEED * SPEED / (G * R));
    this.bank = (this.bank ?? 0) + (bankFull * p.turn - (this.bank ?? 0)) * Math.min(1, dt * 0.8 + (dt === 0 ? 1 : 0));
    this.pos.set(p.x, TANKER_ALT, p.z);
    this.vel.set(p.dx * SPEED, 0, p.dz * SPEED);
    const heading = Math.atan2(p.dx, -p.dz);
    this.heading = heading;
    this.quat.setFromEuler(this._e.set(0.035, -heading, this.bank));
    const m = this.model;
    m.root.position.copy(this.pos);
    m.root.quaternion.copy(this.quat);
    m.beacons.forEach((b, i) => { b.visible = ((this.time + i * 0.5) % 1.0) < 0.12; });
    this.events.length = 0;
    this.cues = null;
    let boomDir = this._v.set(0, -Math.sin(30 / DEG), Math.cos(30 / DEG));
    let boomLen = 14;
    if (ac && ac.type.kind === 'jet' && !ac.crashed) {
      // Receptacle position relative to the boom pivot, in the tanker's frame.
      this._inv.copy(this.quat).invert();
      const rw = this._r.copy(RECEPTACLE).applyQuaternion(ac.quat).add(ac.pos);
      const pivotW = BOOM_PIVOT.clone().applyQuaternion(this.quat).add(this.pos);
      const rel = rw.sub(pivotW).applyQuaternion(this._inv);
      const r = rel.length();
      const elev = Math.asin(Math.max(-1, Math.min(1, -rel.y / r))) * DEG;
      const az = Math.atan2(rel.x, rel.z) * DEG;
      const relSpeed = ac.vel.distanceTo(this.vel);
      this.geometry = { r, elev, az, relSpeed };
      // Collision with the tanker itself.
      if (this.hits(ac)) { ac.crash('Mid-air collision with the tanker'); this.state = 'none'; }
      const inEnvelope = r > 11 && r < 19 && elev > 22 && elev < 38 && Math.abs(az) < 12;
      const inLimits = r > 10 && r < 20 && elev > 20 && elev < 40 && Math.abs(az) < 15;
      if (r < 120 && Math.abs(az) < 40) {
        this.cues = {
          vertical: elev > IDEAL.elev + 2 ? 'UP' : elev < IDEAL.elev - 2 ? 'DOWN' : '',
          fore: r > IDEAL.r + 1.5 ? 'FWD' : r < IDEAL.r - 1.5 ? 'AFT' : '',
          lateral: az > 3 ? 'LEFT' : az < -3 ? 'RIGHT' : '',
        };
      }
      if (this.state === 'contact') {
        if (!inLimits || relSpeed > 5) {
          this.state = 'precontact';
          this.events.push({ type: 'disconnect', reason: !inLimits ? 'limits' : 'closure' });
        } else {
          const room = ac.type.fuelMax - ac.fuel;
          const add = Math.min(room, TRANSFER * dt);
          ac.fuel += add;
          this.transferred += add;
          this.totalTransferred += add;
          if (room <= 0.01 && !this.fullNotified) { this.fullNotified = true; this.events.push({ type: 'full' }); }
          boomDir = rel.clone().normalize();
          boomLen = r;
        }
      } else {
        this.state = r < 120 && Math.abs(az) < 40 ? 'precontact' : 'none';
        if (inEnvelope && relSpeed < 2.5) {
          this.contactTimer += dt;
          if (this.contactTimer > 0.8) {
            this.state = 'contact';
            this.transferred = 0;
            this.fullNotified = false;
            this.contactTimer = 0;
            this.events.push({ type: 'contact' });
          }
        } else this.contactTimer = 0;
        // The boom operator flies the boom towards a receiver in the envelope.
        if (inEnvelope) { boomDir = rel.clone().normalize(); boomLen = Math.min(r - 0.6, 18); }
      }
    } else {
      this.state = 'none';
    }
    // The boom is built along +Z (aft); rotate +Z onto the boom direction.
    const target = this._v2 ?? (this._v2 = new THREE.Vector3());
    target.copy(boomDir);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), target);
    m.boom.quaternion.slerp(q, Math.min(1, dt * 3 + (this.state === 'contact' ? 1 : 0)));
    m.tube.scale.set(1, 1, Math.max(4, boomLen * 0.65));
    m.nozzle.position.z = Math.max(4, boomLen * 0.65);
    m.nozzle.scale.set(1, 1, Math.max(1, boomLen * 0.35));
    m.vanes.position.z = Math.max(4, boomLen * 0.65) - 1;
    // Director lights: lit when a receiver is behind the tanker.
    m.director.forEach((d) => { d.visible = this.state !== 'none'; });
  }

  // Simple collision volumes for the fuselage, wings and tail (tanker body frame).
  hits(ac) {
    for (const p of [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -8.6), new THREE.Vector3(-4.9, 0, 0.9), new THREE.Vector3(4.9, 0, 0.9), new THREE.Vector3(0, 3, 6.2)]) {
      const w = p.applyQuaternion(ac.quat).add(ac.pos).sub(this.pos).applyQuaternion(this._inv);
      if (Math.abs(w.x) < 2.2 && Math.abs(w.y) < 2.3 && Math.abs(w.z) < 23) return true;
      if (Math.abs(w.y + 0.6) < 0.9 && Math.abs(w.x) < 20 && w.z > -5 + Math.abs(w.x) * 0.68 - 1 && w.z < 4 + Math.abs(w.x) * 0.3 + 1) return true;
      if (Math.abs(w.x) < 7 && w.z > 19 && w.z < 27 && w.y > -1 && w.y < 9) return true;
    }
    return false;
  }
}

// Bank ramps: 0 in the middle of a straight leg, rising to 1 near its ends (so the roll-in starts early).
function edge(s, len) {
  const d = Math.min(s, len - s);
  return d < 400 ? 1 - d / 400 : 0;
}
