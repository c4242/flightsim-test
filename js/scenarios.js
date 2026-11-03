// Starting positions for each scenario.

import { AIRFIELDS, fieldToWorld } from './terrain.js';

const field = (id) => AIRFIELDS.find((f) => f.id === id) ?? AIRFIELDS[0];

// end 0 = take off / land in the runway's heading direction, end 1 = the opposite direction.
export function runwaySpawn(id = 'main', end = 0) {
  const f = field(id);
  const s = end ? -1 : 1;
  const p = fieldToWorld(f, -s * (f.length / 2 - 35), 0, f.elevation + 1.24);
  return { x: p.x, y: p.y, z: p.z, heading: f.heading + (end ? Math.PI : 0), speed: 0, onGround: true, flaps: 0, throttle: 0 };
}

// Trimmed for a 3° glide: 75 kt with 15° flaps, or 65 kt with 30° flaps.
export function approachSpawn(id = 'main', end = 0, dist = 4000, fullFlaps = false) {
  const f = field(id);
  const s = end ? -1 : 1;
  const glide = 3 * Math.PI / 180;
  const aim = -s * (f.length / 2 - f.papiDist);
  const p = fieldToWorld(f, aim - s * dist, 0);
  return {
    x: p.x, y: f.elevation + 1.35 + dist * Math.tan(glide), z: p.z,
    heading: f.heading + (end ? Math.PI : 0), speed: fullFlaps ? 33.5 : 38.5, gamma: -glide, pitch: -0.01,
    flaps: fullFlaps ? 2 : 1, throttle: fullFlaps ? 0.2 : 0.14,
  };
}

export function airSpawn() {
  return { x: -1500, y: 900, z: 6000, heading: 0, speed: 50, pitch: 0.02, flaps: 0, throttle: 0.38 };
}

export const SCENARIOS = {
  runway: { label: 'Take off from Skyhaven (runway 36)', spawn: () => runwaySpawn('main', 0),
    hint: 'Runway 36. Throttle up with R, keep straight with Q/E, ease back on S at about 55 kt.',
    touchHint: 'Runway 36. Slide the throttle up, keep straight with RUD, pull the stick down gently at about 55 kt.' },
  approach: { label: 'Final approach, Skyhaven 36', spawn: () => approachSpawn('main', 0),
    hint: 'On a 4 km final at 75 kt, flaps 15°. Keep the PAPI lights two white, two red; aim for the touchdown markers.' },
  eastfield: { label: 'Final approach, Eastfield 28 (short hilltop strip)', spawn: () => approachSpawn('east', 1, 3500, true),
    hint: 'Eastfield is short and 380 ft up. Full flaps are set; hold about 65 kt and touch down early.' },
  air: { label: 'Start in the air', spawn: airSpawn,
    hint: 'Cruising at 3,000 ft. Press Z for the autopilot, N for the map.',
    touchHint: 'Cruising at 3,000 ft. Tap A/P for the autopilot and MAP for the map.' },
  rings: { label: 'Ring course (timed)', spawn: null,
    hint: 'Fly through every ring in order. The arrow points to the next one.' },
};

