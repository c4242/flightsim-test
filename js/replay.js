// Records the last minute of flight and plays it back.

import * as THREE from 'three';

const HZ = 30;
const MAX_FRAMES = HZ * 60;

export class Recorder {
  constructor() {
    this.frames = [];
    this.acc = 0;
    this.playing = false;
    this.t = 0;
    // Display state with the fields the aircraft model and cameras read.
    this.state = {
      pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3(),
      controls: { elevator: 0, aileron: 0, rudder: 0, throttle: 0, brake: 0 },
      flaps: 0, trim: 0, rpm: 0, onGround: false, speed: 0, crashed: false, stalling: false, gLoad: 1,
    };
    this._q = new THREE.Quaternion();
  }

  clear() { this.frames.length = 0; this.acc = 0; this.playing = false; }

  record(ac, dt) {
    if (this.playing) return;
    this.acc += dt;
    if (this.acc < 1 / HZ) return;
    this.acc -= 1 / HZ;
    const c = ac.controls;
    this.frames.push({
      p: ac.pos.toArray(), q: ac.quat.toArray(), v: ac.vel.toArray(),
      c: [c.elevator, c.aileron, c.rudder, c.throttle], flaps: ac.flaps, trim: ac.trim, rpm: ac.rpm,
      g: ac.onGround, gl: ac.gLoad,
    });
    if (this.frames.length > MAX_FRAMES) this.frames.shift();
  }

  get duration() { return Math.max(0, (this.frames.length - 1) / HZ); }

  start() {
    if (this.frames.length < HZ * 2) return false;
    this.playing = true;
    this.t = 0;
    return true;
  }

  stop() { this.playing = false; }

  // Advances playback and returns the interpolated display state (loops at the end).
  sample(dt) {
    this.t += dt;
    if (this.t > this.duration + 1.5) this.t = 0; // hold the last frame briefly, then loop
    const f = Math.min(this.t * HZ, this.frames.length - 1);
    const i = Math.floor(f), k = f - i;
    const a = this.frames[i], b = this.frames[Math.min(i + 1, this.frames.length - 1)];
    const s = this.state;
    s.pos.set(a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k);
    s.quat.fromArray(a.q).slerp(this._q.fromArray(b.q), k);
    s.vel.fromArray(a.v);
    [s.controls.elevator, s.controls.aileron, s.controls.rudder, s.controls.throttle] = a.c;
    s.flaps = a.flaps; s.trim = a.trim; s.rpm = a.rpm; s.onGround = a.g; s.gLoad = a.gl;
    s.speed = s.vel.length();
    return s;
  }
}
