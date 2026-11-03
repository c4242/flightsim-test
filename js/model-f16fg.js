// The FlightGear F-16 (GPL-2.0-or-later, see assets/f16/NOTICE.md) loaded from its AC3D files,
// with a re-implementation of the subset of FlightGear's model animations it uses for the
// landing gear, control surfaces, speedbrakes and nozzle, driven by this simulator's state.
//
// FlightGear model axes are x aft, y right, z up; AC3D files are x aft, y up, z left; ours are
// x right, y up, z aft with the origin at the centre of gravity.

import * as THREE from 'three';
import { parseAC } from './acloader.js';

const BASE = 'assets/f16/';
// Where our centre of gravity sits in the FlightGear model frame (metres).
export const CG_X = -0.04, CG_Z = 0.05;
const fgToOur = (x, y, z) => [y, z - CG_Z, x - CG_X];
const acToFg = (x, y, z) => [x, -z, y];
const fgVec = (o) => new THREE.Vector3(o.y ?? 0, o.z ?? 0, o.x ?? 0);
const fgPoint = (o) => new THREE.Vector3(o['y-m'] ?? 0, (o['z-m'] ?? 0) - CG_Z, (o['x-m'] ?? 0) - CG_X);

// Parts we don't use: FlightGear's own flame (we draw ours), engine fan variants, the Dutch tail
// antenna fairing (we show the USAF one) and the drag chute.
const SKIP = new Set(['ExternalFlame', 'InternalFlame', 'FanSpinning', 'FanRHighSpeed', 'FanRHighSpeed.001', 'FanR.001',
  'RNLAF_Tailroot', 'Chute', 'Blender_exporter_v2.26__nozzle-GE-3.ac', 'InNozzleROpen']);
// Hidden in the cockpit view (our own cockpit interior is shown instead).
const COCKPIT_HIDE = ['RadarDomeTop', 'CanopyForwardInside', 'CanopyForwardOutside', 'CanopyBackInside', 'CanopyBackOutside',
  'CanopyFrame', 'CanopyFrameInner', 'Link16Antennas', 'LogoPilotRight', 'FwdFormationLight', 'PitotTube'];

async function fetchText(f) {
  const r = await fetch(BASE + f);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  return r.text();
}

function loadTexture(loader, f, renderer) {
  return new Promise((resolve, reject) => loader.load(BASE + f, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 4;
    resolve(t);
  }, undefined, reject));
}

export async function loadFlightGearF16(renderer) {
  const tl = new THREE.TextureLoader();
  const texNames = ['f16.png', 'f16trans.png', 'canopy2.png', 'nozzle-ring.png', 'nozzle-GE.png', 'AIM-9L.png'];
  const [airText, nozText, aimLText, aimRText, animJson, nozAnimJson, ...texList] = await Promise.all([
    fetchText('f16.ac'), fetchText('nozzle-GE.ac'), fetchText('AIM-9L_LW.ac'), fetchText('AIM-9L_RW.ac'),
    fetchText('animations.json').then(JSON.parse), fetchText('nozzle-animations.json').then(JSON.parse),
    ...texNames.map((n) => loadTexture(tl, n, renderer)),
  ]);
  const textures = Object.fromEntries(texNames.map((n, i) => [n, texList[i]]));

  const glass = new THREE.MeshStandardMaterial({
    color: 0x6e5d32, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false,
  });
  const material = (m, tex, twoSided, name) => {
    if (/^Canopy(Forward|Back)(Inside|Outside)$/.test(name)) return glass;
    const map = tex ? textures[tex.split('/').pop()] ?? null : null;
    if (tex && tex.endsWith('f16trans.png')) {
      // Insignia and markings: alpha-blended decals.
      return new THREE.MeshStandardMaterial({ map, transparent: true, alphaTest: 0.05, depthWrite: false, roughness: 0.6,
        polygonOffset: true, polygonOffsetFactor: -2, side: twoSided ? THREE.DoubleSide : THREE.FrontSide });
    }
    return new THREE.MeshStandardMaterial({
      map, color: new THREE.Color(m.rgb[0], m.rgb[1], m.rgb[2]),
      roughness: THREE.MathUtils.clamp(1 - m.shi / 160, 0.35, 0.85), metalness: map ? 0.25 : 0.15,
      side: twoSided ? THREE.DoubleSide : THREE.FrontSide,
    });
  };
  const materialKey = (name) => (/^Canopy(Forward|Back)/.test(name) ? 'glass' : '');

  const root = new THREE.Group();
  root.name = 'FlightGear F-16';
  const objects = new Map();
  const merge = (r) => {
    root.add(r.root);
    for (const [k, v] of r.objects) objects.set(k, (objects.get(k) ?? []).concat(v));
  };
  merge(parseAC(airText, { toModel: (x, y, z) => fgToOur(...acToFg(x, y, z)), textures, skip: SKIP, material, materialKey }));

  // GE nozzle: placed as F-16.xml does (offset, translations, then a radial scale of 0.82).
  const nozzleOffset = new THREE.Vector3(4.61285 - 7.74, -1.4827, 1.25336);
  const nozzlePlace = (fx, fy, fz) => {
    fx += nozzleOffset.x; fy += nozzleOffset.y; fz += nozzleOffset.z;
    return fgToOur(fx, fy * 0.82, fz * 0.82);
  };
  merge(parseAC(nozText, { toModel: (x, y, z) => nozzlePlace(...acToFg(x, y, z)), textures, skip: SKIP, material }));
  // Matrix form of the same placement, to animate the petals in the nozzle's own frame.
  const P = new THREE.Matrix4().set(
    0, 0.82, 0, nozzleOffset.y * 0.82,
    0, 0, 0.82, nozzleOffset.z * 0.82 - CG_Z,
    1, 0, 0, nozzleOffset.x - CG_X,
    0, 0, 0, 1,
  );
  const Pinv = P.clone().invert();

  // Wingtip AIM-9Ls at stations 1 and 9.
  for (const [text, y] of [[aimLText, -4.865], [aimRText, 4.865]]) {
    merge(parseAC(text, { toModel: (x, yy, z) => { const f = acToFg(x, yy, z); return fgToOur(f[0] + 1.16, f[1] + y, f[2] - 0.01); }, textures, material }));
  }

  // ---- Animations ----
  const anims = animJson.map((a) => ({
    ...a,
    groups: a.objects.flatMap((n) => objects.get(n) ?? []),
    axisV: a.axis ? ('x1-m' in a.axis
      ? new THREE.Vector3(a.axis['y2-m'] - a.axis['y1-m'], a.axis['z2-m'] - a.axis['z1-m'], a.axis['x2-m'] - a.axis['x1-m']).normalize()
      : fgVec(a.axis).normalize()) : null,
    centerV: a.center ? fgPoint(a.center) : new THREE.Vector3(),
    m: new THREE.Matrix4(),
  }));
  // Per object, the animations that affect it, in file order (the first is the outermost transform).
  const chains = new Map();
  for (const a of anims) for (const g of a.groups) { if (!chains.has(g)) chains.set(g, []); chains.get(g).push(a); }
  const petals = nozAnimJson.map((a) => ({
    groups: a.objects.flatMap((n) => objects.get(n) ?? []),
    axis: new THREE.Vector3(a.axis.x, a.axis.y, a.axis.z).normalize(),
    center: new THREE.Vector3(a.center['x-m'], a.center['y-m'], a.center['z-m']),
    factor: a.factor,
  }));

  const _t = new THREE.Matrix4(), _r = new THREE.Matrix4(), _m = new THREE.Matrix4();
  const rotateAbout = (out, center, axis, rad) => out.makeTranslation(center.x, center.y, center.z)
    .multiply(_r.makeRotationAxis(axis, rad)).multiply(_t.makeTranslation(-center.x, -center.y, -center.z));
  const evalValue = (a, v) => {
    let x;
    if (a.interp) {
      const t = a.interp;
      if (v <= t[0][0]) x = t[0][1];
      else if (v >= t[t.length - 1][0]) x = t[t.length - 1][1];
      else for (let k = 1; k < t.length; k++) if (v <= t[k][0]) { const f = (v - t[k - 1][0]) / (t[k][0] - t[k - 1][0]); x = t[k - 1][1] + f * (t[k][1] - t[k - 1][1]); break; }
    } else x = v * (a.factor ?? 1) + (a.offset_deg ?? a.offset_m ?? 0);
    if (a.min_deg !== undefined) x = Math.max(a.min_deg, x);
    if (a.max_deg !== undefined) x = Math.min(a.max_deg, x);
    if (a.min_m !== undefined) x = Math.max(a.min_m, x);
    if (a.max_m !== undefined) x = Math.min(a.max_m, x);
    return x;
  };

  const DEG = Math.PI / 180;
  function update(ac) {
    const c = ac.controls;
    const gd = ac.gearDown ?? 1;
    // Control surfaces. The FCS really moves these; this follows the pilot's commands.
    const pitch = Math.max(-1, Math.min(1, c.elevator + (ac.trim ?? 0))) * 0.4;   // stabilator TE up, rad
    const rollTail = c.aileron * 0.09;                                               // differential tail
    const droop = gd * 20;                                                           // flaperons with gear down
    const leftTEdown = Math.max(-21.5, Math.min(21.5, droop + c.aileron * 20));
    const rightTEdown = Math.max(-21.5, Math.min(21.5, droop - c.aileron * 20));
    // Leading-edge flap schedule (Stevens & Lewis): 1.38·α − 9.05·q̄/p + 1.45 degrees, limited to −2…25°.
    const mach = ac.mach ?? 0;
    const lef = ac.onGround ? 0 : Math.max(-2, Math.min(25, 1.38 * (ac.alpha ?? 0) / DEG - 9.05 * 0.7 * mach * mach + 1.45));
    const steerNorm = ac.onGround ? c.rudder * 0.9 * Math.max(0.1, 1 - (ac.speed ?? 0) / 45) : 0;
    const props = {
      'gear/gear[0]/position-norm': gd, 'gear/gear[1]/position-norm': gd, 'gear/gear[2]/position-norm': gd,
      'gear/gear/compression-norm': ac.onGround ? 0.27 : 0, 'gear/gear[1]/compression-norm': 0, 'gear/gear[2]/compression-norm': 0,
      'surface-positions/elevator-pos-norm': pitch - rollTail,
      'sim/multiplay/generic/float[4]': -(pitch + rollTail),
      'sim/multiplay/generic/float[5]': -leftTEdown / 20,
      'sim/multiplay/generic/float[6]': rightTEdown / 20,
      'sim/multiplay/generic/float[7]': steerNorm,
      'surface-positions/flap-pos-norm': lef,
      'surface-positions/rudder-pos-norm': c.rudder,
      'surface-positions/speedbrake-pos-norm': ac.speedbrake ?? 0,
    };
    for (const a of anims) {
      const v = props[a.prop] ?? 0;
      if (a.type === 'select') { a.visible = Math.abs(v) > 1e-4; continue; }
      const x = evalValue(a, v);
      if (a.type === 'rotate') rotateAbout(a.m, a.centerV, a.axisV, x * DEG);
      else if (a.type === 'translate') a.m.makeTranslation(a.axisV.x * x, a.axisV.y * x, a.axisV.z * x);
      else a.m.identity();
    }
    for (const [g, list] of chains) {
      _m.identity();
      let visible = true;
      for (const a of list) {
        if (a.type === 'select') visible = visible && a.visible;
        else _m.multiply(a.m);
      }
      g.matrix.copy(_m);
      g.matrixWorldNeedsUpdate = true;
      g.visible = visible;
    }
    // Nozzle petals open with the nozzle position (rotated in the nozzle's own frame).
    const noz = ac.nozzle ?? 0;
    for (const p of petals) {
      rotateAbout(_m, p.center, p.axis, noz * p.factor * DEG);
      const M = P.clone().multiply(_m).multiply(Pinv);
      for (const g of p.groups) { g.matrix.copy(M); g.matrixWorldNeedsUpdate = true; }
    }
  }

  const hideInCockpit = COCKPIT_HIDE.flatMap((n) => objects.get(n) ?? []);
  const glassParts = ['CanopyForwardInside', 'CanopyForwardOutside', 'CanopyBackInside', 'CanopyBackOutside'].flatMap((n) => objects.get(n) ?? []);
  return {
    root,
    objects,
    update,
    setCockpitView(on) { for (const g of hideInCockpit) g.visible = !on; },
    setGlassVisible(on) { for (const g of glassParts) g.visible = on; },
  };
}
