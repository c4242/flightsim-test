// Skylark: light single-engine piston trainer (about 1,100 kg, 180 hp), in the class of a Cessna 172
// or Piper Cherokee.
//
// Aerodynamics: stability and control derivatives of the Cessna 172 (Roskam, "Airplane Flight
// Dynamics and Automatic Flight Controls", appendix B), with each wing computed separately at its
// own local angle of attack and airspeed. That gives roll damping and roll due to yaw rate, and
// beyond the stall it gives wing drop and autorotation: the descending wing is deeper in the stall,
// loses lift and gains drag, so a stall with yaw can develop into a spin.
//
// Propeller: engine torque rolls the aircraft left, slipstream swirl and P-factor yaw it left at
// high power and low speed (right rudder on the takeoff roll and in the climb), the spinning
// propeller precesses when the aircraft pitches or yaws, and propwash over the tail keeps the
// elevator and rudder effective at low airspeed.

import * as THREE from 'three';
import { clamp } from '../noise.js';

// Geometry (m, m²) and inertia (kg m²: roll, pitch, yaw).
const S = 16, B = 11, CBAR = 1.49;
const IX = 1285, IY = 1825, IZ = 2667;
const Y_PANEL = 2.2;        // spanwise station representing each wing's lift (m)
const DISK = 2.84;          // propeller disk area (m²)
const POWER = 134000;       // 180 hp (W)
const I_PROP = 1.4;         // propeller and crankshaft (kg m²)
// Cruise rigging (see moments): torque and yaw at cruise power (40% throttle, 52 m/s, α ≈ 2°,
// about 1,770 rpm in this engine model), scaled with dynamic pressure.
const CR_THR = 0.4, CR_V = 52, CR_ALPHA = 0.035;
const Q_CRUISE = 0.5 * 1.225 * CR_V * CR_V;
const RIG_ROLL = POWER * CR_THR / ((700 + 1900 * CR_THR + CR_V * 6) * Math.PI / 30);
const RIG_YAW = 5200 * CR_THR * (1 - CR_V / 105) * (0.07 * (1 - CR_V / 60) + 0.3 * CR_ALPHA);

const P = {
  wingArea: S, span: B,
  cl0: 0.31, clAlpha: 5.14, stallAlpha: 0.27, stallAlphaNeg: -0.2,
  cd0: 0.028, inducedK: 0.055,
  maxThrust: 5200, propMaxSpeed: 105,
  flaps: [[0, 0, 0, 0], [15, 0.3, 0.012, -0.02], [30, 0.55, 0.035, -0.035]], // [deg, ΔCL, ΔCD, Δstall α]
  // Derivatives (per radian; rates non-dimensional). Cm0 is set so neutral stick and trim fly at
  // about 3° angle of attack (≈105 kt clean), as the aircraft is rigged.
  clq: 3.9, clDe: 0.43,
  cm0: 0.027, cmAlpha: -0.89, cmq: -12.4, cmAlphaDot: -5.2, cmDe: -1.28,
  cyBeta: -0.31, cyDr: 0.187,
  clBeta: -0.089, clDa: 0.178, clDr: 0.0147,
  cnBeta: 0.065, cnr: -0.099, cnp: -0.03, cnDa: -0.053, cnDr: 0.0657,
  // Surface travel (rad): elevator 28° up / 23° down, ailerons ±20°, rudder ±16°.
  elevUp: 0.49, elevDown: 0.40, ail: 0.35, rud: 0.28,
};

// Section lift of one wing panel: linear, then a post-stall drop that settles towards a flat plate.
function liftCoefficient(alpha, cl0, stall, stallNeg) {
  const clMax = cl0 + P.clAlpha * stall;
  const clMin = cl0 + P.clAlpha * stallNeg;
  if (alpha > stall) return Math.max(clMax - 1.1 * (alpha - stall), Math.sin(2 * alpha) * 1.1);
  if (alpha < stallNeg) return Math.min(clMin + 1.1 * (stallNeg - alpha), Math.sin(2 * alpha) * 1.1);
  return cl0 + P.clAlpha * alpha;
}
function panelDrag(cl, alpha, stall, flapCd, ge) {
  const sa = Math.sin(alpha);
  // Past the stall the separated wing's drag climbs towards a flat plate's (≈0.5 at 30°).
  return P.cd0 + flapCd + P.inducedK * ge * cl * cl + 0.5 * sa * sa + (alpha > stall ? 1.0 * Math.min(alpha - stall, 0.6) : 0);
}

export const SKYLARK = {
  id: 'skylark',
  name: 'Skylark (light prop)',
  kind: 'prop',
  wingArea: P.wingArea,
  span: P.span,
  inertia: new THREE.Vector3(IY, IZ, IX), // pitch, yaw, roll (kg m²)
  contactY: -1.35,
  retractableGear: false,
  gear: [
    { p: new THREE.Vector3(0, -1.35, -2.6), steer: true, brake: false, k: 40000, c: 4000 },
    { p: new THREE.Vector3(-1.3, -1.35, 0.55), steer: false, brake: true, k: 55000, c: 5000 },
    { p: new THREE.Vector3(1.3, -1.35, 0.55), steer: false, brake: true, k: 55000, c: 5000 },
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
    ac.alphaDot = 0;
    ac.prevAlpha = undefined;
    ac.propThrust = 0;
    ac._sk = {};
  },

  aero(ac, s) {
    const c = ac.controls;
    const flap = P.flaps[ac.flaps];
    const stall = P.stallAlpha + flap[3];
    const V = Math.max(s.V, 3);
    const w = ac.omega, p = -w.z, q = w.x, r = -w.y;     // roll right, pitch up, yaw right
    const ge = s.ge;
    // Control surfaces (rad). Positive elevator here is trailing edge down (nose down).
    const elev = clamp(c.elevator + ac.trim, -1, 1);
    const de = -elev * (elev > 0 ? P.elevUp : P.elevDown);
    const da = clamp(c.aileron, -1, 1) * P.ail;         // + rolls right
    const dr = clamp(c.rudder, -1, 1) * P.rud;          // + yaws right
    // Propwash over the tail: extra dynamic pressure for the elevator and rudder at high power.
    const qTail = s.q + 0.5 * Math.max(0, ac.propThrust) / DISK;
    const kTail = Math.min(40, qTail / Math.max(s.q, 1));

    // Each wing at its own angle of attack (roll rate) and airspeed (yaw rate). A slight, slowly
    // wandering difference between the wings decides which one drops first at the stall.
    const asym = 0.008 * Math.sin(ac.time * 0.37 + 1.3) + 0.005 * Math.sin(ac.time * 1.13);
    const dA = clamp(p * Y_PANEL / V, -0.6, 0.6), dV = clamp(r * Y_PANEL / V, -0.5, 0.5);
    const aR = s.alpha + dA, aL = s.alpha - dA;
    const qR = (1 - dV) * (1 - dV), qL = (1 + dV) * (1 + dV);
    const clR = liftCoefficient(aR, P.cl0 + flap[1], stall + asym, P.stallAlphaNeg);
    const clL = liftCoefficient(aL, P.cl0 + flap[1], stall - asym, P.stallAlphaNeg);
    const cdR = panelDrag(clR, aR, stall, flap[2], ge), cdL = panelDrag(clL, aL, stall, flap[2], ge);
    const cq = CBAR / (2 * V), b2v = B / (2 * V);

    let cl = 0.5 * (clR * qR + clL * qL) * (1 + 0.12 * (1 - ge)) + P.clq * cq * q + P.clDe * de * kTail;
    const cd = 0.5 * (cdR * qR + cdL * qL) + 0.3 * s.beta * s.beta;
    const cy = P.cyBeta * s.beta - P.cyDr * dr * kTail;

    // Moments (coefficients): roll right, pitch up, yaw right positive.
    // Past the stall the fuselage and tail add rotary damping (it's what limits the rotation of a
    // developed spin); the cruise derivatives don't include it.
    const deep = clamp((s.alpha - stall) / 0.2, 0, 1);
    const k = ac._sk;
    k.cl = Y_PANEL * (clL * qL - clR * qR) / (2 * B)
      + P.clBeta * s.beta + P.clDa * da + P.clDr * dr * kTail - 0.08 * deep * b2v * p;
    k.cn = P.cnBeta * s.beta + P.cnDr * dr * kTail + P.cnDa * da + b2v * ((P.cnr - 0.08 * deep) * r + P.cnp * p)
      + Y_PANEL * (cdR * qR - cdL * qL) / (2 * B);
    const aEff = s.alpha;
    k.cm = P.cm0 + P.cmAlpha * aEff + P.cmDe * de * kTail + cq * (P.cmq * q + P.cmAlphaDot * ac.alphaDot)
      - (aEff > stall ? 0.15 * Math.min(aEff - stall, 0.3) : 0);   // the nose drops when the wing stalls
    s.sk = k;
    return { cl, cd, side: cy };
  },

  engine(ac, s, dt) {
    const c = ac.controls;
    // A failed engine windmills in the airflow, gives no thrust and adds drag.
    const rpmTarget = ac.engineFailed ? Math.max(0, s.V * 14 - 150) : 700 + 1900 * c.throttle + s.V * 6;
    ac.rpm += (rpmTarget - ac.rpm) * Math.min(1, dt * (ac.engineFailed ? 0.8 : 2.5));
    const power = ac.engineFailed ? 0 : c.throttle;
    ac.power = power;
    const thrust = P.maxThrust * power * Math.max(0, 1 - Math.max(0, s.u) / P.propMaxSpeed)
      - (ac.engineFailed ? s.q * P.wingArea * 0.008 : 0);
    ac.propThrust = thrust;
    return thrust;
  },

  moments(ac, s, dt, angAcc) {
    const w = ac.omega, p = -w.z, q = w.x, r = -w.y;
    const k = s.sk;
    const qS = s.q * S;
    let L = qS * B * k.cl, M = qS * CBAR * k.cm, N = qS * B * k.cn;
    // Propeller (turning clockwise seen from the cockpit).
    const omegaP = Math.max(20, ac.rpm * Math.PI / 30);
    const shaft = POWER * ac.power * Math.min(1, s.atm.sigma ?? 1);
    const T = Math.max(0, ac.propThrust), V = Math.max(s.V, 3);
    L -= shaft / omegaP;                                          // torque reaction rolls left
    N -= T * (0.07 * clamp(1 - V / 60, 0, 1) + 0.3 * clamp(s.alpha, -0.1, 0.35)); // swirl on the fin, P-factor
    // Rigging: the fin offset and fixed tabs cancel these at cruise power (about 100 kt),
    // as on the real aircraft, so it flies straight hands-off in cruise but needs right rudder
    // at full power and low speed (takeoff, climb) and a little left rudder in a fast descent.
    L += RIG_ROLL * s.q / Q_CRUISE;
    N += RIG_YAW * s.q / Q_CRUISE;
    const H = I_PROP * omegaP * (ac.rpm > 100 ? 1 : 0);           // gyroscopic precession
    M -= r * H;
    N += q * H;
    // Euler's equations (the product of inertia is negligible on this layout).
    const pd = (L + (IY - IZ) * q * r) / IX;
    const qd = (M + (IZ - IX) * p * r) / IY;
    const rd = (N + (IX - IY) * p * q) / IZ;
    angAcc.set(qd, -rd, -pd);
    // Rate of change of angle of attack (for the downwash lag at the tail).
    if (ac.prevAlpha !== undefined && !ac.onGround) ac.alphaDot += (clamp((s.alpha - ac.prevAlpha) / dt, -3, 3) - ac.alphaDot) * Math.min(1, dt * 30);
    else ac.alphaDot = 0;
    ac.prevAlpha = s.alpha;
  },

  stallWarning(ac) {
    const stall = P.stallAlpha + P.flaps[ac.flaps][3];
    return !ac.onGround && ac.tas > 5 && ac.alpha > stall - 0.03;
  },
};
