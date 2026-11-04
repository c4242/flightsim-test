# FlightGear F-16 model

The F-16 3D model, its textures, the wingtip AIM-9L and the GE nozzle in this folder come from the
FlightGear F-16 Fighting Falcon by Erik Hofman, Nikolai V. Chr. and the other authors listed in
`authors.txt`, and are distributed under the **GNU General Public License, version 2 or (at your option)
any later version** (see `LICENSE` and `copyright.txt`).

- Source: https://github.com/NikolaiVChr/f16 (commit `cc204ce03aa05500c4f9d904aff902efd5efaa90`)
- Files taken unmodified: `f16.ac`, `f16.png`, `f16trans.png`, `nozzle-ring.png`, `canopy2.png`
  (from `Models/Effects/glass/`), `nozzle-GE.ac`, `nozzle-GE.png`, `AIM-9L_LW.ac`, `AIM-9L_RW.ac`, `AIM-9L.png`.
- `animations.json` is derived from `Models/F-16.xml`: the gear, control-surface and speedbrake
  animations, converted to JSON.
- **3D cockpit:** `Models/Cockpit/**` (the cockpit model, seat, stick, throttle, rudder pedals, side and
  auxiliary consoles, ICP, instruments, MFD bezels and their textures) and `Models/Pilots/Tex_0004_1.jpg`,
  copied unmodified with FlightGear's folder layout. Three textures (`navFreq.png`, `temp.zKnob.png`,
  `tranbg.png`) also appear in `Models/Cockpit/Textures/`: these are unchanged copies of the files in
  `Models/Cockpit/Main/`, put where FlightGear's texture search would find them.
  The HUD unit (`Models/Cockpit/hud.xml`, `hud.ac`: frame, edge and combiner glass) is included; the
  combiner glass is given its own see-through material, and this project draws its own symbology on it.
  Not included: FlightGear's HUD symbology and alternative HUD variants, kneeboards, the Block 10 stick, the Canvas-driven
  DED/PFD/CDU/RWR/threat displays, and the generic altimeter, which is part of FlightGear's base package.
- Changes made by this project: the models are read by `js/acloader.js` and animated by `js/model-f16.js`,
  which re-implement the subset of FlightGear's model animations listed above and map them to this
  simulator's flight state. The cockpit is read by `js/fgmodel.js` (a loader for FlightGear model XML,
  sub-models, offsets, conditions and rotate/translate/select/textranslate/spin animations) and
  `js/cockpit-fg.js`, which maps this simulator's state onto the FlightGear properties the instruments
  read and draws this project's own pages on the two MFD screens. Effects, sounds, Nasal scripts and
  the flight model of the original aircraft are not included.
