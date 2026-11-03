// Generic rigid-body aircraft. The aircraft type (js/planes/*.js) supplies the mass properties,
// aerodynamic coefficients, engine model and control laws; this class handles everything they
// share: the standard atmosphere, wind, forces, landing gear, collisions, limits and scoring.
//
// Body frame: +X right wing, +Y up, -Z forward (nose). The origin is the centre of gravity.
// Angular velocity `omega` is in the body frame: x = pitch up, y = yaw left, z = roll left.

import * as THREE from 'three';
import { surfaceInfo, runwayAt, fieldLocal, obstacleAt } from './terrain.js';
import { atmosphere, calibratedAirspeed } from './atmosphere.js';
import { clamp } from './noise.js';
import { SKYLARK } from './planes/skylark.js';

const G = 9.81;
export const MS_TO_KT = 1.94384;

// Scratch objects reused every step.
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3();
const _force = new THREE.Vector3(), _torque = new THREE.Vector3(), _invQ = new THREE.Quaternion();
const _dq = new THREE.Quaternion(), _omegaW = new THREE.Vector3(), _r = new THREE.Vector3();
const _air = new THREE.Vector3(), _angAcc = new THREE.Vector3(), _liftDir = new THREE.Vector3();
const _atm = {};
const S = {}; // per-step aerodynamic state passed to the type

export class Aircraft {
  constructor(type = SKYLARK) {
    this.type = type;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.omega = new THREE.Vector3();
    this.wind = new THREE.Vector3();
    this.airVel = new THREE.Vector3();
    this.controls = { elevator: 0, aileron: 0, rudder: 0, throttle: 0, brake: 0 };
    this.flaps = 0;
    this.trim = 0;
    this.reset({ x: 0, y: 30, z: 0, heading: 0, speed: 0, onGround: true });
  }

  setType(type) { this.type = type; }

  // spawn: { x, y, z, heading (rad), speed (m/s), pitch (rad), gamma (rad), flaps, throttle, trim, onGround, gearUp }
  reset(spawn) {
    this.omega.set(0, 0, 0);
    this.crashed = false;
    this.crashReason = '';
    this.trim = spawn.trim ?? 0;
    this.time = 0;
    this.events = [];
    this.wasOnGround = !!spawn.onGround;
    this.onGround = !!spawn.onGround;
    this.airborneTime = 0;
    this.overG = 0;
    this.engineFailed = false;
    this.overspeed = false;
    this.gLoad = 1;
    this.power = 0;
    this.gearDown = spawn.gearUp ? 0 : 1;   // 0 = retracted, 1 = down and locked
    this.gearHandle = !spawn.gearUp;
    this.speedbrake = 0;
    this.speedbrakeCmd = false;
    // Parking brake on ground starts; it releases when power is added.
    this.parkBrake = !!spawn.onGround;
    const thr = spawn.throttle ?? 0;
    Object.assign(this.controls, { elevator: 0, aileron: 0, rudder: 0, throttle: thr, brake: 0 });
    this.pos.set(spawn.x, spawn.y, spawn.z);
    // On the ground: sit on the wheels with the oleos slightly compressed.
    if (spawn.onGround) this.pos.y = surfaceInfo(spawn.x, spawn.z).height - this.type.contactY - 0.08;
    // Heading h, then pitch about the right wing.
    this.quat.setFromAxisAngle(_v.set(0, 1, 0), -spawn.heading);
    this.quat.multiply(_dq.setFromAxisAngle(_v.set(1, 0, 0), spawn.pitch ?? 0));
    const s = spawn.speed ?? 0;
    const gamma = spawn.gamma ?? 0; // flight-path angle
    this.vel.set(Math.sin(spawn.heading) * Math.cos(gamma) * s, Math.sin(gamma) * s, -Math.cos(spawn.heading) * Math.cos(gamma) * s);
    this.type.reset(this, spawn);
    this.updateDerived();
  }

  // Quantities the HUD, audio and control laws need.
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
    this.groundSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.altitude = this.pos.y;
    const surf = surfaceInfo(this.pos.x, this.pos.z);
    this.agl = this.pos.y + this.type.contactY - surf.height;

    this.airVel.copy(this.vel).sub(this.wind);
    const tas = this.airVel.length();
    this.tas = tas;
    const atm = atmosphere(this.pos.y, _atm);
    this.mach = tas / atm.a;
    this.ias = calibratedAirspeed(tas, atm);
    _invQ.copy(this.quat).invert();
    const vb = _v.copy(this.airVel).applyQuaternion(_invQ);
    this.alpha = tas > 1 ? Math.atan2(-vb.y, -vb.z) : 0;
    this.beta = tas > 1 ? Math.asin(clamp(vb.x / tas, -1, 1)) : 0;
    this.stalling = this.type.stallWarning(this);
    const L = this.type.limits;
    this.overspeed = this.ias > L.vne || (L.mmo && this.mach > L.mmo);
    this.limitWarning = this.overspeed || this.gLoad > L.gWarn[1] || this.gLoad < L.gWarn[0];
  }

  step(dt, weather) {
    if (this.crashed) return;
    const T = this.type;
    this.time += dt;
    const c = this.controls;
    if (this.parkBrake && c.throttle > 0.25) this.parkBrake = false;

    const fwd = _fwd.set(0, 0, -1).applyQuaternion(this.quat);
    const up = _up.set(0, 1, 0).applyQuaternion(this.quat);
    const right = _right.set(1, 0, 0).applyQuaternion(this.quat);
    _invQ.copy(this.quat).invert();

    const surf = surfaceInfo(this.pos.x, this.pos.z);
    const agl = Math.max(0, this.pos.y + T.contactY - surf.height);
    if (weather) weather.windAt(this.pos, agl, this.wind); else this.wind.set(0, 0, 0);
    if (this.onGround) this.wind.y = 0;
    const air = _air.copy(this.vel).sub(this.wind);

    const atm = atmosphere(this.pos.y, _atm);
    const V = air.length();
    const q = 0.5 * atm.rho * V * V;
    const vb = _v.copy(air).applyQuaternion(_invQ);
    S.V = V;
    S.q = q;
    S.u = -vb.z;
    S.alpha = V > 0.5 ? Math.atan2(-vb.y, -vb.z) : 0;
    S.beta = V > 0.5 ? Math.asin(clamp(vb.x / V, -1, 1)) : 0;
    S.mach = V / atm.a;
    S.atm = atm;
    S.agl = agl;
    // Ground effect: within about a wingspan of the surface, induced drag drops and lift rises.
    const hb = (agl - T.contactY - 0.4) / T.span;
    S.ge = (16 * hb * hb) / (1 + 16 * hb * hb);

    // Retractable gear moves over a few seconds (and only extends at sensible speeds in real life).
    if (T.retractableGear) {
      const target = this.gearHandle ? 1 : 0;
      if (this.onGround) this.gearDown = 1; // the weight-on-wheels switch blocks retraction
      else this.gearDown = clamp(this.gearDown + Math.sign(target - this.gearDown) * dt / T.gearTime, 0, 1);
      this.speedbrake = clamp(this.speedbrake + (this.speedbrakeCmd ? 1 : -1) * dt / 1.5, 0, 1);
    }

    const mass = this.mass;
    _force.set(0, -mass * G, 0);
    _torque.set(0, 0, 0); // body-frame angular acceleration from gear, rad/s²

    // --- Aerodynamic forces ---
    const aero = T.aero(this, S);
    S.cl = aero.cl;
    if (V > 0.5) {
      const vhat = _v2.copy(air).divideScalar(V);
      // Lift is perpendicular to the airflow, in the aircraft's plane of symmetry.
      const liftDir = _liftDir.crossVectors(right, vhat);
      if (liftDir.lengthSq() > 1e-6) {
        liftDir.normalize();
        _force.addScaledVector(liftDir, q * T.wingArea * aero.cl);
      } else liftDir.copy(up);
      _force.addScaledVector(vhat, -q * T.wingArea * aero.cd);
      _force.addScaledVector(right, q * T.wingArea * aero.side);
    } else _liftDir.copy(up);

    // --- Engine ---
    const thrust = T.engine(this, S, dt);
    _force.addScaledVector(fwd, thrust);

    // Rate at which the flight path is turning in the aircraft's pitch plane (used by
    // fly-by-wire control laws to hold angle of attack).
    S.gammaDot = V > 5 ? _force.dot(_liftDir) / mass / V : 0;
    // Load factor along the body up axis from aerodynamic and engine forces.
    S.nz = (_force.dot(up) / (mass * G)) + up.y;
    S.up = up;

    // --- Moments / control laws (body frame angular acceleration) ---
    const angAcc = _angAcc.set(0, 0, 0);
    T.moments(this, S, dt, angAcc);

    // --- Landing gear ---
    const onRunway = runwayAt(this.pos.x, this.pos.z);
    const rollMu = onRunway ? 0.02 : 0.06; // grass is draggier than asphalt
    let onGround = false;
    let impact = 0;
    _omegaW.copy(this.omega).applyQuaternion(this.quat);
    const groundSpeed = this.vel.length();
    const gearOut = this.gearDown >= 0.999;
    for (const gear of gearOut ? T.gear : []) {
      _r.copy(gear.p).applyQuaternion(this.quat);
      const wy = this.pos.y + _r.y;
      let depth = surf.height - wy;
      if (depth <= 0) continue;
      if (surf.water) { this.crash('Ditched in the sea'); return; }
      // Grass is bumpy.
      if (!onRunway && groundSpeed > 2) depth += Math.sin(this.pos.x * 1.7 + this.pos.z * 2.3) * 0.012;
      onGround = true;
      // Velocity of the contact point.
      const pv = _v3.crossVectors(_omegaW, _r).add(this.vel);
      impact = Math.min(impact, pv.y);
      const normal = Math.max(0, gear.k * depth - gear.c * pv.y);
      // Wheel rolling direction on the ground plane.
      const steer = gear.steer ? -c.rudder * T.steer.angle * clamp(1 - groundSpeed / T.steer.fadeSpeed, 0.1, 1) : 0;
      const wf = _v.set(Math.sin(-steer), 0, -Math.cos(steer)).applyQuaternion(this.quat);
      wf.y = 0;
      if (wf.lengthSq() < 1e-6) continue;
      wf.normalize();
      const sx = -wf.z, sz = wf.x;               // sideways direction
      const vl = pv.x * wf.x + pv.z * wf.z;      // rolling speed
      const vs = pv.x * sx + pv.z * sz;          // skid speed
      const mu = rollMu + (gear.brake ? Math.max(c.brake, this.parkBrake ? 1 : 0) * T.brakeMu : 0);
      const roll = -clamp(vl / 0.3, -1, 1) * mu * normal;
      const side = -clamp(vs / 0.2, -1, 1) * 0.9 * normal;
      const f = _v.set(wf.x * roll + sx * side, normal, wf.z * roll + sz * side);
      _force.add(f);
      // Torque = r × F, converted to the body frame and divided by inertia.
      const t = _v3.crossVectors(_r, f).applyQuaternion(_invQ);
      _torque.x += t.x / T.inertia.x;
      _torque.y += t.y / T.inertia.y;
      _torque.z += t.z / T.inertia.z;
      if (depth > (gear.collapse ?? 0.6)) { this.crash('Landing gear collapsed'); return; }
    }

    if (onGround && !this.wasOnGround && this.airborneTime > 2) {
      const fpm = -impact * 196.85;
      if (impact < -T.maxSink) { this.crash(`Hard landing (${Math.round(fpm)} ft/min)`); return; }
      this.events.push(this.scoreTouchdown(fpm, onRunway));
    }
    if (!onGround && this.wasOnGround && groundSpeed > 15) this.events.push({ type: 'liftoff' });
    if (!onGround) this.airborneTime += dt; else if (groundSpeed < 1) this.airborneTime = 0;
    this.wasOnGround = onGround;
    this.onGround = onGround;

    // The airframe itself must not touch the ground, trees or buildings.
    const lowLevel = agl < 40;
    for (const sp of T.structure) {
      _r.copy(sp.p).applyQuaternion(this.quat).add(this.pos);
      const s = surfaceInfo(_r.x, _r.z);
      if (_r.y < s.height) {
        if (sp.wingtip && groundSpeed < 25 && !s.water) { this.crash('Wingtip strike'); return; }
        if (sp.tail && groundSpeed > 20 && !s.water) { this.crash('Tail strike'); return; }
        this.crash(s.water ? 'Crashed into the sea' : sp.belly ? (gearOut ? 'Belly landing' : 'Gear-up landing') : 'Crashed into terrain');
        return;
      }
      if (lowLevel) {
        const hit = obstacleAt(_r);
        if (hit) { this.crash(hit); return; }
      }
    }

    // --- Integrate ---
    this.vel.addScaledVector(_force, dt / mass);
    this.pos.addScaledVector(this.vel, dt);
    this.omega.addScaledVector(angAcc, dt).addScaledVector(_torque, dt);
    const w = this.omega.length();
    if (w > 1e-9) {
      _dq.setFromAxisAngle(_v.copy(this.omega).divideScalar(w), w * dt);
      this.quat.multiply(_dq).normalize();
    }

    // Load factor felt by the pilot (aerodynamic + thrust + gear forces along the up axis).
    const g = _force.dot(up) / (mass * G) + up.y;
    this.gLoad += (g - this.gLoad) * Math.min(1, dt * 20);
    this.thrust = thrust;
    this.updateDerived();

    // --- Structural limits ---
    const L = T.limits;
    if (this.ias > L.vBreak) { this.crash('Structural failure: overspeed'); return; }
    if (L.mBreak && this.mach > L.mBreak) { this.crash(`Structural failure: Mach ${this.mach.toFixed(2)}`); return; }
    if (this.gLoad > L.gLimit[1] || this.gLoad < L.gLimit[0]) {
      this.overG += dt;
      if (this.overG > 0.3) { this.crash(`Structural failure: ${this.gLoad.toFixed(1)} G`); return; }
    } else this.overG = 0;
    // Gear overspeed: extended gear is ripped off well above its limit speed.
    if (T.retractableGear && this.gearDown > 0 && L.vGearBreak && this.ias > L.vGearBreak) {
      this.crash('Landing gear torn off (overspeed)');
    }
  }

  scoreTouchdown(fpm, field) {
    const ev = { type: 'touchdown', fpm, onRunway: !!field };
    if (!field) return ev;
    const { along, across } = fieldLocal(field, this.pos.x, this.pos.z);
    const dirSign = Math.sign(this.vel.x * field.dir.x + this.vel.z * field.dir.z) || 1;
    const fromThreshold = dirSign * along + field.length / 2;
    // Crab: angle between the nose and the direction of travel over the ground.
    const track = Math.atan2(this.vel.x, -this.vel.z);
    let crab = (this.heading - track) * 180 / Math.PI;
    crab = ((crab + 540) % 360) - 180;
    let score = 100;
    score -= Math.max(0, fpm - this.type.goodSink) / 6;
    score -= Math.abs(across) * 3;
    score -= Math.max(0, Math.abs(fromThreshold - field.papiDist) - 150) / 8;
    score -= Math.abs(crab) * 2;
    ev.score = Math.round(clamp(score, 0, 100));
    ev.field = field.name;
    ev.centreline = across;
    ev.fromThreshold = fromThreshold;
    ev.crab = crab;
    return ev;
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
    this.events.push({ type: 'crash', reason });
  }
}
