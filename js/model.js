// Low-wing single-engine aircraft built from primitives, with moving control surfaces.
// Same frame as the flight model: -Z forward, +Y up, origin at the centre of gravity.

import * as THREE from 'three';

export function createAircraftModel() {
  const root = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.45, metalness: 0.1 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xc8322a, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.7 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9a9ea4, roughness: 0.35, metalness: 0.7 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x1a2a3a, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.55,
  });
  const add = (geo, mat, parent = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Fuselage: a lathe around the longitudinal axis.
  const profile = [
    [0.0, -3.55], [0.32, -3.5], [0.52, -3.2], [0.6, -2.6], [0.64, -1.6], [0.65, -0.6],
    [0.6, 0.6], [0.47, 2.0], [0.3, 3.4], [0.18, 4.4], [0.0, 4.55],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fuseGeo = new THREE.LatheGeometry(profile, 24).rotateX(Math.PI / 2).scale(1, 1.12, 1);
  add(fuseGeo, white);
  // Cowling ring and spinner.
  add(new THREE.CylinderGeometry(0.34, 0.5, 0.25, 20).rotateX(Math.PI / 2).translate(0, 0, -3.45), dark);
  add(new THREE.ConeGeometry(0.2, 0.45, 16).rotateX(-Math.PI / 2).translate(0, 0, -3.75), stripe);

  // Canopy.
  const canopy = add(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(0.55, 0.55, 1.45);
  canopy.position.set(0, 0.45, -0.7);
  canopy.castShadow = false;

  // Wings with a little dihedral; ailerons hinge near the trailing edge.
  const ailerons = [];
  for (const side of [-1, 1]) {
    const wing = new THREE.Group();
    wing.position.set(side * 0.4, -0.42, 0);
    wing.rotation.z = side * 0.05;
    root.add(wing);
    const shape = new THREE.Shape();
    // Planform in (x outboard, y = z aft) metres, mirrored for the left wing.
    shape.moveTo(0, -0.75);
    shape.lineTo(side * 5.1, -0.55);
    shape.quadraticCurveTo(side * 5.35, -0.5, side * 5.3, 0.1);
    shape.lineTo(side * 5.2, 0.55);
    shape.lineTo(0, 0.85);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
    geo.rotateX(Math.PI / 2); // shape y -> z, extrusion -> -y
    geo.translate(0, 0.09, 0);
    add(geo, white, wing);
    const tip = add(new THREE.BoxGeometry(0.06, 0.1, 0.6), stripe, wing);
    tip.position.set(side * 5.33, 0.02, -0.2);
    // Aileron
    const hinge = new THREE.Group();
    hinge.position.set(side * 4.0, 0, 0.52);
    wing.add(hinge);
    const ail = add(new THREE.BoxGeometry(2.0, 0.08, 0.38), white, hinge);
    ail.position.set(0, 0, 0.19);
    ailerons.push({ hinge, side });
    // Flap
    const fh = new THREE.Group();
    fh.position.set(side * 1.75, -0.02, 0.6);
    wing.add(fh);
    const flap = add(new THREE.BoxGeometry(2.5, 0.07, 0.36), white, fh);
    flap.position.set(0, 0, 0.18);
    ailerons.push({ hinge: fh, side, flap: true });
  }

  // Horizontal stabiliser and elevator.
  const stab = add(new THREE.BoxGeometry(3.6, 0.08, 0.75), white);
  stab.position.set(0, 0.05, 3.85);
  const elevHinge = new THREE.Group();
  elevHinge.position.set(0, 0.05, 4.22);
  root.add(elevHinge);
  add(new THREE.BoxGeometry(3.5, 0.06, 0.4), stripe, elevHinge).position.set(0, 0, 0.2);

  // Fin and rudder.
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.lineTo(1.25, 0);
  finShape.lineTo(1.1, 1.35);
  finShape.lineTo(0.55, 1.35);
  finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.08, bevelEnabled: false });
  finGeo.rotateY(-Math.PI / 2).translate(0.04, 0.15, 3.0);
  add(finGeo, white);
  const rudHinge = new THREE.Group();
  rudHinge.position.set(0, 0.15, 4.25);
  root.add(rudHinge);
  add(new THREE.BoxGeometry(0.06, 1.3, 0.38), stripe, rudHinge).position.set(0, 0.68, 0.18);

  // Landing gear.
  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.16, 18).rotateZ(Math.PI / 2);
  const fairGeo = new THREE.SphereGeometry(1, 14, 10);
  const gearAt = (x, z, top) => {
    const len = top + 1.05;
    const strut = add(new THREE.CylinderGeometry(0.04, 0.05, len, 8), metal);
    strut.position.set(x, -1.05 + len / 2, z);
    const wheel = add(wheelGeo, dark);
    wheel.position.set(x, -1.05, z);
    const fair = add(fairGeo, white);
    fair.scale.set(0.15, 0.24, 0.5);
    fair.position.set(x, -0.98, z);
    return wheel;
  };
  const wheels = [gearAt(0, -2.6, -0.55), gearAt(-1.3, 0.3, -0.4), gearAt(1.3, 0.3, -0.4)];

  // Propeller: two blades plus a translucent disc that shows at high RPM.
  const prop = new THREE.Group();
  prop.position.set(0, 0, -3.62);
  root.add(prop);
  for (const s of [-1, 1]) {
    const blade = add(new THREE.BoxGeometry(0.12, 0.9, 0.03), dark, prop);
    blade.position.y = s * 0.45;
    blade.rotation.y = s * 0.25;
  }
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 32),
    new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  disc.position.z = -3.6;
  root.add(disc);

  let propAngle = 0;

  return {
    object: root,
    update(ac, dt) {
      const c = ac.controls;
      for (const a of ailerons) {
        // Positive rotation about X moves a trailing edge down.
        if (a.flap) a.hinge.rotation.x = [0, 15, 30][ac.flaps] * Math.PI / 180;
        else a.hinge.rotation.x = -a.side * c.aileron * 0.35;
      }
      elevHinge.rotation.x = -Math.max(-1, Math.min(1, c.elevator + ac.trim)) * 0.4;
      rudHinge.rotation.y = c.rudder * 0.4;
      propAngle += (ac.rpm / 60) * Math.PI * 2 * dt;
      prop.rotation.z = propAngle;
      prop.visible = ac.rpm < 1100;
      disc.material.opacity = Math.min(0.35, Math.max(0, (ac.rpm - 900) / 1200));
      for (const w of wheels) w.rotation.x -= (ac.onGround ? ac.speed / 0.3 : 0) * dt;
    },
  };
}
