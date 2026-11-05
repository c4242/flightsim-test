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
import { f16Coefficients, AERO_S, AERO_B, AERO_CBAR } from './f16aero.js';

const G = 9.81;
// Centre of gravity (fraction of the mean aerodynamic chord): slightly ahead of the 0.35 reference,
// so the airframe is close to neutrally stable, as the real relaxed-stability F-16.
const XCG = 0.34;
// Moments of inertia (kg m²) and the engine's angular momentum at full core speed (kg m²/s),
// from Stevens & Lewis (9,496 / 55,814 / 63,100 / 982 slug ft² and 160 slug ft²/s).
const JX = 12875, JY = 75674, JZ = 85552, JXZ = 1331, HENG = 216.9;
const GAM = JX * JZ - JXZ * JXZ;
const C1 = ((JY - JZ) * JZ - JXZ * JXZ) / GAM, C2 = ((JX - JY + JZ) * JXZ) / GAM, C3 = JZ / GAM, C4 = JXZ / GAM;
const C5 = (JZ - JX) / JY, C6 = JXZ / JY, C7 = 1 / JY, C8 = (JX * (JX - JY) + JXZ * JXZ) / GAM, C9 = JX / GAM;
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

// Steady lift coefficient vs angle of attack from the aerodynamic data (no rates, stabilator near
// trim), with the compressibility factor. Used by the flight control computer's G command.
const _lc = {};
export function liftCoefficient(alpha, M) {
  const c = f16Coefficients(alpha, 0, -2, 0, 0, 0, 0, 0, 100, XCG, _lc);
  return c.cx * Math.sin(alpha) - c.cz * (liftSlope(M) / liftSlope(0.3)) * Math.cos(alpha);
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
  // Gear and airframe points match the FlightGear F-16 model (see js/model-f16fg.js): wheelbase
  // 3.6 m, main-gear track 2.46 m, tail strike at about 17° of pitch on the main wheels.
  contactY: -1.85,
  retractableGear: true,
  fuelMax: FUEL_MAX,
  gearTime: 4,
  gear: [
    { p: new THREE.Vector3(0, -1.85, -2.98), steer: true, brake: false, k: 180000, c: 30000, collapse: 0.5 },
    { p: new THREE.Vector3(-1.23, -1.85, 0.6), steer: false, brake: true, k: 420000, c: 55000, collapse: 0.5 },
    { p: new THREE.Vector3(1.23, -1.85, 0.6), steer: false, brake: true, k: 420000, c: 55000, collapse: 0.5 },
  ],
  structure: [
    { p: new THREE.Vector3(0, -0.22, -8.37) },                     // pitot
    { p: new THREE.Vector3(0, -0.86, -3.56), belly: true },        // intake lip
    { p: new THREE.Vector3(0, -0.93, -2.4), belly: true },         // nose-gear bay
    { p: new THREE.Vector3(0, -0.93, 0.3), belly: true },          // belly
    { p: new THREE.Vector3(-0.58, -1.05, 3.24), tail: true },      // ventral fins
    { p: new THREE.Vector3(0.58, -1.05, 3.24), tail: true },
    { p: new THREE.Vector3(0, -0.55, 4.66), tail: true },          // nozzle
    { p: new THREE.Vector3(-2.6, -0.27, 5.68), tail: true },       // stabilator tips
    { p: new THREE.Vector3(2.6, -0.27, 5.68), tail: true },
    { p: new THREE.Vector3(-2.8, -0.31, 5.38), tail: true },
    { p: new THREE.Vector3(2.8, -0.31, 5.38), tail: true },
    { p: new THREE.Vector3(0, 3.14, 5.9) },                        // fin tip
    { p: new THREE.Vector3(-4.93, -0.06, 1.2), wingtip: true },    // wingtip missiles
    { p: new THREE.Vector3(4.93, -0.06, 1.2), wingtip: true },
  ],
  steer: { angle: 0.5, fadeSpeed: 45 },
  brakeMu: 0.5,             // wheel brakes
  antiSkid: true,           // braking stops at the tyres' grip limit instead of locking the wheels
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
    ac.stickP = 0; ac.stickR = 0;
    ac.alphaRef = spawn.onGround ? 0 : 0.22;
    ac.rpm = ac.n2 * 100;
    ac.fcsMode = ac.gearHandle ? 'TO/L' : 'CR';
    // Control surface positions (degrees, as in the aerodynamic data).
    ac.el = spawn.onGround ? 0 : -2; ac.ail = 0; ac.rdr = 0;
    ac._coef = {};
  },

  aero(ac, s) {
    const M = s.mach;
    // Body rates in the book's axes: p roll right, q pitch up, r yaw right.
    const w = ac.omega, p = -w.z, q = w.x, r = -w.y;
    const c = f16Coefficients(s.alpha, s.beta, ac.el, ac.ail, ac.rdr, p, q, r, s.V, XCG, ac._coef);
    // Compressibility (the wind-tunnel data are low-speed): the lift slope rises towards Mach 1
    // and falls supersonic, the aerodynamic centre moves aft (much more nose-down trim needed
    // supersonic), and wave drag builds through the transonic region.
    const kM = liftSlope(M) / liftSlope(0.3);
    const czM = c.cz * kM;
    c.cm += czM * 0.07 * smoothstep(0.85, 1.25, M);
    const ca = Math.cos(s.alpha), sa = Math.sin(s.alpha);
    const tef = ac.gearDown; // trailing-edge flaps droop 20° with the gear handle down
    let cl = c.cx * sa - czM * ca + 0.18 * tef * (Math.abs(s.alpha) < 0.5 ? 1 : 0);
    cl *= 1 + 0.1 * (1 - s.ge);
    const cd = -c.cx * ca - czM * sa
      + (parasiteDrag(M) - parasiteDrag(0.3)) + (inducedK(M) - inducedK(0.3)) * cl * cl
      - 0.09 * (1 - s.ge) * cl * cl                          // ground effect
      + 0.0025                                               // wingtip missiles and rails
      + 0.016 * ac.gearDown + 0.012 * tef
      + 0.065 * ac.speedbrake
      + (ac.engineFailed || ac.fuel <= 0 ? 0.004 : 0);
    s.coef = c;
    return { cl, cd, side: c.cy };
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

  // Rigid-body rotation (Euler's equations with the roll/yaw product of inertia and the engine's
  // gyroscopic moment), then the fly-by-wire flight control computer: it works out which
  // stabilator, aileron and rudder positions give the commanded motion (nonlinear dynamic
  // inversion on the same aerodynamic model) and drives the surfaces through rate-limited actuators.
  moments(ac, s, dt, angAcc) {
    const c = ac.controls;
    const w = ac.omega, p = -w.z, q = w.x, r = -w.y;
    const co = s.coef;
    const qS = s.q * AERO_S;
    const heng = HENG * ac.n2;
    // --- Aerodynamic moments and the resulting angular accelerations ---
    const L = qS * AERO_B * co.cl, Mm = qS * AERO_CBAR * co.cm, N = qS * AERO_B * co.cn;
    const pdot = (C1 * r + C2 * p) * q + C3 * L + C4 * (N + q * heng);
    const qdot = C5 * p * r - C6 * (p * p - r * r) + C7 * (Mm - heng * r);
    const rdot = (C8 * p - C2 * r) * q + C4 * L + C9 * (N + q * heng);
    angAcc.x = qdot; angAcc.z = -pdot; angAcc.y = -rdot;

    // --- Flight control computer ---
    const gearMode = ac.gearHandle || ac.gearDown > 0.01;
    ac.fcsMode = gearMode ? 'TO/L' : 'CR';
    // Command prefilters, as in the real flight control system: the commanded G and roll rate
    // follow the stick with a short lag (0.2 s in pitch, 0.15 s in roll), so the aircraft's mass
    // shows in how a manoeuvre builds up and eases off.
    ac.stickP += (clamp(c.elevator, -1, 1) - ac.stickP) * Math.min(1, dt / 0.2);
    ac.stickR += (clamp(c.aileron, -1, 1) - ac.stickR) * Math.min(1, dt / 0.15);
    const stick = ac.stickP;
    let qCmd;
    if (!gearMode) {
      // G command: neutral stick = 1 g; full aft 9 g, full forward -3 g; trim biases it.
      const nz = clamp(1 + (stick >= 0 ? stick * 8 : stick * 4) + ac.trim * 2, -3, 9);
      // Angle of attack needed for that load factor, then the AoA limiter (25° / -5°).
      const clReq = nz * ac.mass * G / Math.max(200, s.q * S_REF);
      const nzErr = nz - s.nz;
      // Only in steady flight: integrating through a transient (G still settling after a pull) would
      // wind up and overshoot the other way.
      const steady = Math.abs(nzErr) < 0.4 && Math.abs(w.x - s.gammaDot) < 0.03;
      if (steady && !ac.onGround) ac.nzInt = clamp(ac.nzInt + nzErr * 0.2 * dt, -0.05, 0.05);
      ac.alphaCmd = clamp(alphaForCL(clReq, s.mach) + ac.nzInt, -0.087, 0.436);
      if (ac.alphaCmd >= 0.436 || ac.alphaCmd <= -0.087) ac.nzInt *= 1 - dt; // no wind-up on the limiter
      const err = clamp(ac.alphaCmd - s.alpha, -0.25, 0.25);
      // AoA change rate: brisk at high dynamic pressure, gentler when the stabilator has less
      // authority to stop the motion again (so there's no overshoot when you let go).
      const aRate = clamp(0.2 + s.q / 1000 * 0.025, 0.25, 0.6);
      qCmd = s.gammaDot + clamp(err * 2.5, -aRate, aRate);
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
        qCmd = s.gammaDot + clamp((ac.alphaRef - s.alpha) * 2.5, -0.25, 0.25);
      }
      if (s.alpha > 0.35 && !ac.onGround) qCmd = Math.min(qCmd, s.gammaDot - (s.alpha - 0.35) * 3);
      ac.alphaCmd = ac.alphaRef;
      ac.nzInt = 0;
    }
    // AoA limiter lead: never command a pitch rate the stabilator couldn't stop before the limit.
    // At low speed there is little nose-down authority, so the jet must approach the limit slowly.
    if (!ac.onGround) {
      const decel = Math.max(0.15, qS * AERO_CBAR * 0.09 / JY);
      const lim = gearMode ? 0.35 : 0.436;
      qCmd = Math.min(qCmd, s.gammaDot + Math.sqrt(2 * decel * Math.max(0, lim - s.alpha)) - Math.max(0, s.alpha - lim) * 3);
    }
    // G limiter: ease off the pitch rate as the load factor nears +9 / -3, so fast pulls don't overshoot.
    if (!gearMode && !ac.onGround) {
      const up = 9 - s.nz, dn = s.nz + 3;
      if (up < 2) qCmd = Math.min(qCmd, s.gammaDot + up * 0.09);
      if (dn < 1.5) qCmd = Math.max(qCmd, s.gammaDot - dn * 0.05);
    }
    // Roll rate about the velocity vector (270°/s clean), with sideslip suppressed.
    const a = ac.stickR;
    const shaped = 0.35 * a + 0.65 * a * Math.abs(a);
    const qk = s.q / 1000;
    let pMax = gearMode ? 2.0 : 4.7;
    pMax *= clamp(qk / 8, 0.2, 1) * (1 - clamp((s.alpha - 0.26) / 0.3, 0, 0.7));
    const ps = shaped * pMax;
    const al = clamp(s.alpha, -0.5, 0.6);
    const pCmd = ps * Math.cos(al);
    // Weight on wheels: no sideslip feedback (a crosswind on the runway mustn't make the system
    // fight the tyres); the pedals work the rudder and nosewheel directly.
    const rCmd = ac.onGround ? c.rudder * 0.35 * clamp(qk / 5, 0, 1)
      : ps * Math.sin(al) + 2.5 * s.beta + c.rudder * 0.35 * clamp(qk / 5, 0, 1);

    let elCmd, ailCmd, rdrCmd;
    if (qS < 300) {
      // Next to no airflow: the surfaces just follow the stick and pedals.
      elCmd = -stick * 25; ailCmd = -a * 21.5; rdrCmd = -c.rudder * 30;
    } else {
      // Desired angular accelerations, then the moments (and coefficients) that produce them
      // (bounded so a large error never asks for more than the surfaces can deliver smoothly).
      // In pitch the angle-of-attack loop (gain 2.5/s) and this pitch-rate loop (8/s) give a
      // short-period response of about 4.5 rad/s with a damping ratio near 0.9: a pull and release
      // settles back to 1 g with almost no overshoot, as on the real jet.
      const qdD = clamp(10 * (qCmd - q), -3, 3), pdD = clamp(5 * (pCmd - p), -7, 7), rdD = clamp(5 * (rCmd - r), -2, 2);
      const mReq = (qdD - C5 * p * r + C6 * (p * p - r * r)) / C7 + heng * r;
      const A = pdD - (C1 * r + C2 * p) * q, B = rdD - (C8 * p - C2 * r) * q;
      const lReq = (C9 * A - C4 * B) / (C3 * C9 - C4 * C4);
      const nReq = (C3 * B - C4 * A) / (C3 * C9 - C4 * C4) - q * heng;
      const dCm = mReq / (qS * AERO_CBAR) - co.cm;
      const dCl = lReq / (qS * AERO_B) - co.cl, dCn = nReq / (qS * AERO_B) - co.cn;
      elCmd = ac.el + dCm / Math.min(co.cmEl, -0.003);
      const det = co.clAil * co.cnRdr - co.clRdr * co.cnAil;
      if (Math.abs(det) > 1e-7) {
        ailCmd = ac.ail + (dCl * co.cnRdr - co.clRdr * dCn) / det;
        rdrCmd = ac.rdr + (co.clAil * dCn - dCl * co.cnAil) / det;
      } else { ailCmd = ac.ail; rdrCmd = ac.rdr; }
    }
    // Weight on wheels: roll and yaw on ground gains. The stick and pedals move the flaperons and
    // rudder directly (a rate loop would only wind the surfaces to the stops against the gear).
    if (ac.onGround) { ailCmd = -a * 21.5 * 0.6; rdrCmd = -c.rudder * 30; }
    // Actuators: first-order lag with rate and travel limits (stabilator 60°/s, ±25°;
    // flaperons 80°/s, ±21.5°; rudder 120°/s, ±30°).
    const act = (pos, cmd, lim, rate) => {
      const v = clamp((clamp(cmd, -lim, lim) - pos) / 0.0495, -rate, rate);
      return pos + v * dt;
    };
    ac.el = act(ac.el, elCmd, 25, 60);
    ac.ail = act(ac.ail, ailCmd, 21.5, 80);
    ac.rdr = act(ac.rdr, rdrCmd, 30, 120);
  },

  stallWarning(ac) {
    // AoA above the limiter, or very slow while airborne.
    return !ac.onGround && ac.tas > 20 && (ac.alpha > 0.45 || (ac.ias < 60 && ac.alpha > 0.2));
  },
};
