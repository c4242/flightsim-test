// Simple two-axis autopilot: holds a heading (bank to turn) and an altitude.
// While engaged, roll inputs move the heading bug and pitch inputs move the altitude target.

import { clamp } from './noise.js';

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Autopilot {
  constructor() {
    this.on = false;
    this.heading = 0;
    this.altitude = 0;
    this.integ = 0;
  }

  engage(ac) {
    this.on = true;
    this.heading = ac.heading;
    this.altitude = Math.round(ac.altitude / 30.48) * 30.48; // nearest 100 ft
    this.integ = 0;
  }

  disengage() { this.on = false; }

  update(ac, dt, intent) {
    if (!this.on) return;
    if (ac.crashed || ac.onGround) { this.on = false; return; }
    if (intent) {
      this.heading = (this.heading + intent.roll * 0.35 * dt + Math.PI * 2) % (Math.PI * 2);
      this.altitude = Math.max(60, this.altitude - intent.pitch * 6 * dt);
    }
    const c = ac.controls;
    // Lateral: bank towards the heading bug, coordinate with rudder.
    const hdgErr = wrapPi(this.heading - ac.heading);
    const bankTarget = clamp(hdgErr * 1.3, -0.44, 0.44);
    c.aileron = clamp(2.2 * (bankTarget - ac.roll) + 0.5 * ac.omega.z, -1, 1);
    c.rudder = clamp(ac.beta * 3, -0.5, 0.5);
    // Vertical: climb or descend towards the target at a gentle rate, PI on vertical speed.
    const vsTarget = clamp((this.altitude - ac.altitude) * 0.12, -4, 4);
    const vsErr = vsTarget - ac.vel.y;
    // Don't let it pull into a stall: limit the climb when slow.
    const slow = clamp((ac.ias - 30) / 8, 0, 1);
    this.integ = clamp(this.integ + vsErr * 0.03 * dt, -0.4, 0.4);
    c.elevator = clamp((0.09 * vsErr + this.integ) * (vsErr > 0 ? slow : 1)
      - 0.35 * ac.omega.x + 0.25 * (1 / Math.max(0.7, Math.cos(ac.roll)) - 1) - ac.trim, -0.7, 0.7);
  }
}
