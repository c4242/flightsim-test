// Wind field: a prevailing wind that strengthens with height, slow gusts, and turbulence
// that is stronger near the ground, around mountains and on hot afternoons.

import * as THREE from 'three';
import { createNoise, clamp } from './noise.js';

export const WIND_LEVELS = {
  calm: { speed: 0, gust: 0, turb: 0.15 },
  light: { speed: 4, gust: 1.5, turb: 0.5 },
  moderate: { speed: 8, gust: 3, turb: 1.0 },
  strong: { speed: 13, gust: 5, turb: 1.7 },
};

const n = createNoise(31);

export class Weather {
  constructor() {
    this.level = 'light';
    this.fromDeg = 340;               // direction the wind blows FROM (compass degrees)
    this.surfaceWind = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this.time = 0;
  }

  set(level, fromDeg) {
    this.level = WIND_LEVELS[level] ? level : 'light';
    if (fromDeg !== undefined) this.fromDeg = fromDeg;
  }

  randomise() {
    // Mostly from the north-west quadrant, so runway 36 is usually into wind.
    this.fromDeg = (300 + Math.random() * 100) % 360;
  }

  get spec() { return WIND_LEVELS[this.level]; }

  update(dt) {
    this.time += dt;
    const s = this.spec;
    const gust = s.gust * (0.5 + 0.5 * n.fbm(this.time * 0.08, 3.7, 3) * 1.6);
    const veer = n.fbm(this.time * 0.02, 9.1, 2) * 0.35;
    const from = this.fromDeg * Math.PI / 180 + veer;
    const spd = Math.max(0, s.speed + gust);
    // Air moves towards the opposite of where it comes from.
    this.surfaceWind.set(-Math.sin(from) * spd, 0, Math.cos(from) * spd);
  }

  // Wind velocity (m/s) at a world position. `agl` is height above ground.
  windAt(pos, agl, out = this._w) {
    const s = this.spec;
    // Boundary layer: wind builds up over the first few hundred metres.
    const profile = clamp(Math.log(Math.max(agl, 0.5) / 0.05) / Math.log(400 / 0.05), 0.35, 1) * (1 + Math.min(agl, 2000) / 4000);
    out.copy(this.surfaceWind).multiplyScalar(profile);
    // Turbulence: band-limited noise in space and time, strongest low down and over rough terrain.
    const rough = 1 + clamp((pos.y - agl) / 600, 0, 1.5);
    const low = 1.2 - clamp(agl / 1500, 0, 0.8);
    // Convective bumps inside cumulus (cloud = density at the aircraft, set by the sim).
    const cloud = this.cloud ?? 0;
    const amp = s.turb * rough * low + 2.2 * cloud + 0.8 * (this.shower ?? 0); // gusty in showers
    if (amp > 0) {
      const t = this.time;
      out.x += amp * n.fbm(pos.x * 0.01 + t * 0.7, pos.z * 0.01, 3);
      out.y += amp * 0.8 * n.fbm(pos.x * 0.012 - 50, pos.z * 0.012 + t * 0.9, 3);
      out.z += amp * n.fbm(pos.z * 0.01 + 31, pos.x * 0.01 - t * 0.6, 3);
    }
    out.y += 1.5 * cloud; // the rising air that builds the cloud
    return out;
  }
}
