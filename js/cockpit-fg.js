// The FlightGear F-16 3D cockpit (GPL-2.0-or-later, see assets/f16/NOTICE.md), loaded on demand
// with js/fgmodel.js. Our flight state is mapped onto the FlightGear properties its instruments,
// switches and lights read, as for a Block 50 with all electrical buses powered.
// The two MFD screens show this simulator's own pages (FlightGear draws them with its Canvas system).

import * as THREE from 'three';
import { loadFGModel } from './fgmodel.js';
import { CG_X, CG_Z } from './model-f16fg.js';

const ROOT = 'assets/f16/';
// FlightGear's pilot eye point, view pitch and field of view for the F-16 (view 0 in f16-base.xml),
// converted to our frame.
export const FG_EYE = new THREE.Vector3(0, 0.8579 - CG_Z, -4.105 - CG_X);
export const FG_VIEW_PITCH = -15 * Math.PI / 180;
export const FG_FOV = 68.5;

// Sub-models we leave out: FlightGear's own HUD glass and symbology (we draw our HUD), the
// kneeboards, the Block 10 stick, the DED/PFD/CDU/RWR/threat displays (Canvas-driven) and the
// generic altimeter, which lives in FlightGear's base package rather than in the aircraft.
const SKIP = new Set(['HUDa', 'HUDb', 'HUDc', 'HUDd', 'knee1', 'knee2', 'F-16-FS-B10', 'CDU', 'DED', 'PFD', 'THREAT', 'IFF', 'altitude']);

function resolve(path, from) {
  if (/^\/?Aircraft\/f16\//.test(path)) return ROOT + path.replace(/^\/?Aircraft\/f16\//, '');
  if (path.startsWith('/') || path.startsWith('Aircraft/')) return null; // FlightGear base package
  const base = from.slice(0, from.lastIndexOf('/') + 1);
  const parts = (base + path).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
  return out.join('/');
}

export async function loadFlightGearCockpit({ renderer, mfdCanvases }) {
  const mfdTextures = mfdCanvases.map((cv) => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
  const env = {
    renderer,
    resolve,
    skipModel: (name) => SKIP.has(name),
    // MFD screens get our canvases; everything else keeps the original textures.
    material(m, map, twoSided, name) {
      if (name === 'MFDimage1') return new THREE.MeshBasicMaterial({ map: mfdTextures[0], toneMapped: false });
      return new THREE.MeshStandardMaterial({
        map, color: new THREE.Color(m.rgb[0], m.rgb[1], m.rgb[2]),
        emissive: new THREE.Color(m.emis[0], m.emis[1], m.emis[2]), emissiveMap: m.emis.some((v) => v > 0.05) ? map : null,
        roughness: THREE.MathUtils.clamp(1 - m.shi / 160, 0.35, 0.95), metalness: 0.1,
        side: twoSided ? THREE.DoubleSide : THREE.FrontSide,
        transparent: m.trans > 0.01 || !!(map && /trans|tranbg/i.test(map.image?.src ?? '')),
        opacity: 1 - m.trans, alphaTest: 0.02,
      });
    },
  };
  const model = await loadFGModel(ROOT + 'Models/Cockpit/Main/cockpit.xml', env);

  // FlightGear frame (x aft, y right, z up) -> ours (x right, y up, z aft), about our CG.
  const holder = new THREE.Group();
  holder.matrixAutoUpdate = false;
  holder.matrix.set(0, 1, 0, 0, 0, 0, 1, -CG_Z, 1, 0, 0, -CG_X, 0, 0, 0, 1);
  holder.add(model.root);
  holder.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
  // Left screen: engine page; right screen: attitude page. Decide by position (loading order varies).
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3();
  holder.traverse((o) => {
    if (!o.isMesh || o.name !== 'MFDimage1') return;
    box.setFromObject(o);
    const x = (box.min.x + box.max.x) / 2;
    o.material = new THREE.MeshBasicMaterial({ map: mfdTextures[x < 0 ? 0 : 1], toneMapped: false });
    // FlightGear maps only part of a texture onto the screen (its Canvas replaces it); map our
    // page over the whole screen instead, using the screen's own plane (y right, z up in its model).
    const pos = o.geometry.attributes.position;
    const bb = new THREE.Box3().setFromBufferAttribute(pos);
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getY(i) - bb.min.y) / Math.max(1e-6, bb.max.y - bb.min.y);
      uv[i * 2 + 1] = (pos.getZ(i) - bb.min.z) / Math.max(1e-6, bb.max.z - bb.min.z);
    }
    o.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  });

  // ---- Property mapping ----
  const props = new Map([
    ['sim/variant-id', 5], ['sim/variant-engine', 0], ['sim/aircraft', 'f16-block-50'],
    ['sim/current-view/internal', 1], ['f16/avionics/power-mfd', 1], ['systems/static/serviceable', 1],
    ['instrumentation/nav/in-range', 0],
  ]);
  const P = (name) => {
    if (props.has(name)) return props.get(name);
    if (name.startsWith('fdm/jsbsim/elec/bus/')) return /-ac|ac-|\/ac/.test(name) ? 115 : 28;
    return 0;
  };
  const set = (k, v) => props.set(k, v);
  const DEG = 180 / Math.PI;

  function update(ac, dt, nav) {
    const kt = ac.ias * 1.94384;
    const ft = ac.altitude * 3.28084;
    const pitch = ac.pitch * DEG, roll = ac.roll * DEG, hdg = ac.heading * DEG;
    set('instrumentation/airspeed-indicator/indicated-speed-kt', kt);
    set('velocities/airspeed-kt', kt);
    set('instrumentation/airspeed-indicator/indicated-mach', ac.mach);
    set('velocities/mach', ac.mach);
    set('instrumentation/altimeter/indicated-altitude-ft', ft);
    set('position/altitude-ft', ft);
    set('instrumentation/altimeter/setting-inhg', 29.92);
    for (const p of ['orientation', 'instrumentation/attitude-indicator', 'instrumentation/attitude-indicator[1]', 'instrumentation/attitude-indicator[2]']) {
      const pre = p === 'orientation' ? 'orientation/' : `${p}/indicated-`;
      set(`${pre}pitch-deg`, pitch);
      set(`${pre}roll-deg`, roll);
    }
    set('orientation/heading-deg', hdg);
    set('orientation/heading-magnetic-deg', hdg);
    set('instrumentation/heading-indicator/indicated-heading-deg', hdg);
    set('instrumentation/heading-indicator/heading-bug-deg', hdg);
    const fpm = ac.vel.y * 196.85;
    set('velocities/vertical-speed-fps', ac.vel.y * 3.28084);
    set('instrumentation/vertical-speed-indicator/indicated-speed-fpm', fpm);
    const aoa = ac.alpha * DEG;
    set('orientation/alpha-deg', aoa);
    set('fdm/jsbsim/aero/alpha-deg', aoa);
    set('fdm/jsbsim/fcs/fly-by-wire/pitch/alpha-indicated', aoa);
    set('accelerations/pilot-g', ac.gLoad);
    set('fdm/jsbsim/accelerations/n-pilot-z-norm', -ac.gLoad);
    // Engine.
    const rpm = (ac.n2 ?? 0) * 100;
    set('engines/engine/n2', rpm);
    set('engines/engine/n1', rpm);
    set('engines/engine/rpm', rpm);
    set('engines/engine/fuel-flow-pph', ac.fuelFlow ?? 0);
    set('engines/engine/nozzle-pos-norm', ac.nozzle ?? 0);
    set('engines/engine/egt-degf', 700 + rpm * 8);
    set('engines/engine/oil-pressure-psi', 20 + rpm * 0.25);
    set('engines/engine/running', !ac.engineFailed && (ac.fuel ?? 1) > 0 ? 1 : 0);
    set('consumables/fuel/total-fuel-lbs', (ac.fuel ?? 0) * 2.20462);
    set('fdm/jsbsim/systems/hydraulics/sysa-psi', 3000);
    set('fdm/jsbsim/systems/hydraulics/sysb-psi', 3000);
    // Controls (stick, throttle and pedals move).
    const c = ac.controls;
    set('controls/flight/elevator', -c.elevator);
    set('controls/flight/aileron', c.aileron);
    set('controls/flight/rudder', c.rudder);
    set('controls/engines/engine/throttle', c.throttle);
    set('fdm/jsbsim/fcs/throttle-cmd-norm', c.throttle);
    set('controls/flight/speedbrake', ac.speedbrakeCmd ? 1 : 0);
    set('surface-positions/speedbrake-pos-norm', ac.speedbrake ?? 0);
    // Gear handle and lights.
    const gd = ac.gearDown ?? 1;
    set('controls/gear/gear-down', ac.gearHandle ? 1 : 0);
    for (let i = 0; i < 3; i++) set(`gear/gear[${i}]/position-norm`, gd);
    set('gear/gear/position-norm', gd);
    set('controls/gear/brake-parking', ac.parkBrake ? 1 : 0);
    set('f16/fcs/autopilot-on', 0);
    // ILS on the HSI/ADI.
    set('instrumentation/nav/in-range', nav ? 1 : 0);
    set('instrumentation/nav/gs-in-range', nav?.gsValid ? 1 : 0);
    set('instrumentation/nav/heading-needle-deflection', nav ? nav.loc * 10 : 0);
    set('instrumentation/nav/gs-needle-deflection', nav ? nav.gs * 3.5 : 0);
    set('instrumentation/nav/radials/selected-deg', nav ? nav.course * DEG : 0);
    model.update(P, dt);
  }

  return { object: holder, update, mfdTextures };
}
