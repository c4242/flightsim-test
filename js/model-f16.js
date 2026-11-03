// F-16C Fighting Falcon built from primitives. Same frame as the flight model:
// -Z forward, +Y up, origin at the centre of gravity. Main dimensions follow the real aircraft:
// length 15.0 m, span 9.96 m with wingtip missiles, wing leading-edge sweep 40°.

import * as THREE from 'three';
import { loadFlightGearF16 } from './model-f16fg.js';
import { loadFlightGearCockpit, FG_EYE, FG_VIEW_PITCH, FG_FOV } from './cockpit-fg.js';

const DEG = Math.PI / 180;

function glowTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

// Flat planform (x across, z along) extruded to a thin surface, mirrored for the left side.
function planform(points, thickness, side = 1) {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => (i ? shape.lineTo(side * x, z) : shape.moveTo(side * x, z)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: thickness * 0.3, bevelSize: thickness * 0.4, bevelSegments: 1 });
  geo.rotateX(Math.PI / 2); // shape y -> z, extrusion -> -y
  geo.translate(0, thickness / 2, 0);
  return geo;
}

// The detailed FlightGear model is loaded in the background; until it arrives (or if it can't be
// loaded) the primitive model below is shown.
export function createF16Model({ renderer } = {}) {
  const root = new THREE.Group();
  const greyHi = new THREE.MeshStandardMaterial({ color: 0x8e959b, roughness: 0.55, metalness: 0.15 });
  const greyLo = new THREE.MeshStandardMaterial({ color: 0xa9afb4, roughness: 0.55, metalness: 0.15 });
  const radome = new THREE.MeshStandardMaterial({ color: 0x7b8086, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.8 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8c90, roughness: 0.35, metalness: 0.8 });
  const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x5a5149, roughness: 0.5, metalness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.5 });
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x6b5a2a, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.45,
  });
  const add = (geo, mat, parent = root, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const lathe = (pts, mat, y = 0.1, sx = 1, sy = 0.92) => {
    const geo = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, z)), 28)
      .rotateX(Math.PI / 2).scale(sx, sy, 1).translate(0, y, 0);
    return add(geo, mat);
  };

  // ---------- Fuselage (split so the cabin section can be hidden in the cockpit view) ----------
  lathe([[0, -8.62], [0.1, -8.45], [0.26, -7.9], [0.4, -7.2], [0.5, -6.5]], radome);
  const cabinFront = lathe([[0.5, -6.5], [0.6, -5.6], [0.64, -5.3]], greyHi);
  const cabin = lathe([[0.64, -5.3], [0.7, -4.2], [0.74, -2.5], [0.76, 0], [0.72, 2.5], [0.64, 4.4], [0.55, 5.4], [0.5, 5.8]], greyHi);
  // Pitot boom.
  add(new THREE.CylinderGeometry(0.02, 0.03, 0.7, 6).rotateX(Math.PI / 2).translate(0, 0.1, -8.95), metal);
  // Dorsal spine behind the canopy.
  const spine = add(new THREE.BoxGeometry(0.5, 0.35, 6.0), greyHi);
  spine.position.set(0, 0.72, 0.3);
  // Chin intake with a dark mouth, and the intake duct under the fuselage.
  const intake = add(new THREE.BoxGeometry(1.0, 0.72, 3.9), greyLo);
  intake.position.set(0, -0.56, -2.75);
  const mouth = add(new THREE.PlaneGeometry(0.86, 0.58), dark, root, false);
  mouth.position.set(0, -0.56, -4.71);
  mouth.rotation.y = Math.PI;
  const lip = add(new THREE.BoxGeometry(1.02, 0.08, 0.2), greyLo);
  lip.position.set(0, -0.9, -4.62);
  // Lower fuselage fairing to blend the intake.
  const belly = add(new THREE.BoxGeometry(1.2, 0.5, 6.0), greyLo);
  belly.position.set(0, -0.35, 1.6);

  // Strakes (leading-edge extensions) and wings.
  const flaperons = [];
  for (const side of [-1, 1]) {
    add(planform([[0.55, -6.4], [1.0, -3.2], [1.15, -2.3], [0.6, -2.3]], 0.06, side), greyHi).position.y = 0.05;
    add(planform([[0.7, -2.3], [4.72, 1.07], [4.72, 2.2], [3.05, 2.2], [3.05, 1.68], [0.9, 1.68], [0.9, 2.2], [0.7, 2.2]], 0.12, side), greyHi);
    // Flaperon (hinged at its leading edge).
    const hinge = new THREE.Group();
    hinge.position.set(side * 1.97, 0.0, 1.68);
    root.add(hinge);
    add(new THREE.BoxGeometry(2.13, 0.07, 0.52), greyHi, hinge).position.set(0, 0, 0.26);
    flaperons.push({ hinge, side });
    // Wingtip launch rail and AIM-9.
    const rail = add(new THREE.BoxGeometry(0.1, 0.12, 2.6), greyLo);
    rail.position.set(side * 4.84, 0.0, 1.0);
    const msl = add(new THREE.CylinderGeometry(0.064, 0.064, 2.85, 10).rotateX(Math.PI / 2), white);
    msl.position.set(side * 4.98, -0.04, 0.75);
    add(new THREE.ConeGeometry(0.064, 0.25, 10).rotateX(-Math.PI / 2), dark).position.set(side * 4.98, -0.04, -0.8);
    for (const a of [0, Math.PI / 2]) {
      const fin = add(new THREE.BoxGeometry(0.42, 0.01, 0.25), greyLo);
      fin.position.set(side * 4.98, -0.04, 2.0);
      fin.rotation.z = a + Math.PI / 4;
      const can = add(new THREE.BoxGeometry(0.3, 0.01, 0.12), greyLo);
      can.position.set(side * 4.98, -0.04, -0.45);
      can.rotation.z = a + Math.PI / 4;
    }
  }

  // All-moving horizontal stabilators with 10° anhedral, pivoting near 35% chord.
  const stabs = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.7, 0.0, 5.15);
    pivot.rotation.z = side * -10 * DEG;
    root.add(pivot);
    const g = planform([[0, -1.1], [2.05, 0.65], [2.05, 1.35], [0, 1.25]], 0.07, side);
    add(g, greyHi, pivot);
    stabs.push({ pivot, side });
  }

  // Vertical tail and rudder.
  const finGeo = planform([[0, 2.55], [0, 6.0], [2.35, 6.05], [2.35, 5.05]], 0.09, 1);
  // The planform helper builds horizontal surfaces; stand this one up on the spine.
  finGeo.rotateZ(Math.PI / 2);
  const fin = add(finGeo, greyHi);
  fin.position.set(0.045, 0.72, 0);
  const rudHinge = new THREE.Group();
  rudHinge.position.set(0, 1.1, 5.55);
  root.add(rudHinge);
  add(new THREE.BoxGeometry(0.07, 1.8, 0.5), greyHi, rudHinge).position.set(0, 0.85, 0.25);
  // Ventral fins, canted outwards.
  for (const side of [-1, 1]) {
    const v = add(new THREE.BoxGeometry(0.05, 0.45, 1.3), greyLo);
    v.position.set(side * 0.55, -0.55, 4.2);
    v.rotation.z = side * 15 * DEG;
  }

  // Engine nozzle: opens with the afterburner, with a flame plume behind it.
  const nozzle = add(new THREE.CylinderGeometry(0.5, 0.46, 0.9, 20, 1, true).rotateX(Math.PI / 2), nozzleMat);
  nozzle.position.set(0, 0.3, 6.05);
  nozzle.material.side = THREE.DoubleSide;
  const inner = add(new THREE.CircleGeometry(0.4, 20), dark, root, false);
  inner.position.set(0, 0.3, 5.75);
  const glowTex = glowTexture();
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xff9a3c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const flame = add(new THREE.ConeGeometry(0.42, 1, 20, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.5), flameMat, root, false);
  flame.position.set(0, 0.3, 6.45);
  const core = add(new THREE.ConeGeometry(0.26, 1, 16, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.5), coreMat, root, false);
  core.position.set(0, 0.3, 6.45);
  const exhaustGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  exhaustGlow.position.set(0, 0.3, 6.6);
  exhaustGlow.scale.set(2.2, 2.2, 1);
  root.add(exhaustGlow);

  // Speedbrakes either side of the nozzle.
  const brakes = [];
  for (const side of [-1, 1]) {
    for (const up of [1, -1]) {
      const hinge = new THREE.Group();
      hinge.position.set(side * 0.62, 0.3 + up * 0.12, 5.25);
      root.add(hinge);
      add(new THREE.BoxGeometry(0.04, 0.35, 0.9), greyHi, hinge).position.set(0, up * 0.17, 0.45);
      brakes.push({ hinge, up });
    }
  }

  // Bubble canopy.
  const canopy = add(new THREE.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), canopyMat, root, false);
  canopy.scale.set(0.43, 0.5, 1.75);
  canopy.position.set(0, 0.62, -4.45);
  // Ejection seat headrest visible through the canopy.
  add(new THREE.BoxGeometry(0.34, 0.45, 0.2), dark).position.set(0, 0.85, -4.1);

  // ---------- Landing gear (retracts) ----------
  const tyre = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.9 });
  const legs = [];
  const makeLeg = (x, z, wheelR, top, width, fold) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, top, z);
    root.add(pivot);
    const len = top - (-1.72 + wheelR);
    add(new THREE.CylinderGeometry(0.05, 0.06, len, 8), metal, pivot).position.y = -len / 2;
    const w = add(new THREE.CylinderGeometry(wheelR, wheelR, width, 18).rotateZ(Math.PI / 2), tyre, pivot);
    w.position.y = -len;
    legs.push({ pivot, fold, wheel: w, r: wheelR });
  };
  makeLeg(0, -3.4, 0.24, -0.9, 0.18, -1);        // nose gear folds aft
  makeLeg(-1.18, 0.65, 0.36, -0.55, 0.22, 1);   // mains fold forward into the fuselage
  makeLeg(1.18, 0.65, 0.36, -0.55, 0.22, 1);

  // ---------- Lights ----------
  const light = (color, x, y, z, size) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    sp.position.set(x, y, z);
    sp.scale.set(size, size, 1);
    root.add(sp);
    return sp;
  };
  light(0xff2020, -1.35, 0.4, -2.6, 0.35);   // position lights on the intake sides (simplified)
  light(0x20ff40, 1.35, 0.4, -2.6, 0.35);
  light(0xffffff, 0, 3.1, 6.2, 0.3);
  const beacon = light(0xffffff, 0, 3.05, 5.2, 0.9);
  const landingLight = new THREE.SpotLight(0xfff4e0, 120000, 900, 0.25, 0.6, 2);
  landingLight.position.set(0, -1.3, -3.6);
  landingLight.target.position.set(0, -14, -80);
  landingLight.visible = false;
  root.add(landingLight, landingLight.target);
  const landingGlow = light(0xfff4e0, 0, -1.3, -3.7, 1.0);
  landingGlow.visible = false;

  // ---------- Cockpit interior ----------
  const cockpit = new THREE.Group();
  cockpit.visible = false;
  root.add(cockpit);
  const black = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9 });
  const consoleMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.85 });
  const cAdd = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); cockpit.add(m); return m; };
  const panelCanvas = document.createElement('canvas');
  panelCanvas.width = 1024; panelCanvas.height = 400;
  const panelTex = new THREE.CanvasTexture(panelCanvas);
  panelTex.colorSpace = THREE.SRGBColorSpace;
  panelTex.anisotropy = 4;
  const panel = cAdd(new THREE.PlaneGeometry(1.0, 0.39), new THREE.MeshBasicMaterial({ map: panelTex, toneMapped: false }), 0, 0.45, -5.52);
  panel.rotation.x = -0.3;
  // Panel housing, extended forward to the radome so nothing shows through when the skin is hidden.
  cAdd(new THREE.BoxGeometry(1.1, 0.5, 1.0), black, 0, 0.42, -6.1);
  cAdd(new THREE.BoxGeometry(1.25, 0.9, 0.05), black, 0, 0.0, -6.55);
  cAdd(new THREE.BoxGeometry(0.75, 0.06, 0.32), black, 0, 0.7, -5.55);   // glare shield
  // HUD combiner glass and its frame.
  const comb = cAdd(new THREE.PlaneGeometry(0.2, 0.18), new THREE.MeshBasicMaterial({ color: 0x9fffb0, transparent: true, opacity: 0.08, depthWrite: false }), 0, 0.84, -5.47);
  comb.rotation.x = -0.25;
  cAdd(new THREE.BoxGeometry(0.22, 0.02, 0.06), black, 0, 0.74, -5.45);
  for (const sx of [-1, 1]) {
    cAdd(new THREE.BoxGeometry(0.2, 0.08, 1.4), consoleMat, sx * 0.42, 0.42, -4.6);  // side consoles
    cAdd(new THREE.BoxGeometry(0.03, 0.5, 1.6), consoleMat, sx * 0.55, 0.3, -4.6);   // cockpit walls
  }
  cAdd(new THREE.BoxGeometry(1.0, 0.03, 1.6), black, 0, 0.05, -4.7);
  // Side-stick on the right console and throttle on the left.
  const stick = new THREE.Group();
  stick.position.set(0.4, 0.47, -4.95);
  cockpit.add(stick);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.13, 8), black);
  grip.position.y = 0.065;
  stick.add(grip);
  const thrGrip = cAdd(new THREE.BoxGeometry(0.05, 0.08, 0.08), black, -0.42, 0.5, -4.8);

  let t = 0;
  let night = false;
  let cockpitView = false;
  const eye = new THREE.Vector3(0, 0.9, -4.75);

  // ---------- FlightGear cockpit (loaded the first time the cockpit view is used) ----------
  const mfdCanvases = [0, 1].map(() => { const c = document.createElement('canvas'); c.width = c.height = 512; return c; });
  let fgPit = null, fgPitLoading = false;
  const api = { viewPitch: -0.1 };
  function loadCockpit() {
    if (fgPit || fgPitLoading || !fg) return;
    fgPitLoading = true;
    loadFlightGearCockpit({ renderer, mfdCanvases }).then((p) => {
      fgPit = p;
      root.add(p.object);
      p.object.visible = cockpitView;
      cockpit.visible = false;
      eye.copy(FG_EYE);
      api.viewPitch = FG_VIEW_PITCH;
      api.cockpitFov = FG_FOV;
      // The FlightGear cockpit sits inside the real fuselage and canopy, so keep them visible
      // (apart from the canopy glass, which only looks right from outside).
      fg.setCockpitView(false);
      fg.setGlassVisible(!cockpitView);
    }).catch((err) => { fgPitLoading = false; console.warn('FlightGear cockpit not loaded, using the simple cockpit:', err); });
  }

  // ---------- FlightGear model ----------
  let fg = null;
  const keep = new Set([cockpit, flame, core, exhaustGlow, landingLight, landingLight.target, landingGlow, beacon]);
  loadFlightGearF16(renderer).then((m) => {
    fg = m;
    for (const c of root.children) if (!keep.has(c)) c.visible = false;
    root.add(m.root);
    // Re-fit our cockpit, flame and lights to the real airframe.
    cockpit.position.set(0, -0.08, 0.55);
    eye.set(0, 0.82, -4.2);
    for (const o of [flame, core]) o.position.set(0, -0.05, 5.6);
    exhaustGlow.position.set(0, -0.05, 5.75);
    beacon.position.set(0, 3.15, 5.34);
    landingLight.position.set(0, -1.45, -3.0);
    landingGlow.position.set(0, -1.45, -3.1);
    for (const [c, x, y, z, s] of [[0xff2020, -4.55, -0.04, 1.64, 0.4], [0x20ff40, 4.55, -0.04, 1.64, 0.4], [0xffffff, 0, 1.09, 5.55, 0.3]]) {
      const sp = light(c, x, y, z, s);
      keep.add(sp);
    }
    if (cockpitView) { m.setCockpitView(true); loadCockpit(); }
  }).catch((err) => console.warn('FlightGear F-16 model not loaded, using the simple model:', err));

  // defineProperties (not Object.assign) so the getters below stay live.
  return Object.defineProperties(api, Object.getOwnPropertyDescriptors({
    object: root,
    cockpit,
    panelCanvas,
    panelTex,
    eye,
    mfdCanvases,
    get fgCockpit() { return fgPit; },
    get detailed() { return !!fg; },
    setLights(n) {
      night = n;
      landingLight.visible = n;
      landingGlow.visible = n;
    },
    setCockpitView(on) {
      cockpitView = on;
      cockpit.visible = on && !fgPit;
      if (fgPit) fgPit.object.visible = on;
      if (fg) { fg.setCockpitView(on && !fgPit); fg.setGlassVisible(!(on && fgPit)); if (on) loadCockpit(); return; }
      cabin.visible = !on;
      cabinFront.visible = !on;
      canopy.visible = !on;
      spine.visible = !on;
    },
    update(ac, dt) {
      t += dt;
      const c = ac.controls;
      if (fg) {
        fg.update(ac);
        // The landing light is on the nose gear: only with the gear down.
        landingLight.visible = landingGlow.visible = night && (ac.gearDown ?? 1) > 0.9;
      } else updatePrimitive(ac, dt);
      // Afterburner flame.
      const ab = ac.abLit ? ac.ab ?? 0 : 0;
      const flick = 0.9 + Math.sin(t * 60) * 0.06 + Math.sin(t * 37) * 0.04;
      flame.scale.set(0.9 + ab * 0.2, 0.9 + ab * 0.2, (1.5 + ab * 4) * flick);
      flameMat.opacity = ab > 0.01 ? 0.35 + ab * 0.45 : 0;
      core.scale.set(1, 1, (1 + ab * 2.2) * flick);
      coreMat.opacity = ab > 0.01 ? 0.5 : 0;
      exhaustGlow.material.opacity = ab > 0.01 ? 0.6 + ab * 0.4 : Math.max(0, ((ac.n2 ?? 0) - 0.9) * 2);
      beacon.visible = (t % 1.0) < 0.1;
      if (fgPit && cockpitView) fgPit.update(ac, dt, api.nav ?? null);
      // Cockpit controls.
      stick.rotation.x = -c.elevator * 0.25;
      stick.rotation.z = -c.aileron * 0.25;
      thrGrip.position.z = -4.8 - c.throttle * 0.12;
    },
  }));

  function updatePrimitive(ac, dt) {
      const c = ac.controls;
      // Control surfaces follow the stick (the FCS moves them; this is a visual approximation).
      const pitchCmd = Math.max(-1, Math.min(1, c.elevator + (ac.trim ?? 0)));
      for (const s of stabs) s.pivot.rotation.x = -pitchCmd * 0.35 + s.side * c.aileron * 0.15;
      const droop = (ac.gearDown ?? 1) * 20 * DEG;
      for (const f of flaperons) f.hinge.rotation.x = droop - f.side * c.aileron * 0.3;
      rudHinge.rotation.y = c.rudder * 0.4;
      const sb = ac.speedbrake ?? 0;
      for (const b of brakes) b.hinge.rotation.x = b.up * -sb * 60 * DEG * 0.5;
      for (const b of brakes) b.hinge.rotation.y = 0;
      // Gear: fold the legs and hide them once retracted.
      const gd = ac.gearDown ?? 1;
      for (const l of legs) {
        l.pivot.rotation.x = l.fold * (1 - gd) * Math.PI / 2;
        l.pivot.visible = gd > 0.03;
        if (ac.onGround) l.wheel.rotation.x -= (ac.speed / l.r) * dt;
      }
      const noz = ac.nozzle ?? 0;
      nozzle.scale.set(0.9 + noz * 0.15, 0.9 + noz * 0.15, 1);
  }
}
