// AI traffic: another aircraft flying left-hand circuits with touch-and-goes at Skyhaven.
// It follows a smooth closed path at a speed that varies along the circuit, banking into turns.

import * as THREE from 'three';
import { RUNWAY, fieldToWorld } from './terrain.js';
import { createAircraftModel } from './model.js';

const G = 9.81;

export class Traffic {
  constructor(scene) {
    this.model = createAircraftModel({ stripeColor: 0x1f5fbf, cockpitInterior: false });
    scene.add(this.model.object);
    const f = RUNWAY;
    const E = f.elevation;
    const ground = E + 1.24;
    // Field-local (along, across, height) points. Runway 36 heading; a left-hand circuit is to the west.
    const pts = [
      // Touch-and-go well past the threshold, clear of where the player starts.
      [-300, 0, ground + 0.2], [-50, 0, ground], [250, 0, E + 5], [700, 0, E + 55], [1300, 0, E + 150],
      [1900, -250, E + 230], [2000, -900, E + 300], [1300, -1000, E + 300], [0, -1000, E + 300],
      [-1300, -1000, E + 290], [-2000, -900, E + 250], [-2300, -400, E + 190], [-2100, 0, E + 130],
      [-1500, 0, E + 85], [-1000, 0, E + 45], [-650, 0, E + 16],
    ];
    this.path = new THREE.CatmullRomCurve3(pts.map(([a, c, h]) => fieldToWorld(f, a, c, h)), true, 'centripetal');
    this.length = this.path.getLength();
    this.s = 0.62 * this.length; // start on the downwind leg
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.state = {
      pos: this.pos, quat: this.quat, vel: this.vel,
      controls: { elevator: 0, aileron: 0, rudder: 0, throttle: 0.6, brake: 0 },
      flaps: 0, trim: 0, rpm: 2300, onGround: false, speed: 40,
    };
    this._t = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this.update(0);
  }

  // Put the aircraft back on the downwind leg (used when a scenario starts).
  reset() { this.s = 0.6 * this.length; this.update(0); }

  speedAt(p) {
    // Slower on approach and the ground roll, faster on downwind.
    const agl = p.y - RUNWAY.elevation;
    return agl < 15 ? 32 : agl < 120 ? 36 : 44;
  }

  update(dt) {
    const L = this.length;
    const u0 = this.s / L;
    const p = this.path.getPointAt(u0);
    const v = this.speedAt(p);
    this.s = (this.s + v * dt) % L;
    const u = this.s / L;
    this.pos.copy(this.path.getPointAt(u));
    this.pos.y = Math.max(this.pos.y, RUNWAY.elevation + 1.24); // the spline dips slightly on the runway
    const tan = this.path.getTangentAt(u, this._t);
    const tan2 = this.path.getTangentAt((u + 4 / L) % 1, this._t2);
    // Bank from the turn rate: tan(bank) = v * yawRate / g.
    const h1 = Math.atan2(tan.x, -tan.z), h2 = Math.atan2(tan2.x, -tan2.z);
    let dh = h2 - h1;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const yawRate = dh / (4 / v);
    const onGround = this.pos.y < RUNWAY.elevation + 1.6;
    const bank = onGround ? 0 : Math.atan((v * yawRate) / G);
    const pitch = Math.asin(Math.max(-1, Math.min(1, tan.y))) + (onGround ? 0 : 0.05);
    this.quat.setFromEuler(new THREE.Euler(pitch, -h1, -bank, 'YXZ'));
    this.vel.copy(tan).multiplyScalar(v);
    const st = this.state;
    st.speed = v;
    st.onGround = onGround;
    st.flaps = this.pos.y - RUNWAY.elevation < 150 && tan.y < 0 ? 1 : 0;
    st.controls.throttle = tan.y > 0.02 ? 1 : tan.y < -0.02 ? 0.2 : 0.55;
    st.rpm = 700 + 1900 * st.controls.throttle + v * 6;
    st.controls.aileron = Math.max(-1, Math.min(1, bank * 2));
    this.model.object.position.copy(this.pos);
    this.model.object.quaternion.copy(this.quat);
    this.model.update(st, dt);
  }
}
