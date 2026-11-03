# Skyhaven Flight

A light-aircraft flight simulator that runs in the browser. You fly a small single-engine low-wing
plane over a procedurally generated island with two airfields, a mountain canyon, forests, farmland and sea.
It works with a keyboard and mouse, a gamepad, or touch on phones and tablets.

There is no build step and nothing to install: it's plain HTML and JavaScript ES modules, with
[three.js](https://threejs.org/) loaded from a CDN.

## Running it

Browsers won't load ES modules from `file://`, so serve the folder over HTTP:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. To publish it, enable GitHub Pages for the repository (Settings → Pages →
deploy from the `main` branch, root folder).

## Scenarios

- **Take off from Skyhaven:** start at the south end of runway 36, engine idling.
- **Final approach, Skyhaven 36:** 4 km out on a 3° glide path, trimmed at 75 kt with 15° flaps.
- **Final approach, Eastfield 28:** a short strip on a hilltop plateau (380 ft), approached over the sea with full flaps.
- **Start in the air:** cruising at about 3,000 ft.
- **Ring course:** a timed low-level course through 12 rings. It crosses the western lowlands, makes a low pass over
  Skyhaven, runs up the canyon, turns out over the northern sea and comes back. Your best time is saved.

Every landing is scored out of 100 for sink rate, touchdown point, centreline and crab angle.

## Settings

The pause menu has settings for time of day (morning, noon, evening), wind (calm, light, moderate, strong),
graphics quality (high or low; low turns off shadows and thins the forests, and is the default on touch devices),
volume and inverted pitch. They are saved in your browser. Add `?quality=low` to the URL to force low quality.

## Controls

| Key | Action |
| --- | --- |
| W / S or ↑ / ↓ | Pitch: nose down / nose up (stick forward / back) |
| A / D or ← / → | Roll left / right |
| Q / E | Rudder; also steers the nose wheel on the ground |
| R / F | Throttle up / down (hold) |
| 1 … 9, 0 | Set throttle to 10 … 90 %, or 100 % |
| G / T | Flaps down / up (0°, 15°, 30°) |
| B | Wheel brakes (hold) |
| [ / ] | Elevator trim nose down / up |
| Z | Autopilot on / off. While it's on, the pitch and roll keys move its altitude and heading targets |
| C | Camera: chase, cockpit (3D panel + HUD), tower, flyby |
| Mouse drag | Look around (double-click to recentre) |
| N | Map |
| H | Hide / show the instruments and HUD |
| M | Mute |
| P / Esc | Pause menu |
| Enter | Restart after a crash |

**Gamepad (standard layout):** the left stick flies, right stick X is rudder, right stick Y is throttle,
LT is brakes, A / Y move the flaps, X toggles the autopilot and B changes the camera.

**Touch:** the left pad is the control stick (pull down to climb), with rudder buttons beside it. The slider on the
right is the throttle, and the buttons give flaps, brakes, autopilot, camera, map and pause.

### Flying tips

- **Takeoff:** go to full throttle and keep straight with the rudder; the propeller pulls slightly left at full power.
  At about 55–60 kt, ease back. One notch of flaps shortens the run.
- **Crosswind:** the readout shows the wind and an arrow relative to your nose, and the windsocks show it too.
  Turbulence is stronger low down and over the mountains.
- **Turns:** bank and add a little back pressure. Aileron causes some adverse yaw, so a touch of rudder keeps you coordinated.
- **Stalls:** the wing stalls at about 15° angle of attack (about 50 kt clean, about 45 kt with full flaps).
  The STALL lamp flashes, the horn sounds and the aircraft buffets. Lower the nose to recover.
- **Limits:** the never-exceed speed is 165 kt and the airframe is rated to +7 / −3.5 G. The LIMIT lamp and a warble warn you
  as you get close. Beyond that the aircraft breaks up.
- **Landing:** follow the PAPI lights beside each runway: two white and two red means you're on a 3° glide path.
  Ground effect makes the aircraft float in the flare. Under 150 ft/min is a "butter" landing, and anything over
  about 900 ft/min breaks the gear.
- **Obstacles:** trees and buildings are solid.

## Instruments

The panel has six round gauges: airspeed (white flap, green normal and yellow caution arcs, red line), attitude,
altimeter, tachometer, heading indicator (with the autopilot heading bug) and vertical speed. Next to them are
throttle, flap and trim indicators and STALL / LIMIT / BRAKE / A/P / GND / LOW lamps. In the cockpit view the same
gauges are drawn live on the 3D instrument panel, and a green HUD adds a pitch ladder, a flight-path marker, a heading
tape and speed/altitude boxes. The top-left readout shows indicated and ground speed, altitudes, vertical speed,
angle of attack, G-load and wind. A minimap sits top-right and N opens the full island map.

## How it works

| File | What it does |
| --- | --- |
| `js/aircraft.js` | Flight model: a rigid body with lift (with stall), drag (parasitic + induced, reduced in ground effect), side force, propeller thrust and slipstream, air density with altitude, control moments, static stability, damping, adverse yaw, wind-relative aerodynamics, and spring-damper landing gear with brakes, nose-wheel steering and grass vs asphalt friction. Also crash and structural-limit detection and landing scoring. Runs at 240 Hz in fixed steps. |
| `js/weather.js` | Prevailing wind with a boundary-layer profile, slow gusts and veer, and turbulence that grows near the ground and over rough terrain. |
| `js/autopilot.js` | Heading and altitude hold with coordinated turns and stall protection. |
| `js/terrain.js` | The island heightfield, terrain colours plus a multi-scale detail shader, the water shader (waves, Fresnel sky reflection, sun glint, shallow-water colour, shoreline foam), both airfields (runway markings drawn on a canvas, PAPI and approach lights, hangars, tower, windsocks) and instanced trees. Trees and buildings are also registered for collision. |
| `js/sky.js` | Sky dome, time-of-day presets (sun position and colour, ambient light, fog), the shadow that follows the aircraft, and clouds. |
| `js/model.js` | The aircraft: moving ailerons, flaps, elevator and rudder, propeller, wheels, nav lights, strobes and beacon, plus the cockpit interior with a live instrument panel, a yoke and a throttle. |
| `js/hud.js` | Instruments, readouts, cockpit HUD, minimap and island map, ring guidance, landing report and messages. |
| `js/rings.js` | The ring course: ring heights are fitted to the terrain so every leg is flyable. |
| `js/effects.js` | Particles: crash fire and smoke, tyre smoke, dust on grass, and wingtip vapour under high G. |
| `js/input.js` | Keyboard, gamepad, touch and mouse look. |
| `js/audio.js` | Engine, wind, tyre rumble, stall horn, limit warble, chimes and crash sounds, all generated with the Web Audio API. |
| `js/scenarios.js`, `js/settings.js`, `js/main.js` | Scenario start positions, saved settings, and scene setup, cameras, menus and the main loop. |
