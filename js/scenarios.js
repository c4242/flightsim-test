// Starting positions for each scenario, for the light prop and for the F-16.

import { AIRFIELDS, fieldToWorld } from './terrain.js';

const field = (id) => AIRFIELDS.find((f) => f.id === id) ?? AIRFIELDS[0];

// end 0 = take off / land in the runway's heading direction, end 1 = the opposite direction.
export function runwaySpawn(id = 'main', end = 0, kind = 'prop') {
  const f = field(id);
  const s = end ? -1 : 1;
  // The jet is 15 m long, so start a little further from the threshold.
  const p = fieldToWorld(f, -s * (f.length / 2 - (kind === 'jet' ? 45 : 35)), 0, f.elevation + 2);
  return { x: p.x, y: p.y, z: p.z, heading: f.heading + (end ? Math.PI : 0), speed: 0, onGround: true, flaps: 0, throttle: 0 };
}

// Trimmed for a 3° glide. Prop: 75 kt with 15° flaps, or 65 kt with 30°.
// F-16: gear down, on-speed AoA (13°) at about 150 KCAS with roughly half fuel.
export function approachSpawn(id = 'main', end = 0, dist = 4000, opts = {}) {
  const f = field(id);
  const s = end ? -1 : 1;
  const glide = 3 * Math.PI / 180;
  const aim = -s * (f.length / 2 - f.papiDist);
  const jet = opts.kind === 'jet';
  if (jet) dist = Math.max(dist, 6000);
  const p = fieldToWorld(f, aim - s * dist, 0);
  const base = {
    x: p.x, y: f.elevation + 1.5 + dist * Math.tan(glide), z: p.z, heading: f.heading + (end ? Math.PI : 0), gamma: -glide,
  };
  if (jet) return { ...base, speed: 78, pitch: 0.17, throttle: 0.22, fuel: 1600 };
  return { ...base, speed: opts.fullFlaps ? 33.5 : 38.5, pitch: -0.01, flaps: opts.fullFlaps ? 2 : 1, throttle: opts.fullFlaps ? 0.2 : 0.14 };
}

export function airSpawn(kind = 'prop') {
  if (kind === 'jet') return { x: -1500, y: 4600, z: 7000, heading: 0, speed: 210, pitch: 0.03, throttle: 0.72, gearUp: true };
  return { x: -1500, y: 900, z: 6000, heading: 0, speed: 50, pitch: 0.02, flaps: 0, throttle: 0.38 };
}

export const SCENARIOS = {
  runway: {
    label: 'Take off from Skyhaven (runway 36)', spawn: (k) => runwaySpawn('main', 0, k),
    hint: 'Runway 36. Throttle up with R, keep straight with Q/E, ease back on S at about 55 kt.',
    touchHint: 'Runway 36. Slide the throttle up, keep straight with RUD, pull the stick down gently at about 55 kt.',
    jetHint: 'Runway 36. Full afterburner (0 or hold R), rotate at 150 kt to about 10°, gear up (G) before 300 kt.',
  },
  approach: {
    label: 'Final approach, Skyhaven 36', spawn: (k) => approachSpawn('main', 0, 4000, { kind: k }),
    hint: 'On a 4 km final at 75 kt, flaps 15°. Keep the PAPI lights two white, two red; aim for the touchdown markers.',
    jetHint: 'Gear down, 6 km final. Fly the glide path with the stick, keep 13° AoA (FPM inside the bracket) with the throttle.',
  },
  eastfield: {
    label: 'Final approach, Eastfield 28 (short hilltop strip)', aircraft: ['prop'],
    spawn: () => approachSpawn('east', 1, 3500, { fullFlaps: true }),
    hint: 'Eastfield is short and 380 ft up. Full flaps are set; hold about 65 kt and touch down early.',
  },
  air: {
    label: 'Start in the air', spawn: (k) => airSpawn(k),
    hint: 'Cruising at 3,000 ft. Press Z for the autopilot, N for the map.',
    touchHint: 'Cruising at 3,000 ft. Tap A/P for the autopilot and MAP for the map.',
    jetHint: 'At 15,000 ft and 400 kt. The stick commands G (up to 9). Try the afterburner and go supersonic.',
  },
  rings: {
    label: 'Ring course (timed)', spawn: null,
    hint: 'Fly through every ring in order. The arrow points to the next one.',
  },
};
