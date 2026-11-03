// Procedural island: heightfield terrain, sea, airfields, trees and buildings.
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

const noise = createNoise(7);

// ---------- Airfields ----------
// heading: compass direction of the runway (radians). Runway numbers are for both ends.
function makeField(def) {
  const h = def.heading;
  return {
    ...def,
    dir: new THREE.Vector3(Math.sin(h), 0, -Math.cos(h)),
    right: new THREE.Vector3(Math.cos(h), 0, Math.sin(h)),
  };
}

export const AIRFIELDS = [
  makeField({ id: 'main', name: 'Skyhaven', x: 0, z: 0, heading: 0, length: 2400, width: 45,
    elevation: 25, numbers: ['36', '18'], papiDist: 330, margin: 130, approachLights: true }),
  makeField({ id: 'east', name: 'Eastfield', x: 4750, z: 4250, heading: 100 * Math.PI / 180, length: 850, width: 20,
    elevation: 116, numbers: ['10', '28'], papiDist: 180, margin: 70, approachLights: false }),
];
export const RUNWAY = AIRFIELDS[0];

// Field-local coordinates: along the runway (towards its heading) and across (to the right).
export function fieldLocal(f, x, z) {
  const dx = x - f.x, dz = z - f.z;
  return { along: dx * f.dir.x + dz * f.dir.z, across: dx * f.right.x + dz * f.right.z };
}
export function fieldToWorld(f, along, across, y = f.elevation, out = new THREE.Vector3()) {
  return out.set(f.x + f.dir.x * along + f.right.x * across, y, f.z + f.dir.z * along + f.right.z * across);
}

function naturalHeight(x, z) {
  // Island mask: land in the middle, ocean around the edges.
  const r = Math.hypot(x, z * 0.85) / 9500 + 0.12 * noise.fbm(x * 0.00035 + 3.1, z * 0.00035 - 7.7, 3);
  const island = 1 - smoothstep(0.62, 1.0, r);

  // A valley runs north-south through the main runway so approaches are clear.
  const valley = 1 - (1 - smoothstep(350, 1700, Math.abs(x))) * (1 - smoothstep(7500, 9000, Math.abs(z)));

  const rolling = noise.fbm(x * 0.0004, z * 0.0004, 5);           // -1..1
  const detail = noise.fbm(x * 0.004, z * 0.004, 3);              // small bumps
  const ridge = noise.ridged(x * 0.00028 + 11.0, z * 0.00028 - 4.0, 6);
  const mtnZone = smoothstep(0.05, 0.45, noise.fbm(x * 0.00012 - 2.0, z * 0.00012 + 5.0, 3) + 0.25);

  let land = 25 + 8 * rolling + 2 * detail;
  land += valley * (60 + 110 * rolling + 8 * detail);
  land += valley * mtnZone * Math.pow(ridge, 1.6) * 1500;
  return lerp(-45, land, island);
}

function rawHeight(x, z) {
  let h = naturalHeight(x, z);
  for (const f of AIRFIELDS) {
    const { along, across } = fieldLocal(f, x, z);
    const da = Math.max(0, Math.abs(along) - f.length / 2 - 120);
    const dc = Math.max(0, Math.abs(across) - f.margin);
    const t = smoothstep(0, 450, Math.hypot(da, dc));
    h = lerp(f.elevation, h, t);
  }
  // Deepen the open sea (the coastline is unchanged) so the sea floor never shows through the
  // water surface at long range, where depth-buffer precision runs out.
  if (h < -8) h = -8 + (h + 8) * 4;
  return h;
}

const heights = new Float32Array(VERTS * VERTS);
for (let i = 0; i < VERTS; i++) {
  for (let j = 0; j < VERTS; j++) heights[i * VERTS + j] = rawHeight(-HALF + j * CELL, -HALF + i * CELL);
}

// Height of the terrain surface (may be below sea level).
export function terrainHeight(x, z) {
  const gx = (x + HALF) / CELL;
  const gz = (z + HALF) / CELL;
  if (gx < 0 || gz < 0 || gx >= CELLS || gz >= CELLS) return -156;
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

export function runwayAt(x, z) {
  for (const f of AIRFIELDS) {
    const { along, across } = fieldLocal(f, x, z);
    if (Math.abs(along) <= f.length / 2 && Math.abs(across) <= f.width / 2 + 1) return f;
  }
  return null;
}
export const isOnRunway = (x, z) => runwayAt(x, z) !== null;

// ---------- Obstacles (trees and buildings) ----------
const TREE_CELL = 50;
const treeGrid = new Map();
const buildings = []; // { cx, cz, cy, hx, hy, hz, cos, sin }
const _key = (ix, iz) => ix * 100000 + iz;

function addTreeObstacle(x, y, z, radius, height) {
  const k = _key(Math.floor(x / TREE_CELL), Math.floor(z / TREE_CELL));
  let list = treeGrid.get(k);
  if (!list) treeGrid.set(k, (list = []));
  list.push({ x, y, z, radius, height });
}

const boxGrid = new Map(); // houses: { cx, cz, cy, hx, hy, hz, cos, sin }
function addBoxObstacle(b) {
  const k = _key(Math.floor(b.cx / TREE_CELL), Math.floor(b.cz / TREE_CELL));
  let list = boxGrid.get(k);
  if (!list) boxGrid.set(k, (list = []));
  list.push(b);
}
const insideBox = (p, b) => {
  const dx = p.x - b.cx, dz = p.z - b.cz;
  const lx = dx * b.cos - dz * b.sin, lz = dx * b.sin + dz * b.cos;
  return Math.abs(lx) < b.hx && Math.abs(lz) < b.hz && Math.abs(p.y - b.cy) < b.hy;
};

// Returns a description if the world point is inside a tree or a building.
export function obstacleAt(p) {
  const ix = Math.floor(p.x / TREE_CELL), iz = Math.floor(p.z / TREE_CELL);
  for (let a = -1; a <= 1; a++) {
    for (let b = -1; b <= 1; b++) {
      const list = treeGrid.get(_key(ix + a, iz + b));
      if (!list) continue;
      for (const t of list) {
        const up = p.y - t.y;
        if (up < 0 || up > t.height) continue;
        const r = up < t.height * 0.3 ? 0.5 : t.radius * (1 - (up - t.height * 0.3) / (t.height * 0.7));
        if ((p.x - t.x) ** 2 + (p.z - t.z) ** 2 < r * r) return 'Hit a tree';
      }
      const boxes = boxGrid.get(_key(ix + a, iz + b));
      if (boxes) for (const h of boxes) if (insideBox(p, h)) return 'Hit a house';
    }
  }
  for (const b of buildings) if (insideBox(p, b)) return 'Hit a building';
  return null;
}

// ---------- Textures ----------
// Tileable value noise, a different frequency in each channel.
function periodicNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  // [base period, octaves] for each colour channel.
  const layers = [[16, 3], [8, 4], [4, 4]];
  const lattice = (p) => {
    const arr = new Float32Array(p * p);
    for (let i = 0; i < arr.length; i++) arr[i] = Math.random();
    return arr;
  };
  const sample = (lat, p, x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    const at = (a, b) => lat[(b % p) * p + (a % p)];
    const top = lerp(at(xi, yi), at(xi + 1, yi), u);
    const bot = lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u);
    return lerp(top, bot, w);
  };
  for (let c = 0; c < 3; c++) {
    const [p0, oct] = layers[c];
    const lats = Array.from({ length: oct }, (_, o) => lattice(p0 << o));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let v = 0, amp = 0.5, norm = 0;
        for (let o = 0; o < oct; o++) {
          const p = p0 << o; // each octave has an integer period, so the texture tiles
          v += amp * sample(lats[o], p, (x / size) * p, (y / size) * p);
          norm += amp; amp *= 0.5;
        }
        data[(y * size + x) * 4 + c] = Math.round((v / norm) * 255);
        data[(y * size + x) * 4 + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const detailTex = periodicNoiseTexture();

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
  const sand = C('#d2c08e'), wetSand = C('#8f8160'), grass = C('#5d8a38'), grass2 = C('#86a24a'),
    forest = C('#38572a'), dirt = C('#7a6a4c'), rock = C('#80796f'), rock2 = C('#5c5852'), snow = C('#f2f4f7'),
    field = C('#b0a75c'), field2 = C('#6f9b3c');
  const nrm = geo.attributes.normal.array;
  const col = new Float32Array(pos.length);
  const c = new THREE.Color();
  for (let v = 0; v < VERTS * VERTS; v++) {
    const x = pos[v * 3], h = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const up = nrm[v * 3 + 1];
    const n1 = noise.fbm(x * 0.002, z * 0.002, 3);
    const n2 = noise.fbm(x * 0.0007 + 40, z * 0.0007, 3);
    const n3 = noise.value(x * 0.0035 + 9, z * 0.0035);
    if (h < -1) c.copy(wetSand);
    else if (h < 5 + n1 * 3) c.copy(sand);
    else {
      c.copy(grass).lerp(grass2, clamp(0.5 + n1, 0, 1));
      if (n2 > 0.12 && h < 700) c.lerp(forest, smoothstep(0.12, 0.3, n2));
      // Patchwork of farm fields in the lowlands.
      if (n2 < -0.15 && h < 220 && up > 0.97) c.lerp(n3 > 0 ? field : field2, smoothstep(-0.15, -0.3, n2) * 0.75);
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
  // Break up the flat vertex colours with multi-scale detail noise.
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detailTex };
    sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform sampler2D detailMap;\nvarying vec3 vWPos;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float camDist = length(vWPos - cameraPosition);
      vec3 d1 = texture2D(detailMap, vWPos.xz / 11.0).rgb;
      vec3 d2 = texture2D(detailMap, vWPos.xz / 97.0).rgb;
      vec3 d3 = texture2D(detailMap, vWPos.xz / 820.0).rgb;
      float nearK = 1.0 - smoothstep(120.0, 1100.0, camDist);
      float midK = 1.0 - smoothstep(2000.0, 9000.0, camDist);
      float k = 1.0 + (d1.r - 0.5) * 0.5 * nearK + (d2.g - 0.5) * 0.45 * midK + (d3.b - 0.5) * 0.35;
      diffuseColor.rgb *= k;`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function buildSea(env) {
  // Water depth texture for shallow-water colour and shoreline foam.
  const S = VERTS;
  const depth = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) depth[i] = clamp(Math.round(-heights[i] * 10), 0, 255);
  const depthTex = new THREE.DataTexture(depth, S, S, THREE.RedFormat, THREE.UnsignedByteType);
  depthTex.magFilter = depthTex.minFilter = THREE.LinearFilter;
  depthTex.needsUpdate = true;

  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    time: { value: 0 }, depthMap: { value: null }, waveMap: { value: null },
    sunDir: { value: null }, sunColor: { value: null }, horizon: { value: null }, zenith: { value: null },
    deep: { value: new THREE.Color('#0f3b57') }, shallow: { value: new THREE.Color('#2f8f9a') },
  }]);
  uniforms.depthMap.value = depthTex;
  uniforms.waveMap.value = detailTex;
  uniforms.sunDir.value = env.sunDir;
  uniforms.sunColor.value = env.sunColor;
  uniforms.horizon.value = env.horizon;
  uniforms.zenith.value = env.zenith;

  const mat = new THREE.ShaderMaterial({
    uniforms, fog: true,
    vertexShader: /* glsl */`
      varying vec3 vW;
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform float time;
      uniform sampler2D depthMap, waveMap;
      uniform vec3 sunDir, sunColor, horizon, zenith, deep, shallow;
      varying vec3 vW;
      #include <fog_pars_fragment>
      void main() {
        float dist = length(cameraPosition - vW);
        vec3 n1 = texture2D(waveMap, vW.xz / 61.0 + vec2(time * 0.011, time * 0.006)).rgb - 0.5;
        vec3 n2 = texture2D(waveMap, vW.xz / 17.0 - vec2(time * 0.017, -time * 0.009)).rgb - 0.5;
        vec3 n3 = texture2D(waveMap, vW.xz / 400.0 + vec2(time * 0.002)).rgb - 0.5;
        float amp = mix(0.9, 0.12, smoothstep(150.0, 7000.0, dist));
        vec3 N = normalize(vec3((n1.r + n2.g * 0.6 + n3.b) * amp, 1.0, (n1.g + n2.r * 0.6 + n3.r) * amp));
        vec3 V = normalize(cameraPosition - vW);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 sky = mix(horizon, zenith, pow(R.y, 0.55));
        float depth = texture2D(depthMap, (vW.xz + ${HALF.toFixed(1)}) / ${WORLD_SIZE.toFixed(1)}).r * 25.5;
        if (abs(vW.x) > ${HALF.toFixed(1)} || abs(vW.z) > ${HALF.toFixed(1)}) depth = 25.5;
        // Over land the terrain covers the sea anyway; skipping it there avoids depth fighting at range.
        else if (depth < 0.03) discard;
        vec3 water = mix(shallow, deep, smoothstep(0.0, 14.0, depth));
        float light = 0.3 + 0.7 * max(sunDir.y, 0.0);
        vec3 col = mix(water * light * (sunColor * 0.4 + 0.6), sky, fres * 0.8);
        float spec = pow(max(dot(R, sunDir), 0.0), 250.0) * 2.5 + pow(max(dot(R, sunDir), 0.0), 30.0) * 0.12;
        col += sunColor * spec;
        float foam = (1.0 - smoothstep(0.0, 1.8, depth)) * (0.55 + 0.45 * sin(time * 1.3 - depth * 3.0 + n1.r * 8.0));
        col = mix(col, vec3(0.93) * light, clamp(foam, 0.0, 1.0) * 0.75);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const geo = new THREE.PlaneGeometry(400000, 400000);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = SEA_LEVEL;
  return { mesh, update(t) { uniforms.time.value = t; } };
}

function runwayTexture(renderer, f) {
  const W = 256, H = Math.min(4096, Math.round(f.length * 2.9 / 256) * 256);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  // Work in metres: x across (0..width), y along (0 = far end .. length = near end).
  g.scale(W / f.width, H / f.length);
  const L = f.length, Wd = f.width;
  g.fillStyle = '#3d3f42';
  g.fillRect(0, 0, Wd, L);
  for (let i = 0; i < L * 4; i++) {
    const v = 48 + Math.random() * 28;
    g.fillStyle = `rgba(${v},${v},${v + 3},0.35)`;
    g.fillRect(Math.random() * Wd, Math.random() * L, 0.4, 0.4);
  }
  // Patches of repaired asphalt.
  for (let i = 0; i < L / 60; i++) {
    const v = 55 + Math.random() * 20;
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(Math.random() * Wd * 0.7, Math.random() * L, 2 + Math.random() * 6, 5 + Math.random() * 20);
  }
  g.fillStyle = 'rgba(20,20,20,0.35)';
  for (let i = 0; i < 40; i++) {
    const y = 100 + Math.random() * L * 0.18;
    g.fillRect(Wd / 2 - 3 + Math.random() * 1.5, L - y, 0.5, 15 + Math.random() * 30);
    g.fillRect(Wd / 2 + 1.5 + Math.random() * 1.5, y, 0.5, 15 + Math.random() * 30);
  }
  g.fillStyle = '#e8e8e2';
  g.fillRect(0.6, 0, 0.6, L);
  g.fillRect(Wd - 1.2, 0, 0.6, L);
  const keys = Wd >= 30 ? 8 : 6;
  const kw = (Wd - 4) / keys;
  for (let k = 0; k < keys; k++) {
    const x = 2 + k * kw + kw * 0.2 + (k >= keys / 2 ? 0.4 : -0.4);
    g.fillRect(x, 6, kw * 0.55, 30);
    g.fillRect(x, L - 36, kw * 0.55, 30);
  }
  for (let y = 75; y < L - 75; y += 50) g.fillRect(Wd / 2 - 0.45, y, 0.9, 30);
  const aim = f.papiDist;
  for (const y of [aim - 22, L - aim - 22]) {
    g.fillRect(Wd / 2 - Wd * 0.3, y, Wd * 0.13, 45);
    g.fillRect(Wd / 2 + Wd * 0.17, y, Wd * 0.13, 45);
  }
  g.font = `bold ${Math.min(12, Wd * 0.4)}px sans-serif`;
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
  number(f.numbers[0], L - 60, false);
  number(f.numbers[1], 60, true);

  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const glowTex = (() => {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

// Point lights drawn as glowing sprites that stay visible from far away.
function makeLight(color, size = 1.5) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  s.userData.size = size;
  return s;
}

function buildAirfield(renderer, f, lights, papis, windsocks, nightLights) {
  const group = new THREE.Group();
  group.position.set(f.x, 0, f.z);
  group.rotation.y = -f.heading;
  const E = f.elevation;
  // In the group's local frame, the runway heading points to -Z and +X is to its right.

  const geo = new THREE.PlaneGeometry(f.width, f.length).rotateX(-Math.PI / 2);
  const rw = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    map: runwayTexture(renderer, f), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  rw.position.y = E + 0.02;
  rw.receiveShadow = true;
  group.add(rw);

  const asphalt = new THREE.MeshLambertMaterial({
    color: 0x4a4c4f, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const flat = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), asphalt);
    m.position.set(x, E + 0.01, z);
    m.receiveShadow = true;
    group.add(m);
  };
  const apronX = f.width / 2 + (f.id === 'main' ? 85 : 55);
  const apronZ = f.id === 'main' ? 150 : 0;
  flat(apronX - f.width / 2 - 25, 15, (f.width / 2 + apronX - 30) / 2, apronZ);
  flat(60, f.id === 'main' ? 140 : 70, apronX, apronZ);

  // Edge lights every 60 m.
  const lightGeo = new THREE.BoxGeometry(0.3, 0.4, 0.3);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
  const count = Math.floor(f.length / 60) + 1;
  const edge = new THREE.InstancedMesh(lightGeo, lightMat, count * 2);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let k = 0; k < count; k++) {
    const z = -f.length / 2 + k * 60;
    for (const s of [-1, 1]) {
      m.makeTranslation(s * (f.width / 2 + 2), E + 0.2, z);
      edge.setMatrixAt(n++, m);
      const wp = fieldToWorld(f, -z, s * (f.width / 2 + 2), E + 0.5);
      // Threshold ends show green/red, the rest white.
      const endLight = k === 0 || k === count - 1;
      nightLights.push([wp.x, wp.y, wp.z, endLight ? 0.3 : 1, endLight ? 1 : 0.95, endLight ? 0.4 : 0.8]);
    }
  }
  group.add(edge);

  // Approach lights (rows of white lights before each threshold).
  if (f.approachLights) {
    for (const end of [1, -1]) {
      for (let r = 1; r <= 10; r++) {
        for (let c = -2; c <= 2; c++) {
          const l = makeLight(0xfff6e0, r % 5 === 0 ? 1.6 : 1.1);
          const zz = end * (f.length / 2 + r * 30);
          const xx = c * (r % 5 === 0 ? 4 : 1.2);
          l.position.set(xx, terrainHeightLocal(f, zz, xx) + 0.6, zz);
          group.add(l);
          lights.push(l);
        }
      }
    }
  }

  // PAPI: four lights left of each touchdown zone, red/white by glide-path angle.
  for (const end of [1, -1]) {
    const units = [];
    for (let k = 0; k < 4; k++) {
      const l = makeLight(0xffffff, 1.4);
      const zz = end * (f.length / 2 - f.papiDist);
      // Left of the runway as seen by the landing pilot; k = 0 is the outermost unit.
      const xx = -end * (f.width / 2 + 15 + (3 - k) * 9);
      l.position.set(xx, E + 0.8, zz);
      group.add(l);
      units.push(l);
      lights.push(l);
    }
    papis.push({ units, threshold: [2.5, 2.83, 3.17, 3.5] });
  }

  // Buildings.
  const wall = new THREE.MeshLambertMaterial({ color: 0xd8d4c8 });
  const roofMat = new THREE.MeshLambertMaterial({ color: f.id === 'main' ? 0x8a3b2e : 0x2e5a8a });
  const glass = new THREE.MeshLambertMaterial({ color: 0x334455 });
  const wp = new THREE.Vector3();
  const addBox = (w, h, d, x, y, z, mat, solid = true) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    b.position.set(x, y, z);
    b.castShadow = b.receiveShadow = true;
    group.add(b);
    if (solid) {
      // Local (x, z) -> world, using the runway frame (local -Z = heading).
      fieldToWorld(f, -z, x, y, wp);
      buildings.push({ cx: wp.x, cz: wp.z, cy: y, hx: w / 2 + 0.5, hy: h / 2 + 0.5, hz: d / 2 + 0.5,
        cos: Math.cos(-f.heading), sin: Math.sin(-f.heading) });
    }
    return b;
  };
  const hangars = f.id === 'main' ? [[100, 26], [140, 26], [185, 34]] : [[-5, 24]];
  const ax = apronX + 40;
  for (const [z, w] of hangars) {
    addBox(20, 8, w, ax, E + 4, z, wall);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(10.5, 10.5, w + 0.5, 16, 1, false, 0, Math.PI), roofMat);
    // Half-cylinder: bulge (local +X) points up, axis (local Y) runs along the hangar.
    r.rotation.set(0, Math.PI / 2, Math.PI / 2);
    r.scale.set(0.35, 1, 1);
    r.position.set(ax, E + 8, z);
    r.castShadow = true;
    group.add(r);
    // Hangar doors (dark panel on the apron side).
    addBox(0.2, 6.5, w - 4, ax - 10.05, E + 3.3, z, glass, false);
  }
  if (f.id === 'main') {
    addBox(6, 16, 6, ax - 10, E + 8, 240, wall);
    addBox(8, 4, 8, ax - 10, E + 18, 240, glass);
    addBox(9, 0.6, 9, ax - 10, E + 20.3, 240, roofMat);
    // A fuel truck and a couple of parked aircraft shapes for scale.
    addBox(2.4, 2.6, 7, apronX - 15, E + 1.3, 200, new THREE.MeshLambertMaterial({ color: 0xc23a2a }));
  } else {
    addBox(8, 4, 6, ax - 2, E + 2, 30, wall);
  }

  // Windsock.
  const sockX = -(f.width / 2 + 25), sockZ = -f.length / 2 + 250;
  addBox(0.2, 6, 0.2, sockX, E + 3, sockZ, wall, false);
  const sock = new THREE.Group();
  sock.position.set(sockX, E + 5.8, sockZ);
  const sockMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.25, 3, 10, 4, true).rotateZ(Math.PI / 2).translate(1.5, 0, 0),
    new THREE.MeshLambertMaterial({ color: 0xff6a1a, side: THREE.DoubleSide }),
  );
  sock.add(sockMesh);
  group.add(sock);
  windsocks.push({ sock, heading: f.heading });

  return group;
}

function terrainHeightLocal(f, alongNeg, across) {
  // alongNeg is local Z (positive = behind the runway heading).
  const p = fieldToWorld(f, -alongNeg, across);
  return Math.max(terrainHeight(p.x, p.z), 0);
}

// ---------- Villages ----------
export const VILLAGES = [
  { name: 'Millbrook', x: -3000, z: 3200, r: 380, n: 70 },
  { name: 'Southport', x: -700, z: 6900, r: 320, n: 55 },
  { name: 'Eastbrook', x: 3100, z: 250, r: 300, n: 45 },
  { name: 'Northcove', x: 250, z: -7900, r: 260, n: 40 },
  { name: 'Westridge', x: -4500, z: -3700, r: 300, n: 45 },
];

// Unit triangular prism: ridge along X at the top, base 1 x 1, height 1.
function prismGeometry() {
  const A = [-0.5, 0, -0.5], B = [-0.5, 0, 0.5], C = [-0.5, 1, 0], D = [0.5, 0, -0.5], E = [0.5, 0, 0.5], F = [0.5, 1, 0];
  const tris = [A, B, C, D, F, E, A, C, F, A, F, D, B, E, F, B, F, C];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  geo.computeVertexNormals();
  return geo;
}

function nearAirfield(x, z, pad = 0) {
  for (const f of AIRFIELDS) {
    const { along, across } = fieldLocal(f, x, z);
    if (Math.abs(across) < f.margin + 150 + pad && Math.abs(along) < f.length / 2 + 600 + pad) return true;
    if (Math.abs(across) < 250 + pad && Math.abs(along) < f.length / 2 + 2500) return true;
  }
  return false;
}

function buildVillages(nightLights) {
  let s = 777;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const houses = [];
  for (const v of VILLAGES) {
    for (let tries = 0; tries < v.n * 30 && houses.filter((h) => h.v === v).length < v.n; tries++) {
      // Denser towards the middle.
      const a = rnd() * Math.PI * 2, d = v.r * Math.sqrt(rnd()) * (0.4 + 0.6 * rnd());
      const x = v.x + Math.cos(a) * d, z = v.z + Math.sin(a) * d;
      if (nearAirfield(x, z, 30)) continue;
      const w = 7 + rnd() * 5, dpt = 8 + rnd() * 5;
      const rot = (Math.round(rnd() * 4) * Math.PI) / 2 + (rnd() - 0.5) * 0.3;
      const hs = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => terrainHeight(x + sx * w / 2, z + sz * dpt / 2)));
      const lo = Math.min(...hs), hi = Math.max(...hs);
      if (lo < 3 || hi - lo > 2.5) continue;
      if (houses.some((h) => (h.x - x) ** 2 + (h.z - z) ** 2 < 15 * 15)) continue;
      houses.push({ v, x, z, w, d: dpt, rot, lo, hi, wallH: 3.5 + rnd() * 2.5 * (rnd() < 0.2 ? 2 : 1) });
    }
  }
  const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), houses.length);
  const roofs = new THREE.InstancedMesh(prismGeometry(), new THREE.MeshLambertMaterial({ color: 0xffffff }), houses.length);
  walls.castShadow = roofs.castShadow = true;
  walls.receiveShadow = roofs.receiveShadow = true;
  const wallCols = ['#efe9dc', '#e8dcc0', '#f3efe6', '#d9cdb4', '#e6d2a8', '#cfd8dc'].map((c) => new THREE.Color(c));
  const roofCols = ['#9a3b2a', '#7d3424', '#5b4a3e', '#4b4f56', '#a24a2c'].map((c) => new THREE.Color(c));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  houses.forEach((h, i) => {
    // Ridge runs along the longer side.
    const long = Math.max(h.w, h.d), short = Math.min(h.w, h.d);
    q.setFromAxisAngle(up, h.rot);
    const base = h.lo - 1.2, top = h.hi + h.wallH;
    p.set(h.x, (base + top) / 2, h.z);
    sc.set(long, top - base, short);
    m.compose(p, q, sc);
    walls.setMatrixAt(i, m);
    walls.setColorAt(i, wallCols[i % wallCols.length]);
    p.set(h.x, top, h.z);
    sc.set(long + 0.8, 2.2 + short * 0.15, short + 0.8);
    m.compose(p, q, sc);
    roofs.setMatrixAt(i, m);
    roofs.setColorAt(i, roofCols[(i * 7) % roofCols.length]);
    addBoxObstacle({ cx: h.x, cz: h.z, cy: (base + top + 3) / 2, hx: long / 2 + 0.6, hy: (top + 3 - base) / 2, hz: short / 2 + 0.6,
      cos: Math.cos(h.rot), sin: Math.sin(h.rot) });
    // Lit windows at night.
    if (i % 3 !== 2) {
      const side = rnd() < 0.5 ? -1 : 1, off = (short / 2 + 0.4) * side, along = (rnd() - 0.5) * long * 0.6;
      nightLights.push([h.x + Math.sin(h.rot) * off + Math.cos(h.rot) * along, h.lo + 2.2,
        h.z + Math.cos(h.rot) * off - Math.sin(h.rot) * along, 1.0, 0.78, 0.45]);
    }
  });
  // Street lights scattered through each village.
  for (const v of VILLAGES) {
    for (let k = 0; k < v.n / 3; k++) {
      const a = rnd() * Math.PI * 2, d = v.r * 0.8 * Math.sqrt(rnd());
      const x = v.x + Math.cos(a) * d, z = v.z + Math.sin(a) * d;
      const h = terrainHeight(x, z);
      if (h > 2) nightLights.push([x, h + 6, z, 1.0, 0.62, 0.3]);
    }
  }
  const g = new THREE.Group();
  g.add(walls, roofs);
  return g;
}

function buildTrees(maxTrees) {
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 5).translate(0, 1.5, 0);
  const crownGeo = new THREE.ConeGeometry(2.6, 8, 7).translate(0, 6.5, 0);
  const broadGeo = new THREE.IcosahedronGeometry(3.2, 0).scale(1, 0.9, 1).translate(0, 5.2, 0);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), maxTrees);
  const broads = new THREE.InstancedMesh(broadGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), maxTrees);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5a4030 }), maxTrees * 2);
  crowns.castShadow = broads.castShadow = true;

  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const col = new THREE.Color();
  const cA = new THREE.Color('#2f5a24'), cB = new THREE.Color('#4a6f2c');
  const bA = new THREE.Color('#4f7a2a'), bB = new THREE.Color('#7a8f35');
  let nc = 0, nb = 0, nt = 0;
  for (let tries = 0; tries < maxTrees * 25 && nc + nb < maxTrees; tries++) {
    const x = (rnd() - 0.5) * 18000, z = (rnd() - 0.5) * 20000;
    let nearField = false;
    for (const f of AIRFIELDS) {
      const { along, across } = fieldLocal(f, x, z);
      if (Math.abs(across) < f.margin + 150 && Math.abs(along) < f.length / 2 + 600) nearField = true;
      // Keep the approach paths clear.
      if (Math.abs(across) < 250 && Math.abs(along) < f.length / 2 + 2500) nearField = true;
    }
    if (nearField) continue;
    if (VILLAGES.some((v) => (x - v.x) ** 2 + (z - v.z) ** 2 < (v.r * 0.95) ** 2)) continue;
    const h = terrainHeight(x, z);
    if (h < 8 || h > 800) continue;
    const forest = noise.fbm(x * 0.0007 + 40, z * 0.0007, 3);
    if (forest < 0.05 && rnd() > 0.04) continue;
    const slope = Math.abs(terrainHeight(x + 5, z) - h) + Math.abs(terrainHeight(x, z + 5) - h);
    if (slope > 3.5) continue;
    const size = 0.8 + rnd() * 0.9;
    const tall = 0.8 + rnd() * 0.5;
    p.set(x, h - 0.3, z);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * 6.28);
    sc.set(size, size * tall, size);
    m.compose(p, q, sc);
    const conifer = h > 300 || rnd() < 0.6;
    if (conifer) {
      if (nc >= maxTrees) continue;
      crowns.setMatrixAt(nc, m);
      crowns.setColorAt(nc++, col.copy(cA).lerp(cB, rnd()));
      addTreeObstacle(x, h, z, 2.6 * size, 10.5 * size * tall);
    } else {
      if (nb >= maxTrees) continue;
      broads.setMatrixAt(nb, m);
      broads.setColorAt(nb++, col.copy(bA).lerp(bB, rnd()));
      addTreeObstacle(x, h, z, 3.2 * size, 8.2 * size * tall);
    }
    trunks.setMatrixAt(nt++, m);
  }
  crowns.count = nc; broads.count = nb; trunks.count = nt;
  const g = new THREE.Group();
  g.add(crowns, broads, trunks);
  return g;
}

export function buildWorld(scene, renderer, env, quality = 'high') {
  scene.add(buildTerrainMesh());
  const sea = buildSea(env);
  scene.add(sea.mesh);
  const lights = [], papis = [], windsocks = [], nightLights = [];
  for (const f of AIRFIELDS) scene.add(buildAirfield(renderer, f, lights, papis, windsocks, nightLights));
  scene.add(buildVillages(nightLights));
  scene.add(buildTrees(quality === 'low' ? 3500 : 10000));

  // Night lights as fixed-pixel-size points so they stay visible from far away.
  const lp = new Float32Array(nightLights.length * 3), lc = new Float32Array(nightLights.length * 3);
  nightLights.forEach((l, i) => { lp.set(l.slice(0, 3), i * 3); lc.set(l.slice(3), i * 3); });
  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.BufferAttribute(lp, 3));
  lgeo.setAttribute('color', new THREE.BufferAttribute(lc, 3));
  const nightPoints = new THREE.Points(lgeo, new THREE.PointsMaterial({
    size: 5, sizeAttenuation: false, map: glowTex, vertexColors: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  nightPoints.visible = false;
  scene.add(nightPoints);

  const _v = new THREE.Vector3();
  return {
    update(t, camera, wind) {
      sea.update(t);
      nightPoints.visible = env.night;
      // Keep point lights a visible size at any distance.
      for (const l of lights) {
        l.getWorldPosition(_v);
        const d = _v.distanceTo(camera.position);
        const k = Math.max(l.userData.size, d * 0.0045);
        l.scale.set(k, k, 1);
      }
      for (const p of papis) {
        for (let k = 0; k < 4; k++) {
          const u = p.units[k];
          u.getWorldPosition(_v);
          const horiz = Math.hypot(camera.position.x - _v.x, camera.position.z - _v.z);
          const ang = Math.atan2(camera.position.y - _v.y, horiz) * 180 / Math.PI;
          u.material.color.setHex(ang > p.threshold[k] ? 0xffffff : 0xff2a1a);
        }
      }
      // Windsocks point downwind and fill out as the wind picks up.
      if (wind) {
        const spd = Math.hypot(wind.x, wind.z);
        for (const w of windsocks) {
          const worldAng = Math.atan2(-wind.z, wind.x);
          w.sock.rotation.y = worldAng + w.heading;
          w.sock.rotation.z = -(1 - clamp(spd / 7.7, 0, 1)) * 1.25 + Math.sin(t * 3) * 0.04;
        }
      }
    },
  };
}
