// Flight model for a light single-engine aircraft.
//
// Body frame: +X right wing, +Y up, -Z forward (nose). The origin is the centre of gravity.
// Angular velocity `omega` is in the body frame: x = pitch up, y = yaw left, z = roll left.
//
// Forces (lift, drag, side force, thrust, gravity, landing gear) are summed and integrated
// as a rigid body. Rotations combine aerodynamic moments (control surfaces, static
// stability, damping) with torques from the landing gear.

import * as THREE from 'three';
import { surfaceInfo, isOnRunway, RUNWAY } from './terrain.js';
import { clamp } from './noise.js';

const G = 9.81;

export const SPEC = {
  mass: 1100,             // kg
  wingArea: 16,           // m²
  inertia: new THREE.Vector3(2500, 3000, 1500), // pitch, yaw, roll (kg m²), used for gear torques
  cl0: 0.28,
  clAlpha: 5.0,           // per radian
  stallAlpha: 0.27,       // rad (~15.5°)
  stallAlphaNeg: -0.2,
  cd0: 0.028,
  inducedK: 0.055,
  sideForce: 0.6,
  maxThrust: 5200,        // N, static
  propMaxSpeed: 105,      // m/s where thrust falls to zero
  flaps: [               // notches: [deg, ΔCL, ΔCD, Δstall alpha]
    [0, 0, 0, 0],
    [15, 0.3, 0.012, -0.02],
    [30, 0.55, 0.035, -0.035],
  ],
  // Rotational aerodynamics (rad/s² at reference dynamic pressure).
  pitchControl: 4.6, pitchStability: 12, pitchDamping: 4.0, trimAlpha: 0.03,
  rollControl: 7.0, rollDamping: 4.5, dihedral: 1.5,
  yawControl: 2.0, yawStability: 5.0, yawDamping: 2.0,
};

const Q_REF = 0.5 * 1.225 * 50 * 50;

// Landing gear contact points (body frame) and whether they brake/steer.
const GEAR = [
  { p: new THREE.Vector3(0, -1.35, -2.6), steer: true, brake: false, k: 40000, c: 4000 },
  { p: new THREE.Vector3(-1.3, -1.35, 0.3), steer: false, brake: true, k: 55000, c: 5000 },
  { p: new THREE.Vector3(1.3, -1.35, 0.3), steer: false, brake: true, k: 55000, c: 5000 },
];

// Parts of the airframe that must never touch the ground.
const STRUCTURE = [
  new THREE.Vector3(0, 0, -3.8),      // spinner
  new THREE.Vector3(0, -0.15, 4.4),   // tail cone
  new THREE.Vector3(0, 1.45, 4.3),    // fin tip
  new THREE.Vector3(-5.5, -0.15, 0.2), new THREE.Vector3(5.5, -0.15, 0.2), // wing tips
  new THREE.Vector3(-1.8, 0.05, 4.0), new THREE.Vector3(1.8, 0.05, 4.0),   // stabiliser tips
  new THREE.Vector3(0, -0.75, -0.5),  // belly
];

// Scratch objects reused every step.
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _force = new THREE.Vector3(), _torque = new THREE.Vector3(), _invQ = new THREE.Quaternion();
const _dq = new THREE.Quaternion(), _omegaW = new THREE.Vector3(), _r = new THREE.Vector3();

function liftCoefficient(alpha, cl0, stall, stallNeg) {
  const clMax = cl0 + SPEC.clAlpha * stall;
  const clMin = cl0 + SPEC.clAlpha * stallNeg;
  if (alpha > stall) return Math.max(clMax - 4 * (alpha - stall), Math.sin(2 * alpha));
  if (alpha < stallNeg) return Math.min(clMin + 4 * (stallNeg - alpha), Math.sin(2 * alpha));
  return cl0 + SPEC.clAlpha * alpha;
}

export class Aircraft {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.omega = new THREE.Vector3();
    this.controls = { elevator: 0, aileron: 0, rudder: 0, throttle: 0, brake: 0 };
    this.flaps = 0;
    this.trim = 0;
    this.reset('runway');
  }

  reset(mode = 'runway') {
    this.vel.set(0, 0, 0);
    this.omega.set(0, 0, 0);
    this.quat.identity();
    this.crashed = false;
    this.crashReason = '';
    this.trim = 0;
    this.rpm = 700;
    this.time = 0;
    this.events = [];
    this.wasOnGround = false;
    this.airborneTime = 0;
    Object.assign(this.controls, { elevator: 0, aileron: 0, rudder: 0, throttle: 0, brake: 0 });
    if (mode === 'runway') {
      this.flaps = 0;
      this.pos.set(0, RUNWAY.elevation + 1.24, RUNWAY.length / 2 - 40);
    } else if (mode === 'approach') {
      // 4 km final for runway 36, on a 3° glide path.
      const dist = 4000;
      this.flaps = 1;
      this.pos.set(0, RUNWAY.elevation + dist * Math.tan(3 * Math.PI / 180) + 15, RUNWAY.length / 2 - 300 + dist);
      this.vel.set(0, -2.2, -40);
      this.controls.throttle = 0.35;
      this.quat.setFromAxisAngle(_v.set(1, 0, 0), 0.02);
      this.rpm = 1500;
    } else {
      // Cruising over the island.
      this.flaps = 0;
      this.pos.set(-1500, 900, 6000);
      this.vel.set(0, 0, -60);
      this.controls.throttle = 0.7;
      this.quat.setFromAxisAngle(_v.set(1, 0, 0), 0.01);
      this.rpm = 2200;
    }
    this.updateDerived();
    this.onGround = mode === 'runway';
  }

  get forward() { return _fwd.set(0, 0, -1).applyQuaternion(this.quat); }

  // Quantities the HUD and audio need.
  updateDerived() {
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.quat);
    const up = _v2.set(0, 1, 0).applyQuaternion(this.quat);
    const right = _v3.set(1, 0, 0).applyQuaternion(this.quat);
    this.pitch = Math.asin(clamp(fwd.y, -1, 1));
    this.roll = Math.atan2(-right.y, up.y);
    let hdg = Math.atan2(fwd.x, -fwd.z);
    if (hdg < 0) hdg += Math.PI * 2;
    this.heading = hdg;
    this.speed = this.vel.length();
    this.altitude = this.pos.y;
    const surf = surfaceInfo(this.pos.x, this.pos.z);
    this.agl = this.pos.y - 1.35 - surf.height;

    _invQ.copy(this.quat).invert();
    const vb = _v.copy(this.vel).applyQuaternion(_invQ);
    const u = -vb.z;
    this.alpha = this.speed > 1 ? Math.atan2(-vb.y, u) : 0;
    this.beta = this.speed > 1 ? Math.asin(clamp(vb.x / this.speed, -1, 1)) : 0;
    const stall = SPEC.stallAlpha + SPEC.flaps[this.flaps][3];
    this.stalling = !this.onGround && this.speed > 5 && this.alpha > stall - 0.03;
  }

  step(dt) {
    if (this.crashed) return;
    this.time += dt;
    const c = this.controls;
    const flap = SPEC.flaps[this.flaps];

    const fwd = _fwd.set(0, 0, -1).applyQuaternion(this.quat);
    const up = _up.set(0, 1, 0).applyQuaternion(this.quat);
    const right = _right.set(1, 0, 0).applyQuaternion(this.quat);
    _invQ.copy(this.quat).invert();

    const V = this.vel.length();
    const rho = 1.225 * Math.exp(-Math.max(0, this.pos.y) / 8500);
    const q = 0.5 * rho * V * V;
    const vb = _v.copy(this.vel).applyQuaternion(_invQ);
    const alpha = V > 0.5 ? Math.atan2(-vb.y, -vb.z) : 0;
    const beta = V > 0.5 ? Math.asin(clamp(vb.x / V, -1, 1)) : 0;

    _force.set(0, -SPEC.mass * G, 0);
    _torque.set(0, 0, 0); // body-frame angular acceleration from gear, rad/s²

    // --- Aerodynamic forces ---
    const stall = SPEC.stallAlpha + flap[3];
    const cl = liftCoefficient(alpha, SPEC.cl0 + flap[1], stall, SPEC.stallAlphaNeg);
    const sinA = Math.sin(alpha);
    const cd = SPEC.cd0 + flap[2] + SPEC.inducedK * cl * cl + 0.5 * sinA * sinA + 0.3 * beta * beta;
    if (V > 0.5) {
      const vhat = _v2.copy(this.vel).divideScalar(V);
      // Lift is perpendicular to the airflow, in the aircraft's plane of symmetry.
      const liftDir = _v3.crossVectors(right, vhat);
      if (liftDir.lengthSq() > 1e-6) {
        liftDir.normalize();
        _force.addScaledVector(liftDir, q * SPEC.wingArea * cl);
      }
      _force.addScaledVector(vhat, -q * SPEC.wingArea * cd);
      _force.addScaledVector(right, -q * SPEC.wingArea * SPEC.sideForce * beta);
    }

    // --- Engine ---
    this.rpm += (700 + 1900 * c.throttle + V * 6 - this.rpm) * Math.min(1, dt * 2.5);
    const airspeedAlongNose = Math.max(0, -vb.z);
    const thrust = SPEC.maxThrust * c.throttle * Math.max(0, 1 - airspeedAlongNose / SPEC.propMaxSpeed);
    _force.addScaledVector(fwd, thrust);

    // --- Aerodynamic moments (body frame angular acceleration) ---
    const qn = Math.min(q / Q_REF, 3);
    const vn = V / 50;
    const elev = clamp(c.elevator + this.trim, -1, 1);
    const angAcc = _v2.set(
      qn * (SPEC.pitchControl * elev - SPEC.pitchStability * Math.sin(alpha - SPEC.trimAlpha)) - SPEC.pitchDamping * vn * this.omega.x,
      qn * (-SPEC.yawControl * c.rudder - SPEC.yawStability * beta) - SPEC.yawDamping * vn * this.omega.y,
      qn * (-SPEC.rollControl * c.aileron + SPEC.dihedral * beta) - SPEC.rollDamping * vn * this.omega.z,
    );
    // Stalled wings buffet and tend to drop.
    if (alpha > stall && !this.onGround) {
      const depth = Math.min(1, (alpha - stall) * 6);
      angAcc.z += qn * depth * (Math.sin(this.time * 7.3) * 2.5 + Math.sin(this.time * 2.1) * 1.5);
      angAcc.x += qn * depth * Math.sin(this.time * 23) * 0.8;
    }
    angAcc.addScaledVector(this.omega, -0.05);

    // --- Landing gear ---
    const surf = surfaceInfo(this.pos.x, this.pos.z);
    let onGround = false;
    let impact = 0;
    _omegaW.copy(this.omega).applyQuaternion(this.quat);
    for (const gear of GEAR) {
      _r.copy(gear.p).applyQuaternion(this.quat);
      const wy = this.pos.y + _r.y;
      const depth = surf.height - wy;
      if (depth <= 0) continue;
      if (surf.water) { this.crash('Ditched in the sea'); return; }
      onGround = true;
      // Velocity of the contact point.
      const pv = _v3.crossVectors(_omegaW, _r).add(this.vel);
      impact = Math.min(impact, pv.y);
      const normal = Math.max(0, gear.k * depth - gear.c * pv.y);
      // Wheel rolling direction on the ground plane.
      const steer = gear.steer ? -c.rudder * 0.35 * clamp(1 - V / 40, 0.15, 1) : 0;
      const wf = _v.set(Math.sin(-steer), 0, -Math.cos(steer)).applyQuaternion(this.quat);
      wf.y = 0;
      if (wf.lengthSq() < 1e-6) continue;
      wf.normalize();
      const sx = -wf.z, sz = wf.x;               // sideways direction
      const vl = pv.x * wf.x + pv.z * wf.z;      // rolling speed
      const vs = pv.x * sx + pv.z * sz;          // skid speed
      const mu = 0.02 + (gear.brake ? c.brake * 0.7 : 0);
      const roll = -clamp(vl / 0.3, -1, 1) * mu * normal;
      const side = -clamp(vs / 0.2, -1, 1) * 0.9 * normal;
      const f = _v.set(wf.x * roll + sx * side, normal, wf.z * roll + sz * side);
      _force.add(f);
      // Torque = r × F, converted to the body frame and divided by inertia.
      const t = _v3.crossVectors(_r, f).applyQuaternion(_invQ);
      _torque.x += t.x / SPEC.inertia.x;
      _torque.y += t.y / SPEC.inertia.y;
      _torque.z += t.z / SPEC.inertia.z;
      if (depth > 0.6) { this.crash('Landing gear collapsed'); return; }
    }

    if (onGround && !this.wasOnGround && this.airborneTime > 2) {
      const fpm = -impact * 196.85;
      if (impact < -4.5) { this.crash(`Hard landing (${Math.round(fpm)} ft/min)`); return; }
      this.events.push({ type: 'touchdown', fpm, onRunway: isOnRunway(this.pos.x, this.pos.z) });
    }
    if (!onGround) this.airborneTime += dt; else if (V < 1) this.airborneTime = 0;
    this.wasOnGround = onGround;
    this.onGround = onGround;

    // Ground contact for the airframe itself.
    for (const p of STRUCTURE) {
      _r.copy(p).applyQuaternion(this.quat).add(this.pos);
      const s = surfaceInfo(_r.x, _r.z);
      if (_r.y < s.height) {
        this.crash(s.water ? 'Crashed into the sea' : (p.y < -0.5 ? 'Belly landing' : 'Crashed into terrain'));
        return;
      }
    }

    // --- Integrate ---
    this.vel.addScaledVector(_force, dt / SPEC.mass);
    this.pos.addScaledVector(this.vel, dt);
    this.omega.addScaledVector(angAcc, dt).addScaledVector(_torque, dt);
    const w = this.omega.length();
    if (w > 1e-9) {
      _dq.setFromAxisAngle(_v.copy(this.omega).divideScalar(w), w * dt);
      this.quat.multiply(_dq).normalize();
    }

    this.gLoad = _force.dot(up) / (SPEC.mass * G) + up.y; // approx. load factor felt by the pilot
    this.thrust = thrust;
    this.updateDerived();
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.events.push({ type: 'crash', reason });
  }
}
