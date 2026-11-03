// Flight-school missions: a start position, optional weather/time overrides, scripted events
// and a list of objectives that must be completed in order.

import * as THREE from 'three';
import { AIRFIELDS, runwayAt, VILLAGES } from './terrain.js';
import { runwaySpawn, approachSpawn } from './scenarios.js';

const field = (id) => AIRFIELDS.find((f) => f.id === id);
const M_TO_FT = 3.28084;
const hdgDiff = (a, bDeg) => Math.abs(((a * 180 / Math.PI - bDeg + 540) % 360) - 180);

const takeOff = { text: 'Take off', done: (ac) => !ac.onGround && ac.agl > 15 };
const gate = (text, x, y, z, radius = 220) => ({ text, target: new THREE.Vector3(x, y, z), radius });
const land = (text, id) => ({ text, land: id });

const eastbrook = VILLAGES.find((v) => v.name === 'Eastbrook');

export const MISSIONS = [
  {
    id: 'first', title: 'First flight',
    brief: 'Take off from Skyhaven, climb to 1,500 ft, turn around to the south, and land back at Skyhaven (either direction).',
    spawn: () => runwaySpawn('main', 0), wind: ['light', 350],
    objectives: [
      takeOff,
      { text: 'Climb through 1,500 ft', done: (ac) => ac.altitude * M_TO_FT >= 1500 },
      { text: 'Turn onto a heading of 180° (south)', done: (ac) => !ac.onGround && hdgDiff(ac.heading, 180) < 15 },
      land('Land at Skyhaven and stop', 'main'),
    ],
  },
  {
    id: 'circuit', title: 'Traffic circuit',
    brief: 'Fly a left-hand circuit at Skyhaven through the four gates (crosswind, downwind, base, final), then land on 36. Watch out for the other aircraft in the circuit.',
    spawn: () => runwaySpawn('main', 0), wind: ['light', 355],
    objectives: [
      takeOff,
      gate('Crosswind gate', -400, 250, -2300),
      gate('Downwind gate (1,000 ft above the field)', -1000, 330, 0),
      gate('Base gate', -900, 260, 2300),
      gate('Final gate: line up with runway 36', 0, 125, 2200, 180),
      land('Land on runway 36 and stop', 'main'),
    ],
  },
  {
    id: 'xc', title: 'Cross-country to Eastfield',
    brief: 'Take off from Skyhaven, fly over the village of Eastbrook in the eastern basin, then land on the short hilltop strip at Eastfield.',
    spawn: () => runwaySpawn('main', 0), wind: ['light', 300],
    objectives: [
      takeOff,
      gate('Fly over Eastbrook', eastbrook.x, 480, eastbrook.z, 350),
      land('Land at Eastfield and stop', 'east'),
    ],
  },
  {
    id: 'engine', title: 'Engine failure',
    brief: 'A routine flight towards Skyhaven at 1,800 ft. Be ready for anything. Glide speed is about 65 kt.',
    spawn: () => ({ x: 500, y: 550, z: 5600, heading: -0.08, speed: 48, pitch: 0.02, flaps: 0, throttle: 0.4 }),
    wind: ['light', 0],
    events: [{ at: 6, run: (ac) => { ac.engineFailed = true; }, msg: 'ENGINE FAILURE! Lower the nose, hold 65 kt and glide to a runway.' }],
    objectives: [land('Glide to a landing on a runway and stop', 'any')],
  },
  {
    id: 'crosswind', title: 'Strong crosswind',
    brief: 'Land on runway 36 with a strong, gusty wind from the west. Bank into the wind and hold the centreline with the rudder.',
    spawn: () => approachSpawn('main', 0), wind: ['strong', 275],
    objectives: [land('Land on runway 36 and stop', 'main')],
  },
  {
    id: 'night', title: 'Night landing',
    brief: 'A moonlit approach to Skyhaven. Follow the approach lights and the PAPI. Your landing light comes on at night.',
    spawn: () => approachSpawn('main', 0), wind: ['calm', 0], time: 'night',
    objectives: [land('Land on runway 36 and stop', 'main')],
  },
];

const STORE = 'skyhaven.missions';
function loadStars() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; }
}

export class MissionRunner {
  constructor() {
    this.mission = null;
    this.stars = loadStars();
  }

  get active() { return !!this.mission && this.state === 'active'; }

  start(m) {
    this.mission = m;
    this.index = 0;
    this.time = 0;
    this.state = 'active';
    this.landing = null;
    this.touchedDown = false;
    this.firedEvents = new Set();
  }

  stop() { this.mission = null; }

  get objective() { return this.mission ? this.mission.objectives[this.index] : null; }

  // Where the HUD should point: the next gate or the destination airfield.
  get target() {
    const o = this.objective;
    if (!this.active || !o) return null;
    if (o.target) return o.target;
    if (o.land && o.land !== 'any') { const f = field(o.land); return new THREE.Vector3(f.x, f.elevation + 5, f.z); }
    return null;
  }

  onTouchdown(e) { this.touchedDown = true; this.landing = e.score !== undefined ? e : null; }

  // Returns { type: 'event' | 'objective' | 'complete' | 'fail', ... } or null.
  update(ac, dt) {
    if (!this.active) return null;
    this.time += dt;
    for (const [i, ev] of (this.mission.events ?? []).entries()) {
      if (!this.firedEvents.has(i) && this.time >= ev.at) {
        this.firedEvents.add(i);
        ev.run(ac);
        return { type: 'event', msg: ev.msg };
      }
    }
    if (ac.crashed) { this.state = 'failed'; return { type: 'fail', reason: ac.crashReason }; }
    const o = this.objective;
    let done = false;
    if (o.done) done = o.done(ac);
    else if (o.target) done = ac.pos.distanceTo(o.target) < o.radius;
    else if (o.land) {
      if (ac.onGround && ac.speed < 2 && this.touchedDown) {
        const f = runwayAt(ac.pos.x, ac.pos.z);
        const ok = o.land === 'any' ? !!f : f && f.id === o.land;
        if (!ok) {
          this.state = 'failed';
          return { type: 'fail', reason: f ? `Landed at ${f.name}, not the destination` : 'Stopped off the runway' };
        }
        done = true;
      }
    }
    if (!done) return null;
    this.index++;
    if (this.index < this.mission.objectives.length) return { type: 'objective', text: o.text, next: this.objective.text };
    // Mission complete: stars from the last landing score.
    this.state = 'complete';
    const score = this.landing?.score ?? 0;
    const stars = score >= 80 ? 3 : score >= 55 ? 2 : 1;
    if ((this.stars[this.mission.id] ?? 0) < stars) {
      this.stars[this.mission.id] = stars;
      try { localStorage.setItem(STORE, JSON.stringify(this.stars)); } catch { /* ignore */ }
    }
    return { type: 'complete', stars, score, time: this.time };
  }
}
