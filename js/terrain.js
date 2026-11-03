// Procedural island: heightfield terrain, sea, runway, trees and a few buildings.
// Heights are stored on a regular grid and queried with the same triangulation
// the mesh uses, so what you see is exactly what you collide with.

import * as THREE from 'three';
import { createNoise, smoothstep, lerp, clamp } from './noise.js';

export const WORLD_SIZE = 24000;          // metres, square
const CELLS = 384;                        // grid cells per side (62.5 m)
const CELL = WORLD_SIZE / CELLS;
const HALF = WORLD_SIZE / 2;
const VERTS = CELLS + 1;

export const SEA_LEVEL = 0;
export const RUNWAY = {
  elevation: 25,
  length: 1400,
  width: 30,
  // Runway is centred on the origin and runs north (-Z) / south (+Z).
};

const noise = createNoise(7);

function rawHeight(x, z) {
  // Island mask: land in the middle, ocean around the edges.
  const r = Math.hypot(x, z * 0.85) / 9500 + 0.12 * noise.fbm(x * 0.00035 + 3.1, z * 0.00035 - 7.7, 3);
  const island = 1 - smoothstep(0.62, 1.0, r);

  // A valley runs north-south through the runway so approaches are clear.
  const valley = 1 - (1 - smoothstep(350, 1700, Math.abs(x))) * (1 - smoothstep(7500, 9000, Math.abs(z)));

  const rolling = noise.fbm(x * 0.0004, z * 0.0004, 5);           // -1..1
  const detail = noise.fbm(x * 0.004, z * 0.004, 3);              // small bumps
  const ridge = noise.ridged(x * 0.00028 + 11.0, z * 0.00028 - 4.0, 6);
  const mtnZone = smoothstep(0.05, 0.45, noise.fbm(x * 0.00012 - 2.0, z * 0.00012 + 5.0, 3) + 0.25);

  let land = RUNWAY.elevation + 8 * rolling + 2 * detail;
  land += valley * (60 + 110 * rolling + 8 * detail);
  land += valley * mtnZone * Math.pow(ridge, 1.6) * 1500;

  let h = lerp(-45, land, island);

  // Flatten the airfield.
  const dx = Math.max(0, Math.abs(x) - 110);
  const dz = Math.max(0, Math.abs(z) - RUNWAY.length / 2 - 120);
  const t = smoothstep(0, 450, Math.hypot(dx, dz));
  return lerp(RUNWAY.elevation, h, t);
}

const heights = new Float32Array(VERTS * VERTS);
for (let i = 0; i < VERTS; i++) {
  for (let j = 0; j < VERTS; j++) {
    heights[i * VERTS + j] = rawHeight(-HALF + j * CELL, -HALF + i * CELL);
  }
}

// Height of the terrain surface (may be below sea level).
export function terrainHeight(x, z) {
  const gx = (x + HALF) / CELL;
  const gz = (z + HALF) / CELL;
  if (gx < 0 || gz < 0 || gx >= CELLS || gz >= CELLS) return -45;
  const j = Math.floor(gx), i = Math.floor(gz);
  const fx = gx - j, fz = gz - i;
  const ha = heights[i * VERTS + j];
  const hb = heights[i * VERTS + j + 1];
  const hc = heights[(i + 1) * VERTS + j];
  const hd = heights[(i + 1) * VERTS + j + 1];
  if (fx + fz <= 1) return ha + (hb - ha) * fx + (hc - ha) * fz;
  return hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
}

// Surface the aircraft can touch: ground or water, whichever is higher.
export function surfaceInfo(x, z) {
  const h = terrainHeight(x, z);
  return h < SEA_LEVEL ? { height: SEA_LEVEL, water: true } : { height: h, water: false };
}

export function isOnRunway(x, z) {
  return Math.abs(x) <= RUNWAY.width / 2 + 1 && Math.abs(z) <= RUNWAY.length / 2;
}

function buildTerrainMesh() {
  const pos = new Float32Array(VERTS * VERTS * 3);
  for (let i = 0; i < VERTS; i++) {
    for (let j = 0; j < VERTS; j++) {
      const k = (i * VERTS + j) * 3;
      pos[k] = -HALF + j * CELL;
      pos[k + 1] = heights[i * VERTS + j];
      pos[k + 2] = -HALF + i * CELL;
    }
  }
  const index = new Uint32Array(CELLS * CELLS * 6);
  let n = 0;
  for (let i = 0; i < CELLS; i++) {
    for (let j = 0; j < CELLS; j++) {
      const a = i * VERTS + j, b = a + 1, c = a + VERTS, d = c + 1;
      index[n++] = a; index[n++] = c; index[n++] = b;
      index[n++] = b; index[n++] = c; index[n++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();

  const C = (hex) => new THREE.Color(hex);
  const sand = C('#cdbb8a'), wetSand = C('#8f8160'), grass = C('#5f8a3a'), grass2 = C('#7d9a45'),
    forest = C('#3b5a2a'), dirt = C('#7a6a4c'), rock = C('#7b766e'), rock2 = C('#5c5852'), snow = C('#f2f4f7'),
    field = C('#a3a05a');
  const nrm = geo.attributes.normal.array;
  const col = new Float32Array(pos.length);
  const c = new THREE.Color();
  for (let v = 0; v < VERTS * VERTS; v++) {
    const x = pos[v * 3], h = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const up = nrm[v * 3 + 1];
    const n1 = noise.fbm(x * 0.002, z * 0.002, 3);
    const n2 = noise.fbm(x * 0.0007 + 40, z * 0.0007, 3);
    if (h < -1) c.copy(wetSand);
    else if (h < 6) c.copy(sand);
    else {
      c.copy(grass).lerp(grass2, clamp(0.5 + n1, 0, 1));
      if (n2 > 0.12 && h < 700) c.lerp(forest, smoothstep(0.12, 0.3, n2));
      if (n2 < -0.3 && h < 200) c.lerp(field, 0.6);
      c.lerp(dirt, smoothstep(0.92, 0.82, up) * 0.6);
      const rockT = Math.max(smoothstep(0.82, 0.68, up), smoothstep(650, 950, h + n1 * 120));
      c.lerp(rock.clone().lerp(rock2, clamp(0.5 + n1, 0, 1)), rockT);
      const snowT = smoothstep(1050, 1250, h + n1 * 150) * smoothstep(0.55, 0.75, up);
      c.lerp(snow, snowT);
    }
    col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildSea() {
  const geo = new THREE.PlaneGeometry(400000, 400000);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshPhongMaterial({ color: 0x2a5d7a, specular: 0x88aacc, shininess: 60 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = SEA_LEVEL;
  mesh.receiveShadow = true;
  return mesh;
}

function runwayTexture(renderer) {
  const W = 256, H = 4096;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  // Work in metres: x across (0..width), y along (0 = north end .. length = south end).
  g.scale(W / RUNWAY.width, H / RUNWAY.length);
  const L = RUNWAY.length, Wd = RUNWAY.width;
  g.fillStyle = '#3d3f42';
  g.fillRect(0, 0, Wd, L);
  // Asphalt grain.
  for (let i = 0; i < 6000; i++) {
    const v = 50 + Math.random() * 25;
    g.fillStyle = `rgba(${v},${v},${v + 3},0.35)`;
    g.fillRect(Math.random() * Wd, Math.random() * L, 0.4, 0.4);
  }
  // Tyre marks near touchdown zones.
  g.fillStyle = 'rgba(20,20,20,0.35)';
  for (let i = 0; i < 40; i++) {
    const y = 120 + Math.random() * 250;
    g.fillRect(Wd / 2 - 3 + Math.random() * 1.5, L - y, 0.5, 15 + Math.random() * 30);
    g.fillRect(Wd / 2 + 1.5 + Math.random() * 1.5, y, 0.5, 15 + Math.random() * 30);
  }
  g.fillStyle = '#e8e8e2';
  // Edge lines.
  g.fillRect(0.6, 0, 0.6, L);
  g.fillRect(Wd - 1.2, 0, 0.6, L);
  // Threshold "piano keys" at both ends.
  for (let k = 0; k < 8; k++) {
    const x = 2.2 + k * 3.3 + (k >= 4 ? 0.6 : 0);
    g.fillRect(x, 6, 1.8, 30);
    g.fillRect(x, L - 36, 1.8, 30);
  }
  // Centreline dashes.
  for (let y = 75; y < L - 75; y += 50) g.fillRect(Wd / 2 - 0.45, y, 0.9, 30);
  // Aiming point blocks.
  for (const y of [300, L - 300 - 45]) {
    g.fillRect(Wd / 2 - 9, y, 4, 45);
    g.fillRect(Wd / 2 + 5, y, 4, 45);
  }
  // Runway numbers. "36" at the south end (read when heading north), "18" at the north end.
  g.font = 'bold 12px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const number = (txt, y, flip) => {
    g.save();
    g.translate(Wd / 2, y);
    if (flip) g.rotate(Math.PI);
    g.scale(1, 1.8);
    g.fillText(txt, 0, 0);
    g.restore();
  };
  number('36', L - 60, false);
  number('18', 60, true);

  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildRunway(renderer) {
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(RUNWAY.width, RUNWAY.length);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({
    map: runwayTexture(renderer), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const rw = new THREE.Mesh(geo, mat);
  rw.position.y = RUNWAY.elevation + 0.02;
  rw.receiveShadow = true;
  group.add(rw);

  // Taxiway and apron on the east side.
  const asphalt = new THREE.MeshLambertMaterial({
    color: 0x4a4c4f, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const taxi = new THREE.Mesh(new THREE.PlaneGeometry(55, 15).rotateX(-Math.PI / 2), asphalt);
  taxi.position.set(RUNWAY.width / 2 + 27, RUNWAY.elevation + 0.01, 150);
  taxi.receiveShadow = true;
  group.add(taxi);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(60, 140).rotateX(-Math.PI / 2), asphalt);
  apron.position.set(RUNWAY.width / 2 + 85, RUNWAY.elevation + 0.01, 150);
  apron.receiveShadow = true;
  group.add(apron);

  // Edge lights (small emissive posts) every 60 m.
  const lightGeo = new THREE.BoxGeometry(0.3, 0.4, 0.3);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
  const count = Math.floor(RUNWAY.length / 60) + 1;
  const lights = new THREE.InstancedMesh(lightGeo, lightMat, count * 2);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let k = 0; k < count; k++) {
    const z = -RUNWAY.length / 2 + k * 60;
    for (const s of [-1, 1]) {
      m.makeTranslation(s * (RUNWAY.width / 2 + 2), RUNWAY.elevation + 0.2, z);
      lights.setMatrixAt(n++, m);
    }
  }
  group.add(lights);

  // Buildings: hangars, a control tower and a windsock.
  const wall = new THREE.MeshLambertMaterial({ color: 0xd8d4c8 });
  const roof = new THREE.MeshLambertMaterial({ color: 0x8a3b2e });
  const glass = new THREE.MeshLambertMaterial({ color: 0x334455 });
  const addBox = (w, h, d, x, y, z, mat) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    b.position.set(x, y, z);
    b.castShadow = b.receiveShadow = true;
    group.add(b);
    return b;
  };
  const ax = RUNWAY.width / 2 + 125;
  for (const [z, w] of [[100, 26], [140, 26], [185, 34]]) {
    addBox(20, 8, w, ax, RUNWAY.elevation + 4, z, wall);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(10.5, 10.5, w + 0.5, 16, 1, false, 0, Math.PI), roof);
    // Half-cylinder: bulge (local +X) points up, axis (local Y) runs along the hangar.
    r.rotation.set(0, Math.PI / 2, Math.PI / 2);
    r.scale.set(0.35, 1, 1);
    r.position.set(ax, RUNWAY.elevation + 8, z);
    r.castShadow = true;
    group.add(r);
  }
  addBox(6, 16, 6, ax - 10, RUNWAY.elevation + 8, 240, wall);
  addBox(8, 4, 8, ax - 10, RUNWAY.elevation + 18, 240, glass);
  addBox(9, 0.6, 9, ax - 10, RUNWAY.elevation + 20.3, 240, roof);

  const pole = addBox(0.2, 6, 0.2, RUNWAY.width / 2 + 25, RUNWAY.elevation + 3, -300, wall);
  pole.castShadow = true;
  const sock = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.25, 3, 10, 1, true).rotateZ(Math.PI / 2).translate(1.5, 0, 0),
    new THREE.MeshLambertMaterial({ color: 0xff6a1a, side: THREE.DoubleSide }),
  );
  sock.position.set(RUNWAY.width / 2 + 25, RUNWAY.elevation + 5.8, -300);
  sock.rotation.y = 0.6;
  group.add(sock);

  return group;
}

function buildTrees() {
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 5).translate(0, 1.5, 0);
  const crownGeo = new THREE.ConeGeometry(2.6, 8, 7).translate(0, 6.5, 0);
  const maxTrees = 9000;
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), maxTrees);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5a4030 }), maxTrees);
  crowns.castShadow = true;

  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const col = new THREE.Color();
  const cA = new THREE.Color('#2f5a24'), cB = new THREE.Color('#4a6f2c');
  let n = 0;
  for (let tries = 0; tries < 200000 && n < maxTrees; tries++) {
    const x = (rnd() - 0.5) * 18000, z = (rnd() - 0.5) * 20000;
    if (Math.abs(x) < 260 && Math.abs(z) < RUNWAY.length / 2 + 600) continue;
    const h = terrainHeight(x, z);
    if (h < 8 || h > 750) continue;
    const forest = noise.fbm(x * 0.0007 + 40, z * 0.0007, 3);
    if (forest < 0.05 && rnd() > 0.04) continue;
    const slope = Math.abs(terrainHeight(x + 5, z) - h) + Math.abs(terrainHeight(x, z + 5) - h);
    if (slope > 3.5) continue;
    const size = 0.8 + rnd() * 0.9;
    p.set(x, h - 0.3, z);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * 6.28);
    sc.set(size, size * (0.8 + rnd() * 0.5), size);
    m.compose(p, q, sc);
    crowns.setMatrixAt(n, m);
    trunks.setMatrixAt(n, m);
    crowns.setColorAt(n, col.copy(cA).lerp(cB, rnd()));
    n++;
  }
  crowns.count = trunks.count = n;
  const g = new THREE.Group();
  g.add(crowns, trunks);
  return g;
}

export function buildWorld(scene, renderer) {
  scene.add(buildTerrainMesh());
  scene.add(buildSea());
  scene.add(buildRunway(renderer));
  scene.add(buildTrees());
}
