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
- Changes made by this project: the models are read by `js/acloader.js` and animated by `js/model-f16.js`,
  which re-implement the subset of FlightGear's model animations listed above and map them to this
  simulator's flight state. Cockpit, effects and other parts of the original aircraft are not included.
