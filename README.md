# Skyhaven Flight

A light-aircraft flight simulator that runs in the browser. You fly a small single-engine
low-wing plane over a procedurally generated island with a valley airfield, mountains, forests and sea.

There is no build step and nothing to install: it's plain HTML and JavaScript ES modules, with
[three.js](https://threejs.org/) loaded from a CDN.

## Running it

Browsers won't load ES modules from `file://`, so serve the folder over HTTP:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

To publish it, enable GitHub Pages for the repository (Settings → Pages → deploy from the `main` branch, root folder).

## Scenarios

- **Take off from the runway:** start at the south end of runway 36, engine idling.
- **Final approach:** 4 km out on a 3° glide path with 15° flaps. Good for landing practice.
- **Start in the air:** cruising at about 3,000 ft over the island.

## Controls

| Key | Action |
| --- | --- |
| W / S or ↑ / ↓ | Pitch: nose down / nose up (stick forward / back) |
| A / D or ← / → | Roll left / right |
| Q / E | Rudder; also steers the nose wheel on the ground |
| R / F | Throttle up / down |
| G / T | Flaps down / up (0°, 15°, 30°) |
| B | Wheel brakes (hold) |
| [ / ] | Elevator trim nose down / up |
| C | Camera: chase, cockpit (with HUD), tower |
| Mouse drag | Look around (double-click to recentre) |
| H | Show or hide the instrument panel |
| M | Mute |
| P / Esc | Pause menu |
| Enter | Restart after a crash |

A standard gamepad also works: the left stick flies, right stick X is rudder, right stick Y is throttle,
LT is brakes, and A / Y move the flaps.

### Flying tips

- **Takeoff:** hold R to full throttle and keep straight with Q/E. At about 55–60 kt, ease back on S.
  One notch of flaps (G) shortens the run.
- **Cruise:** hands-off trim speed is about 100 kt. Use `[` and `]` to trim for other speeds.
- **Turns:** bank with A/D and add a little back pressure to hold altitude. The plane yaws into the turn on its own.
- **Stalls:** the wing stalls at about 15° angle of attack (about 50 kt clean, about 45 kt with full flaps).
  The STALL light flashes, the horn sounds and the aircraft buffets. Lower the nose to recover.
- **Landing:** fly the approach at 65–75 kt with flaps, reduce power over the threshold, and flare gently.
  The touchdown rate is rated: under 150 ft/min is a "butter" landing. Anything over about 900 ft/min breaks the gear.

## Instruments

The panel has six round gauges: airspeed (with white flap, green normal, yellow caution arcs and a red
line), attitude indicator, altimeter, tachometer, heading indicator and vertical speed. To the right are
throttle, flap and trim indicators and STALL / BRAKE / GROUND / LOW ALT lamps. A readout in the top-left
shows the exact numbers, including angle of attack and G-load. The cockpit view adds a green HUD with a pitch
ladder, a flight-path marker and a heading tape.

## How it works

| File | What it does |
| --- | --- |
| `js/aircraft.js` | Flight model: a rigid body with lift (with stall), drag (parasitic + induced), side force, propeller thrust, air density falling with altitude, control-surface moments, static stability, damping, and spring-damper landing gear with brakes and nose-wheel steering. Runs at 240 Hz in fixed steps. |
| `js/terrain.js` | The island heightfield (value-noise fBm plus ridged mountains, with the airfield flattened and a clear valley along the runway axis), terrain colours, sea, the runway (markings drawn on a canvas), hangars, tower, windsock and instanced trees. Collision uses the same triangles as the rendered mesh. |
| `js/sky.js` | Sky gradient dome with the sun, fog, lighting, a shadow that follows the aircraft, and sprite clouds. |
| `js/model.js` | The aircraft mesh, with moving ailerons, flaps, elevator and rudder, a spinning propeller and wheels. |
| `js/hud.js` | The instrument panel, readouts, cockpit HUD and on-screen messages, drawn on a 2D canvas. |
| `js/input.js` | Keyboard, gamepad and mouse look. |
| `js/audio.js` | Engine, wind, tyre rumble, stall horn and crash sounds generated with the Web Audio API (no audio files). |
| `js/main.js` | Scene setup, cameras, menus, crash effects and the main loop. |
