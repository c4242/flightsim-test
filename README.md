# Skyhaven Flight

A flight simulator that runs in the browser. Fly a light single-engine trainer or an **F-16C Fighting
Falcon** over a procedurally generated island with two airfields, five villages, a mountain canyon, forests, farmland
and sea, with another aircraft flying circuits at the main airfield.

**Play:** https://c4242.github.io/flightsim-test/
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

## Aircraft

Pick the aircraft in the menu (Settings → Aircraft).

### Skylark (light trainer)
A 1,100 kg, 180 hp low-wing trainer in the class of a Piper Cherokee or Cessna 172. It has
conventional controls (the stick moves the control surfaces directly), flaps, trim and fixed landing
gear. It stalls at about 50 kt and cruises at about 100–120 kt.

### F-16C Fighting Falcon (Block 50, F110-GE-129)
The F-16 is modelled as realistically as a browser game allows:

- **Mass and inertia:** about 12.3 t with full internal fuel (7,000 lb) and two wingtip AIM-9s.
  The moments of inertia are the published F-16 values.
- **Engine:** the thrust tables (idle, military power and full afterburner, by altitude and Mach) of the
  F-16 model in Stevens & Lewis, *Aircraft Control and Simulation*, scaled to the installed thrust of the
  F110-GE-129. Core RPM spools up from idle to military power in about 4–5 s, the afterburner takes a
  moment to light, and fuel flow follows thrust: roughly 0.7 lb/lbf/h dry and 1.9 lb/lbf/h in
  afterburner, which is about 60,000 lb/h at full afterburner low down. When the tanks run dry the engine flames out.
- **Aerodynamics:** the lift slope varies with Mach, strake vortex lift carries it up to about 34° AoA,
  drag rises transonically (peaking near Mach 1.1) and wave drag applies above that. Gear, flaps and
  speedbrakes all add drag.
- **Atmosphere:** International Standard Atmosphere, with true Mach number and calibrated airspeed (KCAS).
- **Flight control system (fly-by-wire):**
  - In pitch, the side-stick commands G: neutral is 1 g, full aft 9 g, full forward −3 g. Integral
    action trims out errors.
  - The AoA limiter stops at 25°.
  - Roll is a rate command of up to about 270°/s, made about the velocity vector, and sideslip is
    suppressed automatically.
  - With the gear handle down, the system switches to takeoff/landing gains: the stick commands pitch
    rate, a released stick holds AoA (for the 13° approach), and AoA is limited to 20°.
- **Limits:** 800 KCAS and Mach 2.05. The airframe fails beyond about 950 KCAS, Mach 2.25 or +11.5 g.
  The gear is torn off well above its 300 KCAS limit. A tail strike happens at about 15° pitch on the main wheels.
- **Ground handling:** retractable gear (with a weight-on-wheels lock), nose-wheel steering, anti-skid
  brakes, speedbrakes and a parking brake.

Checked performance from the test scripts:

| | Model | Real F-16C |
| --- | --- | --- |
| Top speed at 36,000 ft, full afterburner | M2.03 | M2.05 |
| Military power at sea level | M0.94 | ≈M0.92 |
| Afterburner takeoff roll / liftoff | ≈480 m / ≈180 KCAS | ≈450 m |
| Peak G, full aft stick | 8.96 | 9 |
| Maximum roll rate | 269°/s | ≈270°/s |
| Engine-out glide ratio at 200 KCAS | 6.8 | ≈7–8 |
| Approach | 13° AoA at ≈150 KCAS | 13° AoA, 140–160 KCAS |
| Landing roll without drag chute | ≈1,000 m | 760–1,070 m |

**Cockpit:** the cockpit view uses the FlightGear F-16's 3D cockpit:
- **What's in it:** the instrument panel, ICP keypad, side consoles, throttle, side-stick and seat, inside the
  real fuselage and canopy frame.
- **Moving parts:** the airspeed, attitude, AoA, VVI, HSI and standby instruments, plus the stick, throttle,
  pedals and gear handle, are driven by the simulation.
- **Screens:** the two MFDs show this game's engine and attitude pages.
- **Loading:** the cockpit loads the first time you switch to the cockpit view, and the simple cockpit shows
  until then.
- **Eye point:** FlightGear's own pilot eye point, view angle and field of view (68.5°) are used.

**3D model:** the F-16 is the detailed model from the open-source
[FlightGear F-16](https://github.com/NikolaiVChr/f16), with its textures, markings, wingtip AIM-9Ls and
GE nozzle. Its gear, gear doors, stabilators, flaperons, leading-edge flaps, rudder, speedbrakes and
nozzle petals are animated from the simulation. The game reads the AC3D model files directly and
re-implements the FlightGear animations it needs (`js/acloader.js`, `js/model-f16fg.js`). The gear and
collision points were matched to this model. If the model can't be loaded, a simple built-in model is
shown instead.

The jet has an F-16-style **HUD** (airspeed and altitude tapes, heading, G, Mach, AoA, pitch ladder,
flight-path marker, the landing AoA bracket, and AOA / OVERSPEED / PULL UP / BINGO warnings), an engine
and systems strip in the outside views, and a cockpit with two live MFDs and a side-stick. Sustained high G
greys out and then blacks out your vision, and negative G reds it out. Near the speed of sound at low level
you get a vapour cone, and you get strake vortices at high AoA.

Skyhaven's runway is 2,400 m so the F-16 can operate from it. Eastfield (850 m) is for the light aircraft only.

## Weather, instruments and refuelling

- **Clouds** (Settings → Clouds):
  - **Clear.**
  - **Scattered:** cumulus.
  - **Overcast:** a solid deck with its base at about 1,500 ft. Below it the sky is grey and the light is
    flat. Inside it you're in white-out. Above it you're in sunshine over a sea of cloud, with the mountain
    tops poking through.
  - **Fog:** visibility under a kilometre near the ground, clearing as you climb.

  Some missions set their own weather.
- **ILS:** both ends of Skyhaven's runway have an instrument landing system.
  - The localizer gives ±2.5° full scale and the glideslope 3° (±0.7° full scale), with DME to the threshold.
  - Reception extends to 18 NM out and up to about 10,000 ft above the field.
  - The light aircraft shows magenta needles on its attitude indicator.
  - The F-16 shows localizer and glideslope steering bars around the flight-path marker on the HUD.
- **Air-to-air refuelling (F-16):** a four-engine boom tanker flies a left-hand racetrack at 20,000 ft and
  about 300 KCAS (it's on the map).
  - Fly the receptacle behind your canopy into the boom envelope: boom 11–19 m, 22–38° below the tanker,
    ±12° either side. Hold it there with less than about 2.5 m/s of closure.
  - The boom operator then makes contact and fuel flows at about 1,000 lb/min.
  - The HUD shows the director cues (UP/DOWN, FWD/AFT, LEFT/RIGHT). Leaving the limits disconnects you,
    and hitting the tanker is a crash.
- **Sonic boom:** heard from the outside cameras when the jet accelerates through Mach 1.
- **Adaptive resolution:** the render resolution drops automatically when the frame rate falls below
  about 40 fps, and comes back up when there is headroom.

## Scenarios

- **Take off from Skyhaven:** start at the south end of runway 36, engine idling.
- **Final approach, Skyhaven 36:** 4 km out on a 3° glide path, trimmed at 75 kt with 15° flaps.
- **Final approach, Eastfield 28:** a short strip on a hilltop plateau (380 ft), approached over the sea with full flaps.
- **Start in the air:** cruising at about 3,000 ft.
- **Ring course:** a timed low-level course through 12 rings. It crosses the western lowlands, makes a low pass over
  Skyhaven, runs up the canyon, turns out over the northern sea and comes back. Your best time is saved.

Every landing is scored out of 100 for sink rate, touchdown point, centreline and crab angle.

## Missions

Flight-school missions have objectives to complete in order. A panel lists them, and an arrow points to the
next gate or destination. You earn one to three stars based on your landing score; your best is saved.

| Mission | What you do |
| --- | --- |
| **F-16:** Viper familiarisation | Afterburner takeoff, gear up, climb to 10,000 ft, pull 6 G, come back and land. |
| **F-16:** Supersonic dash | From 30,000 ft, accelerate past Mach 1.6, then descend, slow down and land. |
| **F-16:** Canyon run | Fly fast and low through three gates up the canyon, then climb out. |
| **F-16:** Air-to-air refuelling | Low on fuel at 20,000 ft: join the tanker, get contact and take on 3,000 lb, then land. |
| **F-16:** Flameout landing | Low on fuel over the field at 9,500 ft; the engine quits; spiral down and land. |
| First flight | Take off, climb to 1,500 ft, turn south and land back at Skyhaven. |
| Traffic circuit | Fly a left-hand circuit through crosswind, downwind, base and final gates, sharing the circuit with AI traffic, and land on 36. |
| Cross-country to Eastfield | Fly over the village of Eastbrook and land on the short hilltop strip. |
| Engine failure | The engine quits on the way in. Glide to a runway at about 65 kt. |
| ILS approach in cloud (both aircraft) | Start inside a low overcast (base about 650 ft) on the localizer; fly the needles down and land on 36. |
| Strong crosswind (both aircraft) | Land on 36 in a strong, gusty westerly. |
| Night landing (both aircraft) | A moonlit approach using the approach lights, the PAPI and your landing light. |

## Replay

Press **V** at any time, or choose *Watch the replay* after a crash or a mission, to replay the last minute of
flight. C switches between the chase, tower and flyby cameras, and V or Esc returns to flying.

## Settings

The pause menu has settings for time of day (morning, noon, evening, or night with stars, moonlight, runway and
village lights and the aircraft's landing light), wind (calm, light, moderate, strong),
graphics quality (high or low; low turns off shadows and thins the forests, and is the default on touch devices),
volume and inverted pitch. They are saved in your browser. Add `?quality=low` to the URL to force low quality.

## Controls

| Key | Action |
| --- | --- |
| W / S or ↑ / ↓ | Pitch: nose down / nose up (stick forward / back) |
| A / D or ← / → | Roll left / right |
| Q / E | Rudder; also steers the nose wheel on the ground |
| R / F | Throttle up / down (hold). F-16: above 80 % is the afterburner range |
| 1 … 9, 0 | Set throttle to 10 … 90 %, or 100 % (F-16: 8 = military power, 0 = full afterburner) |
| G / T | Light aircraft: flaps down / up (0°, 15°, 30°). F-16: **G** raises / lowers the landing gear |
| X | F-16: speedbrakes out / in |
| B | Wheel brakes (hold) |
| [ / ] | Elevator trim nose down / up |
| Z | Autopilot on / off. While it's on, the pitch and roll keys move its altitude and heading targets |
| F1 / F2 / F3 / F4 | Camera: cockpit (with HUD) / chase / tower / flyby |
| C | Cycle through the cameras |
| Mouse drag / wheel | Look around / zoom the chase camera (double-click to reset) |
| N | Map |
| V | Instant replay of the last minute |
| H | Hide / show the instrument panel, readouts and minimap (the F-16 HUD always stays on) |
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
- **Obstacles:** trees, houses and airfield buildings are solid, and so is the other aircraft.

## Instruments

The panel has six round gauges: airspeed (white flap, green normal and yellow caution arcs, red line), attitude,
altimeter, tachometer, heading indicator (with the autopilot heading bug) and vertical speed. Next to them are
throttle, flap and trim indicators and STALL / LIMIT / BRAKE / A/P / GND / LOW lamps. In the cockpit view the same
gauges are drawn live on the 3D instrument panel, and a green HUD adds a pitch ladder, a flight-path marker, a heading
tape and speed/altitude boxes. The top-left readout shows indicated and ground speed, altitudes, vertical speed,
angle of attack, G-load and wind. A minimap sits top-right and N opens the full island map.

## Graphics

- **Afterburner:** a ray-marched volumetric plume. It has a hot core, a bluish sheath near the nozzle,
  a yellow-orange body fading to red, animated turbulence, and shock diamonds that shrink and fade
  downstream. It partly hides what's behind it, so it reads in daylight too. Its length and definition
  change with afterburner setting, speed and altitude. The nozzle throat glows hot, and the flame lights
  the aircraft and ground (strongest at night).
- **Bloom (HDR post-processing):** hot and bright things glow as they would through a camera lens: the
  afterburner, sun, lights and sun glints on the water. Low graphics quality turns this off.
- **Sun lens flare:** a starburst, halo and coloured ghosts. It's hidden when terrain, cloud or haze
  blocks the sun.
- **Contrails:** above about 26,000 ft, the F-16 leaves a condensation trail that forms just behind the
  nozzle and spreads and fades over 45 seconds.
- **Mountain shadows:** the terrain casts sun shadows across the island. They're computed for the sun's
  position at each time of day, so they're long at sunrise and sunset and short at noon, and they fall on
  trees and houses too.
- **Terrain relief:** fine bumps in the lighting at two scales, so slopes have texture rather than looking
  like smooth facets.
- **Aerial perspective:** haze is densest low down and thins with height (about a 1.8 km scale height).
  Valleys and distant low ground fade into it, while from high up the ground far below stays clear.
- **Cumulus clouds:** each puff is lit like a soft sphere, with sunlit tops, grey bases, light through the
  edges and a glow when you look towards the sun.
- **Heat shimmer:** the air behind the F-16's nozzle ripples, more strongly in afterburner.
- **Airport lighting:**
  - Runway edge lights, the green threshold bar and the red end bar.
  - Centreline lights that turn red/white and then red near the end of the runway.
  - Touchdown-zone lights.
  - Sequenced flashing approach strobes (the "rabbit") running towards the threshold.
  - Blue taxiway lights, and apron floodlights casting warm pools on the tarmac.
  - The lights glow through the bloom and come on at night, in cloud and in rain.
- **Rain** (Settings → Clouds → Rain):
  - A dark overcast with its base at about 1,100 ft.
  - Rain streaks that slant and stretch with your speed.
  - Drops on the windscreen in the cockpit view that bend the view behind them. They trickle down
    when you're slow and the airflow streaks them back at speed.
  - The sound of rain.
  - A wet runway: braking friction drops by about half, so the F-16 needs about 1,260 m instead of
    770 m to stop from 136 kt.
- **Altitude:** the sky deepens to a dark blue and the haze clears as you climb.

- Image-based lighting: the sky is rendered into an environment map, so paint, metal and glass reflect
  the sky and the ground. It updates when the time of day or the weather changes.
- Terrain ambient occlusion darkens valleys and gullies, and the mountains get more relief.
- Sun shadows, ACES tone mapping, a water shader, sprite clouds and an overcast deck.

## Credits and licences

- **F-16 3D model, 3D cockpit, textures and AIM-9L:** from the FlightGear F-16 by Erik Hofman, Nikolai V. Chr. and
  contributors, under the GNU General Public License v2 or later. See
  [`assets/f16/NOTICE.md`](assets/f16/NOTICE.md), `assets/f16/LICENSE` and `assets/f16/authors.txt`.
- **Everything else** in this repository was written for this project.

## How it works

| File | What it does |
| --- | --- |
| `js/aircraft.js` | Shared rigid-body flight model; the aircraft types supply the aerodynamics, engine and control laws. It covers: a rigid body with lift (with stall), drag (parasitic + induced, reduced in ground effect), side force, propeller thrust and slipstream, air density with altitude, control moments, static stability, damping, adverse yaw, wind-relative aerodynamics, and spring-damper landing gear with brakes, nose-wheel steering and grass vs asphalt friction. Also crash and structural-limit detection and landing scoring. Runs at 240 Hz in fixed steps. |
| `js/planes/f16.js` | The F-16: mass and inertia, Mach-dependent aerodynamics, the F110 engine model with spool-up, afterburner and fuel, and the fly-by-wire control laws. |
| `js/planes/skylark.js` | The light trainer's aerodynamics, propeller engine and direct control surfaces. |
| `js/atmosphere.js` | International Standard Atmosphere, Mach number and calibrated airspeed. |
| `js/acloader.js` | Loader for AC3D (`.ac`) models, the format FlightGear uses, keeping named parts for animation. |
| `js/fgmodel.js` | Loader for FlightGear model XML: sub-models with offsets, conditions, and rotate/translate/select/textranslate/spin animations. |
| `js/cockpit-fg.js` | The FlightGear F-16 cockpit: maps the flight state onto the properties its instruments read, and puts our MFD pages on its screens. |
| `js/model-f16fg.js` | Loads the FlightGear F-16 and animates its gear, control surfaces, speedbrakes and nozzle from the flight state. |
| `js/model-f16.js` | The F-16 wrapper: cockpit interior, afterburner flame and lights, plus the simple fallback model. Its parts: moving stabilators, flaperons and rudder, speedbrakes, retracting gear, afterburner plume, wingtip AIM-9s, landing light and cockpit. |
| `js/nav.js` | The ILS: localizer, glideslope and DME for both runway ends. |
| `js/tanker.js` | The refuelling tanker: racetrack flight path, model, boom, contact envelope, director cues and fuel transfer. |
| `js/atmos.js` | Height-dependent aerial perspective, replacing three.js's distance fog for all materials. |
| `js/exhaust.js` | The volumetric afterburner plume, nozzle glow and flame light. |
| `js/post.js` | HDR rendering with bloom, tone mapping and vignette. |
| `js/flare.js` | Sun lens flare with terrain and cloud occlusion. |
| `js/trails.js` | High-altitude contrails. |
| `js/rain.js` | Falling rain streaks around the camera. |
| `js/weather.js` | Prevailing wind with a boundary-layer profile, slow gusts and veer, and turbulence that grows near the ground and over rough terrain. |
| `js/autopilot.js` | Heading and altitude hold with coordinated turns and stall protection. |
| `js/terrain.js` | The island heightfield, terrain colours plus a multi-scale detail shader, the water shader (waves, Fresnel sky reflection, sun glint, shallow-water colour, shoreline foam), both airfields (runway markings drawn on a canvas, PAPI, approach and edge lights, hangars, tower, windsocks), villages of instanced houses with lit windows and street lights at night, and instanced trees. Trees and buildings are also registered for collision. |
| `js/sky.js` | Sky dome with a procedural star field, the overcast cloud deck and fog, time-of-day presets (sun position and colour, ambient light, fog), the shadow that follows the aircraft, and clouds. |
| `js/model.js` | The aircraft: moving ailerons, flaps, elevator and rudder, propeller, wheels, nav lights, strobes and beacon, plus the cockpit interior with a live instrument panel, a yoke and a throttle. |
| `js/hud.js` | Instruments, readouts, cockpit HUD, minimap and island map, ring guidance, landing report and messages. |
| `js/missions.js` | Mission definitions, objectives, scripted events (such as the engine failure) and star ratings. |
| `js/traffic.js` | The AI aircraft flying circuits with touch-and-goes along a smooth path, banking into its turns. |
| `js/replay.js` | Records the last minute of flight at 30 Hz and plays it back with interpolation. |
| `js/rings.js` | The ring course: ring heights are fitted to the terrain so every leg is flyable. |
| `js/effects.js` | Particles: crash fire and smoke, tyre smoke, dust on grass, and wingtip vapour under high G. |
| `js/input.js` | Keyboard, gamepad, touch and mouse look. |
| `js/audio.js` | Engine, wind, tyre rumble, stall horn, limit warble, chimes and crash sounds, all generated with the Web Audio API. |
| `js/scenarios.js`, `js/settings.js`, `js/main.js` | Scenario start positions, saved settings, and scene setup, cameras, menus and the main loop. |
