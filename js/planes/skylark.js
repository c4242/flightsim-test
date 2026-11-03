// Skylark: light single-engine piston trainer (about 1,100 kg, 180 hp), loosely in the class of
// a Piper Cherokee / Cessna 172. Classic aerodynamic flight model with direct control surfaces.

import * as THREE from 'three';
import { clamp } from '../noise.js';

const Q_REF = 0.5 * 1.225 * 50 * 50;

const P = {
  wingArea: 16, span: 11,
  cl0: 0.28, clAlpha: 5.0, stallAlpha: 0.27, stallAlphaNeg: -0.2,
  cd0: 0.028, inducedK: 0.055, sideForce: 0.6,
  maxThrust: 5200, propMaxSpeed: 105,
  flaps: [[0, 0, 0, 0], [15, 0.3, 0.012, -0.02], [30, 0.55, 0.035, -0.035]], // [deg, ΔCL, ΔCD, Δstall α]
  pitchControl: 4.6, pitchStability: 12, pitchDamping: 4.0, trimAlpha: 0.03,
  rollControl: 7.0, rollDamping: 4.5, dihedral: 1.5,
  yawControl: 2.0, yawStability: 5.0, yawDamping: 2.0,
  adverseYaw: 0.35, propYaw: 0.3, phugoidDamping: 0.3,
};

function liftCoefficient(alpha, cl0, stall, stallNeg) {
  const clMax = cl0 + P.clAlpha * stall;
  const clMin = cl0 + P.clAlpha * stallNeg;
  if (alpha > stall) return Math.max(clMax - 4 * (alpha - stall), Math.sin(2 * alpha));
  if (alpha < stallNeg) return Math.min(clMin + 4 * (stallNeg - alpha), Math.sin(2 * alpha));
  return cl0 + P.clAlpha * alpha;
}

export const SKYLARK = {
  id: 'skylark',
  name: 'Skylark (light prop)',
  kind: 'prop',
  wingArea: P.wingArea,
  span: P.span,
  inertia: new THREE.Vector3(2500, 3000, 1500), // pitch, yaw, roll (kg m²)
  contactY: -1.35,
  retractableGear: false,
  gear: [
    { p: new THREE.Vector3(0, -1.35, -2.6), steer: true, brake: false, k: 40000, c: 4000 },
    { p: new THREE.Vector3(-1.3, -1.35, 0.3), steer: false, brake: true, k: 55000, c: 5000 },
    { p: new THREE.Vector3(1.3, -1.35, 0.3), steer: false, brake: true, k: 55000, c: 5000 },
  ],
  structure: [
    { p: new THREE.Vector3(0, 0, -3.8) },                     // spinner
    { p: new THREE.Vector3(0, -0.15, 4.4) },                  // tail cone
    { p: new THREE.Vector3(0, 1.45, 4.3) },                   // fin tip
    { p: new THREE.Vector3(-5.5, -0.15, 0.2), wingtip: true },
    { p: new THREE.Vector3(5.5, -0.15, 0.2), wingtip: true },
    { p: new THREE.Vector3(-1.8, 0.05, 4.0) }, { p: new THREE.Vector3(1.8, 0.05, 4.0) },
    { p: new THREE.Vector3(0, -0.75, -0.5), belly: true },
  ],
  steer: { angle: 0.35, fadeSpeed: 40 },
  brakeMu: 0.7,
  maxSink: 4.5,          // m/s; harder than this breaks the gear
  goodSink: 120,         // ft/min for a perfect landing score
  limits: { vne: 85, vBreak: 100, gLimit: [-3.5, 7], gWarn: [-2.5, 5] },
  flapDetents: [0, 15, 30],

  reset(ac, spawn) {
    ac.flaps = spawn.flaps ?? 0;
    ac.mass = 1100;
    ac.rpm = 700 + 1900 * (spawn.throttle ?? 0) + (spawn.speed ?? 0) * 6;
    ac.prevV = undefined;
    ac.accel = 0;
  },

  aero(ac, s) {
    const flap = P.flaps[ac.flaps];
    const stall = P.stallAlpha + flap[3];
    const cl = liftCoefficient(s.alpha, P.cl0 + flap[1], stall, P.stallAlphaNeg) * (1 + 0.12 * (1 - s.ge));
    const sinA = Math.sin(s.alpha);
    const cd = P.cd0 + flap[2] + P.inducedK * s.ge * cl * cl + 0.5 * sinA * sinA + 0.3 * s.beta * s.beta;
    return { cl, cd, side: -P.sideForce * s.beta };
  },

  engine(ac, s, dt) {
    const c = ac.controls;
    // A failed engine windmills in the airflow, gives no thrust and adds drag.
    const rpmTarget = ac.engineFailed ? Math.max(0, s.V * 14 - 150) : 700 + 1900 * c.throttle + s.V * 6;
    ac.rpm += (rpmTarget - ac.rpm) * Math.min(1, dt * (ac.engineFailed ? 0.8 : 2.5));
    const power = ac.engineFailed ? 0 : c.throttle;
    ac.power = power;
    return P.maxThrust * power * Math.max(0, 1 - Math.max(0, s.u) / P.propMaxSpeed)
      - (ac.engineFailed ? s.q * P.wingArea * 0.008 : 0);
  },

  moments(ac, s, dt, angAcc) {
    const c = ac.controls;
    const flap = P.flaps[ac.flaps];
    const stall = P.stallAlpha + flap[3];
    const qn = Math.min(s.q / Q_REF, 3);
    const vn = s.V / 50;
    // Propeller slipstream over the tail keeps the elevator and rudder working at low speed.
    const slip = ac.power * 0.35 * clamp(1 - vn, 0, 1);
    const qTail = qn + slip;
    const elev = clamp(c.elevator + ac.trim, -1, 1);
    const w = ac.omega;
    angAcc.set(
      qTail * P.pitchControl * elev - qn * P.pitchStability * Math.sin(s.alpha - P.trimAlpha) - P.pitchDamping * vn * w.x,
      -qTail * P.yawControl * c.rudder - qn * P.yawStability * s.beta - P.yawDamping * vn * w.y
        + qn * P.adverseYaw * c.aileron + P.propYaw * slip,
      qn * (-P.rollControl * c.aileron + P.dihedral * s.beta) - P.rollDamping * vn * w.z,
    );
    // Stalled wings buffet and tend to drop.
    if (s.alpha > stall && !ac.onGround) {
      const depth = Math.min(1, (s.alpha - stall) * 6);
      angAcc.z += qn * depth * (Math.sin(ac.time * 7.3) * 2.5 + Math.sin(ac.time * 2.1) * 1.5);
      angAcc.x += qn * depth * Math.sin(ac.time * 23) * 0.8;
    }
    angAcc.addScaledVector(w, -0.05);
    // Accelerating along the flight path raises the nose a little, damping the phugoid.
    if (ac.prevV !== undefined && !ac.onGround) {
      ac.accel += ((s.V - ac.prevV) / dt - ac.accel) * Math.min(1, dt * 4);
      angAcc.x += P.phugoidDamping * qn * clamp(ac.accel, -1.5, 1.5);
    }
    ac.prevV = s.V;
  },

  stallWarning(ac) {
    const stall = P.stallAlpha + P.flaps[ac.flaps][3];
    return !ac.onGround && ac.tas > 5 && ac.alpha > stall - 0.03;
  },
};
