// F-16C Block 50 (General Dynamics / Lockheed Martin Fighting Falcon) with an F110-GE-129 engine.
//
// Sources for the numbers: published F-16C dimensions and weights, the moments of inertia and
// engine thrust tables of the F-16 model in Stevens & Lewis, "Aircraft Control and Simulation"
// (from NASA TP-1538), scaled to the installed thrust of the F110-GE-129, and typical published
// performance (≈M0.92 at military power at sea level, M2.05 at altitude, 9 g, 25° AoA limit).
//
// The flight control system is a simplified model of the real one: the side-stick commands
// normal load factor (G) in pitch, limited by an angle-of-attack limiter, and roll rate about the
// velocity vector; sideslip is automatically suppressed. With the landing gear down it switches
// to "takeoff and landing" gains: the stick commands pitch rate and neutral stick holds AoA.

import * as THREE from 'three';
import { clamp, smoothstep, lerp } from '../noise.js';

const G = 9.81;
const LBF = 4.44822;
const S_REF = 27.87;          // m²
const EMPTY = 9170;           // kg: operating empty + pilot + two AIM-9s and rails
export const FUEL_MAX = 3175; // kg internal (7,000 lb)

// ---------- Engine (thrust tables in lbf, Mach 0..1 by 0.2, altitude 0..50,000 ft by 10,000) ----------
const IDLE = [
  [1060, 670, 880, 1140, 1500, 1860], [635, 425, 690, 1010, 1330, 1700], [60, 25, 345, 755, 1130, 1525],
  [-1020, -710, -300, 350, 910, 1360], [-2700, -1900, -1300, -247, 600, 1100], [-3600, -1400, -595, -342, -200, 700],
];
const MIL = [
  [12680, 9150, 6200, 3950, 2450, 1400], [12680, 9150, 6313, 4040, 2470, 1400], [12610, 9312, 6610, 4290, 2600, 1560],
  [12640, 9839, 7090, 4660, 2840, 1660], [12390, 10176, 7750, 5320, 3250, 1930], [11680, 9848, 8050, 6100, 3800, 2310],
];
const MAX = [
  [20000, 15000, 10800, 7000, 4000, 2500], [21420, 15700, 11225, 7323, 4435, 2600], [22700, 16860, 12250, 8154, 5000, 2835],
  [24240, 18910, 13760, 9285, 5700, 3215], [26070, 21075, 15975, 11115, 6860, 3950], [28886, 23319, 18300, 13484, 8642, 5057],
];
// Scale the F100 installed thrust tables to the F110-GE-129 (about 17,000 lbf dry / 29,000 lbf
// with afterburner uninstalled; roughly 15,000 / 25,500 lbf installed at static sea level).
const MIL_SCALE = 15000 / 12680, MAX_SCALE = 25500 / 20000;

function table(t, mach, altFt) {
  const hi = clamp(altFt / 10000, 0, 4.999);
  const h0 = Math.floor(hi), hf = hi - h0;
  const at = (mi) => lerp(t[mi][h0], t[mi][h0 + 1], hf);
  if (mach <= 1) {
    const mi = clamp(mach / 0.2, 0, 4.999);
    const m0 = Math.floor(mi);
    return lerp(at(m0), at(m0 + 1), mi - m0);
  }
  // Above Mach 1: continue with part of the ram-recovery trend, then fall away past Mach 2.
  const t1 = at(5), slope = (t1 - at(4)) / 0.2;
  return t1 + Math.max(0, slope) * 0.5 * (mach - 1);
}

export function engineThrust(n, abLevel, abLit, mach, altFt) {
  const idle = table(IDLE, mach, altFt);
  const mil = table(MIL, mach, altFt) * MIL_SCALE;
  // Core speed (N2, 0.68 at idle to 1.0 at military power) to dry thrust.
  const f = clamp((n - 0.68) / 0.32, 0, 1);
  let lbf = idle + (mil - idle) * Math.pow(f, 1.6);
  if (abLit) {
    const max = table(MAX, mach, altFt) * MAX_SCALE;
    lbf = mil + (max - mil) * (0.3 + 0.7 * abLevel);
  }
  // Inlet and nozzle limits above Mach 2.
  if (mach > 2.0) lbf *= clamp(1 - (mach - 2.0) * 4, 0, 1);
  return lbf * LBF;
}

// ---------- Aerodynamics ----------
function liftSlope(M) {
  if (M < 0.95) return 3.5 + 0.8 * smoothstep(0.5, 0.95, M);
  const sup = Math.min(4.3, 3.6 / Math.sqrt(Math.max(0.01, M * M - 1)));
  return lerp(4.3, sup, smoothstep(0.95, 1.25, M));
}

// Lift coefficient vs angle of attack: linear, then vortex lift from the strakes up to a peak
// around 34°, then a gradual post-stall decline.
export function liftCoefficient(alpha, M) {
  const a = liftSlope(M);
  const sign = Math.sign(alpha) || 1;
  let x = Math.abs(alpha);
  const neg = alpha < 0;
  const kneeA = neg ? 0.2 : 0.32, peakA = neg ? 0.35 : 0.6;
  let cl;
  if (x <= kneeA) cl = a * x;
  else if (x <= peakA) cl = a * kneeA + a * 0.55 * (x - kneeA) - a * 0.2 * (x - kneeA) * (x - kneeA);
  else {
    const peak = a * kneeA + a * 0.55 * (peakA - kneeA) - a * 0.2 * (peakA - kneeA) ** 2;
    cl = Math.max(peak - 2.2 * (x - peakA), 1.25 * Math.sin(2 * Math.min(x, Math.PI / 2)));
  }
  return sign * cl;
}

// Angle of attack that produces a given lift coefficient (bisection on the real curve up to its peak).
function alphaForCL(cl, M) {
  let lo = -0.35, hi = 0.6;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (liftCoefficient(mid, M) < cl) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function parasiteDrag(M) {
  // Clean with wingtip missiles ≈0.0235 subsonic; transonic drag rise peaking near M1.1; wave drag above.
  return 0.0235 + 0.026 * smoothstep(0.82, 1.08, M) - 0.0075 * smoothstep(1.15, 2.0, M);
}
const inducedK = (M) => 0.117 + 0.18 * smoothstep(0.9, 1.6, M);

export const F16 = {
  id: 'f16',
  name: 'F-16C Fighting Falcon',
  kind: 'jet',
  wingArea: S_REF,
  span: 9.96,
  // Pitch, yaw, roll moments of inertia (kg m²), Stevens & Lewis.
  inertia: new THREE.Vector3(75674, 85552, 12875),
  contactY: -1.72,
  retractableGear: true,
  fuelMax: FUEL_MAX,
  gearTime: 4,
  gear: [
    { p: new THREE.Vector3(0, -1.72, -3.4), steer: true, brake: false, k: 180000, c: 30000, collapse: 0.5 },
    { p: new THREE.Vector3(-1.18, -1.72, 0.65), steer: false, brake: true, k: 420000, c: 55000, collapse: 0.5 },
    { p: new THREE.Vector3(1.18, -1.72, 0.65), steer: false, brake: true, k: 420000, c: 55000, collapse: 0.5 },
  ],
  structure: [
    { p: new THREE.Vector3(0, 0, -9.0) },                          // pitot / nose
    { p: new THREE.Vector3(0, -0.95, -4.6), belly: true },         // intake lip
    { p: new THREE.Vector3(0, -1.0, 0.0), belly: true },           // belly
    { p: new THREE.Vector3(0, -0.18, 6.4), tail: true },           // nozzle: strikes at ~15° pitch on the mains
    { p: new THREE.Vector3(-0.6, -0.77, 4.2), tail: true },        // ventral fins
    { p: new THREE.Vector3(0.6, -0.77, 4.2), tail: true },
    { p: new THREE.Vector3(-2.75, -0.3, 6.0), tail: true },        // stabilator tips
    { p: new THREE.Vector3(2.75, -0.3, 6.0), tail: true },
    { p: new THREE.Vector3(0, 3.1, 6.3) },                         // fin tip
    { p: new THREE.Vector3(-4.98, -0.12, 0.9), wingtip: true },    // wingtip missiles
    { p: new THREE.Vector3(4.98, -0.12, 0.9), wingtip: true },
  ],
  steer: { angle: 0.5, fadeSpeed: 45 },
  brakeMu: 0.5,             // anti-skid wheel brakes
  maxSink: 4.0,             // m/s (≈13 ft/s): the gear fails beyond this
  goodSink: 300,            // ft/min: a firm, positive touchdown is normal for a jet
  limits: {
    vne: 411,               // 800 KCAS
    vBreak: 490,            // ≈950 KCAS
    mmo: 2.05, mBreak: 2.25,
    vGearBreak: 175,        // gear limit 300 KCAS; it fails around 340
    gLimit: [-4.5, 11.5],   // the FCS keeps you inside -3..+9; the airframe fails beyond these
    gWarn: [-2.6, 9.2],
  },

  reset(ac, spawn) {
    ac.flaps = 0;
    ac.fuel = spawn.fuel ?? FUEL_MAX;
    ac.mass = EMPTY + ac.fuel;
    const thr = spawn.throttle ?? 0;
    // Core speed starts where the throttle is (no spool-up on spawn).
    ac.n2 = thr <= 0.8 ? lerp(0.68, 1.0, thr / 0.8) : 1.0;
    ac.ab = 0;
    ac.abLit = false;
    ac.abTimer = 0;
    ac.fuelFlow = 0;
    ac.nozzle = 0;
    ac.alphaCmd = 0;
    ac.nzInt = 0;
    ac.alphaRef = spawn.onGround ? 0 : 0.22;
    ac.rpm = ac.n2 * 100;
    ac.fcsMode = ac.gearHandle ? 'TO/L' : 'CR';
  },

  aero(ac, s) {
    const M = s.mach;
    const tef = ac.gearDown; // trailing-edge flaps droop 20° with the gear handle down
    const cl = (liftCoefficient(s.alpha, M) + 0.18 * tef * (Math.abs(s.alpha) < 0.5 ? 1 : 0)) * (1 + 0.1 * (1 - s.ge));
    const sinA = Math.sin(s.alpha);
    const cd = parasiteDrag(M)
      + inducedK(M) * s.ge * cl * cl
      + 0.55 * sinA * sinA
      + 0.5 * s.beta * s.beta
      + 0.016 * ac.gearDown + 0.012 * tef
      + 0.065 * ac.speedbrake
      + (ac.engineFailed || ac.fuel <= 0 ? 0.004 : 0);
    return { cl, cd, side: -1.0 * s.beta };
  },

  engine(ac, s, dt) {
    const c = ac.controls;
    const flamedOut = ac.engineFailed || ac.fuel <= 0;
    const thr = c.throttle;
    // Throttle: 0..0.8 idle to military power, 0.8..1 afterburner zones.
    const nTarget = flamedOut ? clamp(0.12 + s.mach * 0.18, 0, 0.35) : thr <= 0.8 ? lerp(0.68, 1.0, thr / 0.8) : 1.0;
    // Spool-up is slow at low core speed (idle to MIL takes about 4-5 s), spool-down quicker.
    const tau = nTarget > ac.n2 ? (ac.n2 < 0.85 ? 1.6 : 0.6) : 0.9;
    ac.n2 += (nTarget - ac.n2) * Math.min(1, dt / tau);
    const abCmd = !flamedOut && thr > 0.8 ? (thr - 0.8) / 0.2 : 0;
    if (abCmd > 0 && ac.n2 > 0.96) {
      ac.abTimer += dt;
      if (ac.abTimer > 0.7) ac.abLit = true; // ignition delay
    } else { ac.abTimer = 0; ac.abLit = false; }
    ac.ab += ((ac.abLit ? abCmd : 0) - ac.ab) * Math.min(1, dt / 0.5);
    ac.nozzle += ((ac.abLit ? 0.3 + 0.7 * ac.ab : ac.n2 < 0.8 ? 0.35 : 0.05) - ac.nozzle) * Math.min(1, dt * 2);
    const altFt = Math.max(0, ac.pos.y) * 3.28084;
    let thrust = flamedOut ? table(IDLE, s.mach, altFt) * LBF * 0.15 - 2000 : engineThrust(ac.n2, ac.ab, ac.abLit, s.mach, altFt);
    // Fuel: about 0.7 lb/lbf/h dry and 1.9 with the afterburner lit; never less than idle flow.
    if (!flamedOut) {
      const lbf = Math.max(0, thrust / LBF);
      const pph = Math.max(900 * (s.atm.delta + 0.15), lbf * (ac.abLit ? 1.9 : 0.7));
      ac.fuelFlow = pph;
      ac.fuel = Math.max(0, ac.fuel - pph * 0.4536 / 3600 * dt);
      ac.mass = EMPTY + ac.fuel;
    } else {
      ac.fuelFlow = 0;
      thrust = Math.min(thrust, 0);
    }
    ac.power = clamp((ac.n2 - 0.68) / 0.32, 0, 1);
    ac.rpm = ac.n2 * 100;
    return thrust;
  },

  // Fly-by-wire control laws. They produce body angular accelerations, limited by how much
  // control power the stabilators, flaperons and rudder have at the current dynamic pressure.
  moments(ac, s, dt, angAcc) {
    const c = ac.controls;
    const w = ac.omega;
    const qk = s.q / 1000; // kPa
    const gearMode = ac.gearHandle || ac.gearDown > 0.01;
    ac.fcsMode = gearMode ? 'TO/L' : 'CR';
    const stick = clamp(c.elevator, -1, 1);

    // --- Pitch ---
    let qCmd;
    if (!gearMode) {
      // G command: neutral stick = 1 g; full aft 9 g, full forward -3 g; trim biases it.
      const nz = clamp(1 + (stick >= 0 ? stick * 8 : stick * 4) + ac.trim * 2, -3, 9);
      // Angle of attack needed for that load factor, then the AoA limiter (25° / -5°).
      const clReq = nz * ac.mass * G / Math.max(200, s.q * S_REF);
      // Integral action on the G error trims out modelling errors (thrust, gravity, lag).
      const nzErr = nz - s.nz;
      if (Math.abs(nzErr) < 2 && !ac.onGround) ac.nzInt = clamp(ac.nzInt + nzErr * 0.06 * dt, -0.05, 0.05);
      ac.alphaCmd = clamp(alphaForCL(clReq, s.mach) + ac.nzInt, -0.087, 0.436);
      if (ac.alphaCmd >= 0.436 || ac.alphaCmd <= -0.087) ac.nzInt *= 1 - dt; // no wind-up on the limiter
      const err = clamp(ac.alphaCmd - s.alpha, -0.25, 0.25);
      qCmd = s.gammaDot + clamp(err * 5, -0.6, 0.6);
    } else {
      // Takeoff and landing gains: the stick commands pitch rate; released, the system holds the
      // angle of attack it was left at (trim nudges it). AoA is limited to 20°.
      if (ac.onGround) {
        qCmd = stick * 0.3;
        ac.alphaRef = s.alpha;
      } else if (Math.abs(stick) > 0.04) {
        qCmd = s.gammaDot + stick * 0.3;
        ac.alphaRef = s.alpha;
      } else {
        ac.alphaRef = clamp(ac.alphaRef + ac.trim * 0.05 * dt, -0.05, 0.35);
        qCmd = s.gammaDot + clamp((ac.alphaRef - s.alpha) * 3, -0.25, 0.25);
      }
      if (s.alpha > 0.35 && !ac.onGround) qCmd = Math.min(qCmd, s.gammaDot - (s.alpha - 0.35) * 3);
      ac.alphaCmd = ac.alphaRef;
      ac.nzInt = 0;
    }
    const pitchAuth = clamp(0.55 * qk, 0.05, 9);
    angAcc.x = clamp(10 * (qCmd - w.x), -pitchAuth, pitchAuth)
      - 0.06 * qk * Math.sin(s.alpha - 0.05);             // weak natural stability (relaxed static stability)

    // --- Roll and yaw: roll-rate command about the velocity vector, sideslip suppressed ---
    const a = clamp(c.aileron, -1, 1);
    const shaped = 0.35 * a + 0.65 * a * Math.abs(a);
    let pMax = gearMode ? 2.0 : 4.7;                       // 270°/s clean
    pMax *= clamp(qk / 8, 0.2, 1) * (1 - clamp((s.alpha - 0.26) / 0.3, 0, 0.7));
    const p = shaped * pMax;
    const ca = Math.cos(clamp(s.alpha, -0.5, 0.6)), sa = Math.sin(clamp(s.alpha, -0.5, 0.6));
    const rollDes = -p * ca;                               // body z (roll left positive)
    let yawDes = -p * sa;                                  // body y (yaw left positive)
    yawDes += -2.5 * s.beta;                               // sideslip feedback (turn coordination)
    yawDes += -c.rudder * 0.35 * clamp(qk / 5, 0, 1);       // pedals
    const rollAuth = clamp(1.6 * qk, 0.3, 25);
    const yawAuth = clamp(0.3 * qk, 0.1, 4);
    angAcc.z = clamp(12 * (rollDes - w.z), -rollAuth, rollAuth);
    angAcc.y = clamp(5 * (yawDes - w.y), -yawAuth, yawAuth) - 0.08 * qk * s.beta;
    // Above the AoA limit (e.g. a stall at very low speed) the aircraft wallows and buffets.
    if (s.alpha > 0.5 && !ac.onGround) {
      const d = Math.min(1, (s.alpha - 0.5) * 4);
      angAcc.z += d * qk * (Math.sin(ac.time * 5.3) * 0.8);
      angAcc.y += d * qk * Math.sin(ac.time * 3.1) * 0.3;
    }
  },

  stallWarning(ac) {
    // AoA above the limiter, or very slow while airborne.
    return !ac.onGround && ac.tas > 20 && (ac.alpha > 0.45 || (ac.ias < 60 && ac.alpha > 0.2));
  },
};
