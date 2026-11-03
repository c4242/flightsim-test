// Instrument Landing System for both ends of Skyhaven's runway.
// Localizer: lateral guidance along the runway centreline, full-scale deflection ±2.5°.
// Glideslope: 3° vertical guidance to the touchdown zone, full-scale deflection ±0.7°.
// DME: distance to the threshold in nautical miles.

import { AIRFIELDS, fieldToWorld } from './terrain.js';

const DEG = 180 / Math.PI;
const NM = 1852;
const main = AIRFIELDS.find((f) => f.id === 'main');

const ILS = [0, 1].map((end) => {
  const f = main;
  const s = end ? -1 : 1;           // +1: landing in the runway heading direction
  const heading = f.heading + (end ? Math.PI : 0);
  return {
    name: `ILS ${f.numbers[end]}`,
    heading,
    // Unit vector of the landing direction and of the right-hand side, on the ground plane.
    dx: Math.sin(heading), dz: -Math.cos(heading),
    loc: fieldToWorld(f, s * (f.length / 2 + 300), 0),           // localizer antenna past the far end
    gs: fieldToWorld(f, -s * (f.length / 2 - f.papiDist), 0),     // glideslope antenna at the aim point
    threshold: fieldToWorld(f, -s * (f.length / 2), 0),
    elevation: f.elevation,
  };
});

// Returns the ILS the aircraft is set up for, with deviations, or null when none is received.
export function ilsGuidance(pos, headingRad) {
  let best = null;
  // Service volume: up to about 10,000 ft above the runway.
  if (pos.y - main.elevation > 3000) return null;
  for (const il of ILS) {
    // Position relative to the localizer antenna, in the approach direction (behind the runway).
    const rx = pos.x - il.loc.x, rz = pos.z - il.loc.z;
    const back = -(rx * il.dx + rz * il.dz);          // metres out along the approach course
    if (back <= 0) continue;
    const side = rx * -il.dz + rz * il.dx;             // positive = right of the centreline (facing the runway)
    const locAngle = Math.atan2(side, back) * DEG;
    if (Math.abs(locAngle) > 35 || back > 33000) continue;
    // Only use the ILS we are roughly pointing along.
    const hdgDiff = Math.abs(Math.atan2(Math.sin(headingRad - il.heading), Math.cos(headingRad - il.heading))) * DEG;
    if (hdgDiff > 100) continue;
    const gx = pos.x - il.gs.x, gz = pos.z - il.gs.z;
    const gsDist = Math.hypot(gx, gz);
    const gsAngle = Math.atan2(pos.y - (il.elevation + 2), gsDist) * DEG;
    const tx = pos.x - il.threshold.x, tz = pos.z - il.threshold.z;
    const r = {
      name: il.name,
      course: il.heading,
      locDev: locAngle,                                   // degrees, + = right of course
      loc: Math.max(-1, Math.min(1, -locAngle / 2.5)),    // needle: + = steer right
      gsValid: Math.abs(locAngle) < 10 && gsDist < 18500,
      gsDev: gsAngle - 3,                                 // degrees, + = above the glide path
      gs: Math.max(-1, Math.min(1, -(gsAngle - 3) / 0.7)),// needle: + = fly up
      dme: Math.hypot(tx, tz) / NM,
    };
    if (!best || Math.abs(r.locDev) < Math.abs(best.locDev)) best = r;
  }
  return best;
}
