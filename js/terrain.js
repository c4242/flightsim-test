// Procedural island: heightfield terrain, sea, airfields, trees and buildings.
// Heights are stored on a regular grid and queried with the same triangulation
// the mesh uses, so what you see is exactly what you collide with.

import * as THREE from 'three';
import { createNoise, smoothstep, lerp, clamp } from './noise.js';
import { createDetailPatch } from './terrain-detail.js';

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

// Coarse terrain: the 62.5 m grid with the same triangulation as the coarse mesh.
export function coarseHeight(x, z) {
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

// ---------- Fine terrain detail ----------
// Metre-scale relief added on top of the coarse grid: rocky ridges on steep mountain slopes,
// gentle undulation on open land, nothing at the airfields or on the beaches. The exact same
// function runs on the GPU for the detailed terrain patch around the aircraft (js/terrain-detail.js),
// so what you see near the aircraft is what you collide with.
export const DETAIL = { scales: [70, 23, 8], weights: [1.0, 0.45, 0.15], seeds: [11, 23, 37], fieldFade: 600 };

export function hash2i(ix, iz, seed) {
  let h = (Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz);
  const a = hash2i(ix, iz, seed), b = hash2i(ix + 1, iz, seed), c = hash2i(ix, iz + 1, seed), d = hash2i(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
}
export function detailNoise(x, z) {
  let n = 0;
  for (let k = 0; k < 3; k++) n += (vnoise(x / DETAIL.scales[k], z / DETAIL.scales[k], DETAIL.seeds[k]) - 0.5) * DETAIL.weights[k];
  return n;
}
// Amplitude (metres) of the detail at a point, from the coarse height, slope and airfield distance.
export function detailAmp(x, z) {
  const hc = coarseHeight(x, z);
  let w = smoothstep(2, 15, hc);
  if (w <= 0) return 0;
  for (const f of AIRFIELDS) {
    const { along, across } = fieldLocal(f, x, z);
    const da = Math.max(0, Math.abs(along) - f.length / 2 - 120);
    const dc = Math.max(0, Math.abs(across) - f.margin);
    w *= smoothstep(0, DETAIL.fieldFade, Math.hypot(da, dc));
  }
  if (w <= 0) return 0;
  const sx = (coarseHeight(x + 30, z) - coarseHeight(x - 30, z)) / 60;
  const sz = (coarseHeight(x, z + 30) - coarseHeight(x, z - 30)) / 60;
  const slope = Math.hypot(sx, sz);
  return w * (0.7 + 9 * smoothstep(0.12, 0.5, slope) * smoothstep(60, 300, hc));
}

// Height of the terrain surface (may be below sea level), including the fine detail.
export function terrainHeight(x, z) {
  const amp = detailAmp(x, z);
  return coarseHeight(x, z) + (amp > 0 ? amp * detailNoise(x, z) : 0);
}

// ---------- Terrain sun shadows ----------
// For each grid vertex, march towards the sun across the heightfield and record how far the sun
// is above the local horizon. Baked into a texture each time the sun moves (time of day); gives
// mountain shadows with soft edges (the sun is half a degree wide, plus some blur for scattering).
const sunShadow = new Uint8Array(VERTS * VERTS).fill(255);
export const sunShadowTex = typeof document === 'undefined' ? null : (() => {
  const t = new THREE.DataTexture(sunShadow, VERTS, VERTS, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
})();

export function bakeTerrainShadows(sunDir) {
  const horiz = Math.hypot(sunDir.x, sunDir.z);
  const tanSun = sunDir.y / Math.max(1e-4, horiz);
  const dx = sunDir.x / Math.max(1e-4, horiz), dz = sunDir.z / Math.max(1e-4, horiz);
  const penumbra = 0.035; // radians of soft edge
  for (let i = 0; i < VERTS; i++) {
    for (let j = 0; j < VERTS; j++) {
      const x = -HALF + j * CELL, z = -HALF + i * CELL;
      const h0 = Math.max(heights[i * VERTS + j], SEA_LEVEL) + 2;
      let maxTan = -1;
      for (let d = CELL * 0.7; d < 14000; d *= 1.07) {
        const h = coarseHeight(x + dx * d, z + dz * d);
        const tn = (h - h0) / d;
        if (tn > maxTan) maxTan = tn;
        // Nothing further can rise above the sun line once we're well above the highest peaks.
        if (h0 + d * Math.max(tanSun, maxTan) > 1800) break;
      }
      // Angle of the sun above the terrain horizon, mapped to 0 (in shadow) .. 1 (sunlit).
      const margin = Math.atan(tanSun) - Math.atan(maxTan);
      sunShadow[i * VERTS + j] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + margin / penumbra)));
    }
  }
  if (sunShadowTex) sunShadowTex.needsUpdate = true;
}

// Adds terrain sun shadows (and an optional relief bump) to a lit material.
export function applyTerrainShadow(mat, { relief = false } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.(sh, r);
    sh.uniforms.sunShadowMap = { value: sunShadowTex };
    if (!sh.vertexShader.includes('varying vec3 vTsWorld')) {
      sh.vertexShader = 'varying vec3 vTsWorld;\n' + sh.vertexShader.replace('#include <worldpos_vertex>',
        `#include <worldpos_vertex>
  vec4 tsP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    tsP = instanceMatrix * tsP;
  #endif
  vTsWorld = (modelMatrix * tsP).xyz;`);
    }
    const lights = THREE.ShaderChunk.lights_fragment_begin.replace(
      'getDirectionalLightInfo( directionalLight, directLight );',
      'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= tsSun;');
    sh.fragmentShader = 'uniform sampler2D sunShadowMap;\nvarying vec3 vTsWorld;\n' + sh.fragmentShader.replace('#include <lights_fragment_begin>',
      `float tsSun = texture2D(sunShadowMap, (vTsWorld.xz + ${HALF.toFixed(1)}) / ${CELL.toFixed(4)} / ${VERTS.toFixed(1)} + ${(0.5 / VERTS).toFixed(6)}).r;
      ${lights}`);
    if (relief) {
      // Fine relief: bump the normal with the gradient of the detail noise at two scales.
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          float tsDist = length(vTsWorld - cameraPosition);
          float e = 1.0 / 256.0;
          vec2 u1 = vTsWorld.xz / 41.0, u2 = vTsWorld.xz / 310.0;
          float a1 = texture2D(detailMap, u1).g, a2 = texture2D(detailMap, u2).r;
          vec2 g1 = vec2(texture2D(detailMap, u1 + vec2(e, 0.0)).g - a1, texture2D(detailMap, u1 + vec2(0.0, e)).g - a1);
          vec2 g2 = vec2(texture2D(detailMap, u2 + vec2(e, 0.0)).r - a2, texture2D(detailMap, u2 + vec2(0.0, e)).r - a2);
          vec2 g = g1 * 4.0 * (1.0 - smoothstep(150.0, 1500.0, tsDist)) + g2 * 10.0 * (1.0 - smoothstep(1500.0, 12000.0, tsDist));
          vec3 gw = vec3(g.x, 0.0, g.y);
          normal = normalize(normal - (viewMatrix * vec4(gw, 0.0)).xyz);
        }`);
    }
  };
  return mat;
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
      // (Boxes are checked even in cells without trees: villages have no trees.)
      if (list) for (const t of list) {
        const up = p.y - t.y;
        if (up < 0 || up > t.height) continue;
        const r = up < t.height * 0.3 ? 0.5 : t.radius * (1 - (up - t.height * 0.3) / (t.height * 0.7));
        if ((p.x - t.x) ** 2 + (p.z - t.z) ** 2 < r * r) return 'Hit a tree';
      }
      const boxes = boxGrid.get(_key(ix + a, iz + b));
      if (boxes) for (const h of boxes) if (insideBox(p, h)) return h.label ?? 'Hit a house';
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

// Farmland patchwork, applied in the terrain fragment shader (coarse mesh and detail patch):
// parcels of different crops on flat lowland, laid out on a grid whose orientation changes from
// area to area, with crop rows close up and darker hedgerows between parcels. Needs detailMap,
// vWPos and the world-space normal; keeps clear of the airfields.
export const FIELDS_GLSL = /* glsl */`
  {
    vec3 wn = normalize((vec4(normalize(vNormal), 0.0) * viewMatrix).xyz);
    float fh = vWPos.y;
    float region = texture2D(detailMap, vWPos.xz / 2600.0 + 0.37).b;
    float fmask = smoothstep(0.985, 0.995, wn.y) * smoothstep(8.0, 14.0, fh) * (1.0 - smoothstep(170.0, 230.0, fh))
                * smoothstep(0.52, 0.44, region);
    ${AIRFIELDS.map((f) => `{
      vec2 d = vWPos.xz - vec2(${f.x.toFixed(1)}, ${f.z.toFixed(1)});
      float al = abs(dot(d, vec2(${f.dir.x.toFixed(5)}, ${f.dir.z.toFixed(5)}))) - ${(f.length / 2 + 250).toFixed(1)};
      float ac = abs(dot(d, vec2(${(-f.dir.z).toFixed(5)}, ${f.dir.x.toFixed(5)}))) - ${(f.margin + 200).toFixed(1)};
      fmask *= smoothstep(0.0, 150.0, max(al, ac));
    }`).join('\n    ')}
    if (fmask > 0.01) {
      // Each 2.5 km area is laid out at its own fixed angle (straight parcels, different farms).
      vec2 farm = floor(vWPos.xz / 2500.0);
      float ang = (fract(sin(dot(farm, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 1.6;
      vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * vWPos.xz;
      vec2 cs = vec2(170.0, 115.0);
      vec2 id = floor(q / cs);
      // Split alternate parcels lengthwise so they aren't all the same size.
      float split = fract(sin(dot(id, vec2(41.3, 289.1))) * 9137.7);
      vec2 f = fract(q / cs);
      if (split > 0.55) { id.x += step(0.5, f.x) * 0.5; f.x = fract(f.x * 2.0); cs.x *= 0.5; }
      float r = fract(sin(dot(id, vec2(127.1, 311.7))) * 43758.5453);
      vec3 crop = r < 0.22 ? vec3(0.62, 0.55, 0.26)    // ripe wheat
                : r < 0.40 ? vec3(0.35, 0.47, 0.17)    // young cereal
                : r < 0.55 ? vec3(0.34, 0.25, 0.16)    // ploughed soil
                : r < 0.72 ? vec3(0.42, 0.52, 0.22)    // pasture
                : r < 0.85 ? vec3(0.55, 0.53, 0.30)    // stubble
                :            vec3(0.27, 0.38, 0.14);   // maize
      crop = crop * crop * 1.15; // to linear-ish
      float fd = length(vWPos - cameraPosition);
      // Crop rows, fading out with distance before they can alias.
      float rows = 0.5 + 0.5 * sin(q.x * (r < 0.55 ? 2.4 : 1.3));
      crop *= 1.0 + (rows - 0.5) * 0.22 * (1.0 - smoothstep(60.0, 220.0, fd));
      // Hedgerows along parcel edges (about 3 m wide), fading out far away.
      vec2 e = min(f, 1.0 - f) * cs;
      // Hedges widen a little with distance (so they don't break up into dots), then fade.
      float hw = 2.0 + fd * 0.0025;
      float hedge = (1.0 - smoothstep(hw * 0.6, hw * 1.4, min(e.x, e.y))) * (1.0 - smoothstep(3000.0, 8000.0, fd)) * 0.8;
      crop = mix(crop, vec3(0.07, 0.12, 0.04), hedge * 0.85);
      diffuseColor.rgb = mix(diffuseColor.rgb, crop * (0.9 + 0.2 * k), fmask * 0.9);
    }
  }
`;

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
    forest = C('#38572a'), dirt = C('#7a6a4c'), rock = C('#80796f'), rock2 = C('#5c5852'), snow = C('#f2f4f7');

  const nrm = geo.attributes.normal.array;
  const col = new Float32Array(pos.length);
  const c = new THREE.Color();
  for (let v = 0; v < VERTS * VERTS; v++) {
    const x = pos[v * 3], h = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const up = nrm[v * 3 + 1];
    const n1 = noise.fbm(x * 0.002, z * 0.002, 3);
    const n2 = noise.fbm(x * 0.0007 + 40, z * 0.0007, 3);
    if (h < -1) c.copy(wetSand);
    else if (h < 5 + n1 * 3) c.copy(sand);
    else {
      c.copy(grass).lerp(grass2, clamp(0.5 + n1, 0, 1));
      if (n2 > 0.12 && h < 700) c.lerp(forest, smoothstep(0.12, 0.3, n2));
      // Patchwork of farm fields in the lowlands.
      c.lerp(dirt, smoothstep(0.92, 0.82, up) * 0.6);
      const rockT = Math.max(smoothstep(0.82, 0.68, up), smoothstep(650, 950, h + n1 * 120));
      c.lerp(rock.clone().lerp(rock2, clamp(0.5 + n1, 0, 1)), rockT);
      const snowT = smoothstep(1050, 1250, h + n1 * 150) * smoothstep(0.55, 0.75, up);
      c.lerp(snow, snowT);
    }
    // Cheap ambient occlusion: compare with the average height around (about 190 m radius).
    const gi = Math.floor(v / VERTS), gj = v % VERTS;
    let sum = 0, cnt = 0;
    for (let di = -3; di <= 3; di += 3) for (let dj = -3; dj <= 3; dj += 3) {
      const ii = Math.min(VERTS - 1, Math.max(0, gi + di)), jj = Math.min(VERTS - 1, Math.max(0, gj + dj));
      sum += heights[ii * VERTS + jj]; cnt++;
    }
    const rel = h - sum / cnt;
    const ao = h < 0 ? 1 : clamp(1 + rel / 160, 0.72, 1.08);
    col[v * 3] = c.r * ao; col[v * 3 + 1] = c.g * ao; col[v * 3 + 2] = c.b * ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
  // Break up the flat vertex colours with multi-scale detail noise.
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detailTex };
    // The detailed patch around the aircraft replaces the coarse mesh inside its square.
    sh.uniforms.uPatch = mat.userData.patch ?? { value: new THREE.Vector3(0, 0, -1) };
    sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'uniform sampler2D detailMap;\nuniform vec3 uPatch;\nvarying vec3 vWPos;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      if (abs(vWPos.x - uPatch.x) < uPatch.z && abs(vWPos.z - uPatch.y) < uPatch.z) discard;
      float camDist = length(vWPos - cameraPosition);
      vec3 d1 = texture2D(detailMap, vWPos.xz / 11.0).rgb;
      vec3 d2 = texture2D(detailMap, vWPos.xz / 97.0).rgb;
      vec3 d3 = texture2D(detailMap, vWPos.xz / 820.0).rgb;
      float nearK = 1.0 - smoothstep(120.0, 1100.0, camDist);
      float midK = 1.0 - smoothstep(2000.0, 9000.0, camDist);
      float k = 1.0 + (d1.r - 0.5) * 0.5 * nearK + (d2.g - 0.5) * 0.45 * midK + (d3.b - 0.5) * 0.35;
      diffuseColor.rgb *= k;
      ${FIELDS_GLSL}`);
  };
  applyTerrainShadow(mat, { relief: true });
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

const floods = [];
const floodMat = (() => {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,214,150,0.9)'); gr.addColorStop(0.5, 'rgba(255,200,130,0.35)'); gr.addColorStop(1, 'rgba(255,190,120,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
})();

function buildAirfield(renderer, f, lights, papis, windsocks, nightLights, AL) {
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
  // Blue taxiway and apron edge lights.
  const apronLen = f.id === 'main' ? 140 : 70;
  const blue = (x, z) => { const w = fieldToWorld(f, -z, x, E + 0.35); AL.push([w.x, w.y, w.z, 0.25, 0.45, 1.0, 0.8, 0, 0]); };
  for (let x = f.width / 2 + 6; x < apronX - 30; x += 12) { blue(x, apronZ - 8); blue(x, apronZ + 8); }
  for (let z = -apronLen / 2; z <= apronLen / 2; z += 14) { blue(apronX - 31, z); blue(apronX + 31, z); }
  // Apron floodlights: warm pools of light on the tarmac at night.
  for (let z = -apronLen / 2 + 20; z <= apronLen / 2 - 10; z += 45) {
    const fl = new THREE.Mesh(new THREE.CircleGeometry(26, 32).rotateX(-Math.PI / 2), floodMat);
    fl.position.set(apronX + 12, E + 0.05, z);
    fl.renderOrder = 2;
    group.add(fl);
    floods.push(fl);
    const lamp = fieldToWorld(f, -z, apronX + 34, E + 14);
    AL.push([lamp.x, lamp.y, lamp.z, 1.0, 0.85, 0.6, 1.6, 0, 0]);
  }

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
      // Edge lights: white, turning yellow over the last 600 m in each direction (shown as amber-white).
      AL.push([wp.x, wp.y, wp.z, 1.0, 0.92, 0.75, 1.0, 0, 0]);
    }
  }
  group.add(edge);

  // Threshold (green, facing landing aircraft) and runway end (red) bars.
  for (const end of [1, -1]) {
    for (let x = -f.width / 2; x <= f.width / 2 + 0.01; x += f.width / 8) {
      const g = fieldToWorld(f, -end * (f.length / 2 + 1), x, E + 0.4);
      AL.push([g.x, g.y, g.z, 0.25, 1.0, 0.35, 1.3, 0, 0]);
    }
  }
  // Centreline lights every 15 m: white, alternating red/white from 900 m to go, red for the last 300 m
  // (as seen landing on 36; the pattern is symmetric so the other direction sees the same thing mirrored).
  for (let a = -f.length / 2 + 15; a < f.length / 2 - 7; a += 15) {
    const toGo = f.length / 2 - a;
    const red = toGo < 300 || (toGo < 900 && Math.round(a / 15) % 2 === 0);
    const c = fieldToWorld(f, a, 0, E + 0.15);
    AL.push([c.x, c.y, c.z, red ? 1.0 : 0.95, red ? 0.25 : 0.95, red ? 0.15 : 0.9, 0.7, 0, 0]);
  }
  // Touchdown-zone lights: bars either side of the centreline over the first 900 m from each end.
  if (f.approachLights) {
    for (const end of [1, -1]) {
      for (let d = 60; d <= 900; d += 60) {
        for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
          const t = fieldToWorld(f, -end * (f.length / 2 - d), side * (5 + i * 1.5), E + 0.15);
          AL.push([t.x, t.y, t.z, 1.0, 0.95, 0.85, 0.6, 0, 0]);
        }
      }
    }
  }

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
        // Sequenced flasher ("rabbit") on the centreline: runs towards the threshold twice a second.
        const sp = fieldToWorld(f, -end * (f.length / 2 + r * 30), 0, terrainHeightLocal(f, end * (f.length / 2 + r * 30), 0) + 1.2);
        AL.push([sp.x, sp.y, sp.z, 1.0, 1.0, 1.0, 2.2, 1, (10 - r) / 10]);
      }
    }
  }

  // PAPI: four lights left of each touchdown zone, red/white by glide-path angle.
  for (const end of [1, -1]) {
    const units = [];
    for (let k = 0; k < 4; k++) {
      const l = makeLight(0xffffff, 1.4);
      l.userData.grow = 0.0045; // PAPI must stay readable from several miles out
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

// ---------- Roads ----------
// A road network linking the villages and the airfields: a minimum spanning tree over them (plus
// a couple of extra links), each road routed with A* across the terrain grid. Steep ground costs
// more, water is impassable. Paths are smoothed and draped on the terrain as asphalt ribbons.
function roadNodes() {
  const nodes = VILLAGES.map((v) => ({ x: v.x, z: v.z, village: v }));
  for (const f of AIRFIELDS) {
    const p = fieldToWorld(f, f.id === 'main' ? -150 : 0, f.width / 2 + (f.id === 'main' ? 240 : 160));
    nodes.push({ x: p.x, z: p.z, field: f });
  }
  return nodes;
}

let blocked = null;
function routeRoad(a, b) {
  const toCell = (x, z) => [Math.round((x + HALF) / CELL), Math.round((z + HALF) / CELL)];
  const [sj, si] = toCell(a.x, a.z), [tj, ti] = toCell(b.x, b.z);
  const N = VERTS * VERTS;
  const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const open = [];   // binary heap of [f, idx]
  const push = (f, i) => { open.push([f, i]); let k = open.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (open[p][0] <= open[k][0]) break; [open[p], open[k]] = [open[k], open[p]]; k = p; } };
  const pop = () => { const top = open[0], last = open.pop(); if (open.length) { open[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r; if (m === k) break; [open[m], open[k]] = [open[k], open[m]]; k = m; } } return top; };
  const start = si * VERTS + sj, goal = ti * VERTS + tj;
  if (!blocked) {
    // Runways (with their ends and safety areas) are off limits for roads.
    blocked = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const x = -HALF + (i % VERTS) * CELL, z = -HALF + Math.floor(i / VERTS) * CELL;
      for (const f of AIRFIELDS) {
        const { along, across } = fieldLocal(f, x, z);
        if (Math.abs(across) < f.width / 2 + 70 && Math.abs(along) < f.length / 2 + 150) blocked[i] = 1;
      }
    }
  }
  const H = (i) => Math.hypot((i % VERTS) - tj, Math.floor(i / VERTS) - ti) * CELL;
  g[start] = 0; push(H(start), start);
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (open.length) {
    const [, cur] = pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cj = cur % VERTS, ci = (cur - cj) / VERTS;
    const h0 = heights[cur];
    for (const [dj, di] of nb) {
      const nj = cj + dj, ni = ci + di;
      if (nj < 0 || ni < 0 || nj >= VERTS || ni >= VERTS) continue;
      const n = ni * VERTS + nj;
      const h1 = heights[n];
      if (h1 < 4) continue; // water and beach
      if (blocked[n]) continue; // runways
      const run = Math.hypot(dj, di) * CELL;
      const grade = Math.abs(h1 - h0) / run;
      if (grade > 0.22) continue;
      const cost = run * (1 + 30 * grade * grade + (grade > 0.1 ? 4 : 0));
      if (g[cur] + cost < g[n]) { g[n] = g[cur] + cost; from[n] = cur; push(g[n] + H(n), n); }
    }
  }
  if (from[goal] < 0 && goal !== start) return null;
  const path = [];
  for (let i = goal; i >= 0; i = from[i]) path.push([-HALF + (i % VERTS) * CELL, -HALF + Math.floor(i / VERTS) * CELL]);
  path.reverse();
  path[0] = [a.x, a.z]; path[path.length - 1] = [b.x, b.z];
  // Chaikin smoothing, then resample every 10 m.
  let pts = path;
  for (let k = 0; k < 3; k++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      out.push([x0 * 0.75 + x1 * 0.25, z0 * 0.75 + z1 * 0.25], [x0 * 0.25 + x1 * 0.75, z0 * 0.25 + z1 * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  const res = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0);
    for (let d = 10 - carry; d < L; d += 10) res.push([x0 + (x1 - x0) * d / L, z0 + (z1 - z0) * d / L]);
    carry = (carry + L) % 10;
  }
  res.push(pts[pts.length - 1]);
  return res;
}

export const ROADS = [];
function buildRoads(nightLights) {
  const nodes = roadNodes();
  // Minimum spanning tree (Prim), plus the shortest link not in it for a loop.
  const inTree = new Set([0]), edges = [];
  while (inTree.size < nodes.length) {
    let best = null;
    for (const i of inTree) for (let j = 0; j < nodes.length; j++) {
      if (inTree.has(j)) continue;
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
      if (!best || d < best[2]) best = [i, j, d];
    }
    edges.push(best); inTree.add(best[1]);
  }
  let extra = null;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) continue;
    const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
    if (!extra || d < extra[2]) extra = [i, j, d];
  }
  if (extra) edges.push(extra);

  const W = 3.2; // half-width (m)
  const pos = [], uv = [], idx = [];
  for (const [i, j] of edges) {
    const pts = routeRoad(nodes[i], nodes[j]);
    if (!pts) continue;
    ROADS.push(pts);
    let along = 0;
    const base = pos.length / 3;
    for (let k = 0; k < pts.length; k++) {
      const [x, z] = pts[k];
      const [xa, za] = pts[Math.max(0, k - 1)], [xb, zb] = pts[Math.min(pts.length - 1, k + 1)];
      let dx = xb - xa, dz = zb - za; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      if (k) along += Math.hypot(x - pts[k - 1][0], z - pts[k - 1][1]);
      for (const side of [-1, 1]) {
        const px = x - dz * W * side, pz = z + dx * W * side;
        // Sit just above both the coarse mesh and the detailed patch.
        pos.push(px, Math.max(terrainHeight(px, pz), coarseHeight(px, pz)) + 0.25, pz);
        uv.push(side < 0 ? 0 : 1, along / 20);
      }
      if (k) { const a = base + (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      // Streetlights near the villages.
      if (k % 9 === 0 && VILLAGES.some((v) => Math.hypot(x - v.x, z - v.z) < v.r + 500)) {
        const lx = x - dz * (W + 2), lz = z + dx * (W + 2);
        nightLights.push([lx, terrainHeight(lx, lz) + 7, lz, 1.0, 0.65, 0.32]);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Asphalt with a dashed centre line and pale edges.
  const cv = document.createElement('canvas'); cv.width = 32; cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = '#4a4b4d'; g.fillRect(0, 0, 32, 64);
  g.fillStyle = '#8d8a80'; g.fillRect(0, 0, 2, 64); g.fillRect(30, 0, 2, 64);
  g.fillStyle = '#d8d4c4'; g.fillRect(15, 0, 2, 26);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = applyTerrainShadow(new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
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
      if ((x - v.x) ** 2 + (z - v.z) ** 2 < 32 * 32) continue; // keep the square around the church clear
      houses.push({ v, x, z, w, d: dpt, rot, lo, hi, wallH: 3.5 + rnd() * 2.5 * (rnd() < 0.2 ? 2 : 1) });
    }
  }
  const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), applyTerrainShadow(new THREE.MeshLambertMaterial({ color: 0xffffff })), houses.length);
  const roofs = new THREE.InstancedMesh(prismGeometry(), applyTerrainShadow(new THREE.MeshLambertMaterial({ color: 0xffffff })), houses.length);
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
  // A church on each village square: nave, west tower and a slate spire, visible from the air.
  const stone = applyTerrainShadow(new THREE.MeshLambertMaterial({ color: 0xcfc6b2 }));
  const slate = applyTerrainShadow(new THREE.MeshLambertMaterial({ color: 0x4e5560 }));
  const tile = applyTerrainShadow(new THREE.MeshLambertMaterial({ color: 0x8a3b2e }));
  for (const v of VILLAGES) {
    const base = terrainHeight(v.x, v.z) - 0.5;
    const rot = Math.atan2(v.x, v.z) * 0.3; // roughly east-west, varied a little
    const church = new THREE.Group();
    church.position.set(v.x, base, v.z);
    church.rotation.y = rot;
    const box = (w, h, d, x, y, z, m) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; church.add(b); };
    box(9, 9, 20, 0, 4.5, 3, stone);                                  // nave
    const roof = new THREE.Mesh(prismGeometry(), tile);
    roof.scale.set(21, 4.5, 10); roof.rotation.y = Math.PI / 2; roof.position.set(0, 9, 3); roof.castShadow = true; church.add(roof);
    box(5.5, 20, 5.5, 0, 10, -9.5, stone);                            // tower
    const spire = new THREE.Mesh(new THREE.ConeGeometry(3.7, 14, 4), slate);
    spire.rotation.y = Math.PI / 4; spire.position.set(0, 27, -9.5); spire.castShadow = true; church.add(spire);
    g.add(church);
    // Obstacles: nave and tower/spire (approximate, in world space).
    const c = Math.cos(rot), sn = Math.sin(rot);
    const at = (lx, lz) => [v.x + lx * c + lz * sn, v.z - lx * sn + lz * c];
    const [nx, nz] = at(0, 3), [tx, tz] = at(0, -9.5);
    addBoxObstacle({ cx: nx, cz: nz, cy: base + 6, hx: 5, hy: 6.5, hz: 10.5, cos: Math.cos(rot), sin: Math.sin(rot), label: 'Hit the church' });
    addBoxObstacle({ cx: tx, cz: tz, cy: base + 17, hx: 3.2, hy: 17, hz: 3.2, cos: Math.cos(rot), sin: Math.sin(rot), label: 'Hit the church spire' });
    // Floodlit spire at night.
    nightLights.push([tx, base + 30, tz, 1.0, 0.85, 0.6]);
  }
  return g;
}

// Airport lights as one draw call: each light is a glowing point with a minimum on-screen size,
// so it's visible from many kilometres away, and HDR brightness so it blooms. Mode 1 lights are
// strobes that flash in sequence (the approach "rabbit").
function buildAirportLights(list) {
  const n = list.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), extra = new Float32Array(n * 3);
  list.forEach((l, i) => { pos.set(l.slice(0, 3), i * 3); col.set(l.slice(3, 6), i * 3); extra.set(l.slice(6, 9), i * 3); });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aExtra', new THREE.BufferAttribute(extra, 3)); // size, mode, phase
  const uniforms = { uTime: { value: 0 }, uScale: { value: 500 }, uNight: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      uniform float uTime, uScale, uNight;
      attribute vec3 aColor, aExtra;
      varying vec3 vCol;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = -mv.z;
        float on = 1.0;
        if (aExtra.y > 0.5) {
          // Strobe: a 60 ms flash, sweeping along the row twice a second.
          float ph = fract(uTime * 2.0 - aExtra.z * 0.5);
          on = smoothstep(0.0, 0.01, ph) * (1.0 - smoothstep(0.03, 0.06, ph)) * 3.0;
        }
        // Light physically ~0.3 m wide, never smaller than ~3 px; brightness falls off slowly with range.
        gl_PointSize = max(aExtra.x * 0.6 * uScale / d, (2.0 + aExtra.x * 0.8) * (aExtra.y > 0.5 ? 1.6 : 1.0));
        vA = on * mix(0.55, 1.0, uNight) * clamp(5000.0 / d, 0.25, 1.0);
        vCol = aColor;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol;
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = dot(c, c) * 4.0;
        if (r > 1.0) discard;
        float core = exp(-r * 9.0), halo = exp(-r * 2.5) * 0.35;
        // HDR: the core is brighter than white so the bloom pass gives it a glow.
        gl_FragColor = vec4(vCol * (core * 1.7 + halo * 0.6) * vA, 1.0);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  return {
    points,
    update(t, camera, on, night) {
      points.visible = on;
      uniforms.uTime.value = t;
      uniforms.uNight.value = night ? 1 : 0;
      uniforms.uScale.value = innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360));
    },
  };
}

// Boulders and scree on steep or high ground: low-poly rocks, irregularly scaled and tilted,
// half-buried in the slope. Solid for collisions.
function buildRocks(maxRocks) {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  // Roughen the shape once; every instance is also scaled differently.
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.75 + 0.5 * ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.8, p.getZ(i) * k);
  }
  geo.computeVertexNormals();
  const rocks = new THREE.InstancedMesh(geo, applyTerrainShadow(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true })), maxRocks);
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  let s = 4242;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  const col = new THREE.Color(), cA = new THREE.Color('#7d776d'), cB = new THREE.Color('#5a554e'), cC = new THREE.Color('#8c8679');
  let n = 0;
  for (let tries = 0; tries < maxRocks * 30 && n < maxRocks; tries++) {
    const x = (rnd() - 0.5) * 18000, z = (rnd() - 0.5) * 20000;
    const h = terrainHeight(x, z);
    if (h < 120) continue;
    const slope = Math.hypot(terrainHeight(x + 6, z) - terrainHeight(x - 6, z), terrainHeight(x, z + 6) - terrainHeight(x, z - 6)) / 12;
    // Mostly on steep slopes and high ground, a scattering elsewhere.
    const want = smoothstep(0.25, 0.7, slope) * 0.9 + smoothstep(500, 900, h) * 0.6 + 0.02;
    if (rnd() > want) continue;
    if (VILLAGES.some((v) => (x - v.x) ** 2 + (z - v.z) ** 2 < v.r * v.r)) continue;
    // Clusters: small scree around a bigger boulder.
    const big = rnd() < 0.25;
    const size = big ? 1.8 + rnd() * 2.6 : 0.5 + rnd() * 1.1;
    pos.set(x, h - size * 0.35, z);
    q.setFromEuler(e.set((rnd() - 0.5) * 0.5, rnd() * 6.28, (rnd() - 0.5) * 0.5));
    sc.set(size * (0.8 + rnd() * 0.5), size * (0.6 + rnd() * 0.5), size * (0.8 + rnd() * 0.5));
    m.compose(pos, q, sc);
    rocks.setMatrixAt(n, m);
    rocks.setColorAt(n, col.copy(cA).lerp(rnd() < 0.5 ? cB : cC, rnd()));
    n++;
    if (big) addBoxObstacle({ cx: x, cz: z, cy: h + size * 0.2, hx: sc.x * 0.8, hy: sc.y * 0.75, hz: sc.z * 0.8, cos: 1, sin: 0, label: 'Hit a boulder' });
  }
  rocks.count = n;
  return rocks;
}

function buildTrees(maxTrees) {
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 5).translate(0, 1.5, 0);
  const crownGeo = new THREE.ConeGeometry(2.6, 8, 7).translate(0, 6.5, 0);
  const broadGeo = new THREE.IcosahedronGeometry(3.2, 0).scale(1, 0.9, 1).translate(0, 5.2, 0);
  const crowns = new THREE.InstancedMesh(crownGeo, applyTerrainShadow(new THREE.MeshLambertMaterial({ color: 0xffffff })), maxTrees);
  const broads = new THREE.InstancedMesh(broadGeo, applyTerrainShadow(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true })), maxTrees);
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
  const coarseMesh = buildTerrainMesh();
  scene.add(coarseMesh);
  const detail = createDetailPatch({ heights, VERTS, CELLS, CELL, HALF, colors: coarseMesh.geometry.attributes.color.array,
    detailTex, applyTerrainShadow, fields: AIRFIELDS, DETAIL, fieldsGLSL: FIELDS_GLSL, cells: quality === 'low' ? 120 : 200 });
  scene.add(detail.mesh);
  coarseMesh.material.userData.patch = detail.patchUniform;
  const sea = buildSea(env);
  scene.add(sea.mesh);
  const lights = [], papis = [], windsocks = [], nightLights = [];
  const AL = [];
  for (const f of AIRFIELDS) scene.add(buildAirfield(renderer, f, lights, papis, windsocks, nightLights, AL));
  const airportLights = buildAirportLights(AL);
  scene.add(airportLights.points);
  scene.add(buildVillages(nightLights));
  scene.add(buildRoads(nightLights));
  scene.add(buildTrees(quality === 'low' ? 3500 : 10000));
  scene.add(buildRocks(quality === 'low' ? 2500 : 7000));

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
    // lightsOn: night or poor visibility (airports switch their lights on in cloud, rain and fog).
    update(t, camera, wind, lightsOn = env.night) {
      sea.update(t);
      detail.update(camera);
      nightPoints.visible = env.night;
      airportLights.update(t, camera, lightsOn, env.night);
      for (const fl of floods) fl.visible = env.night;
      // Keep point lights a visible size at any distance.
      for (const l of lights) {
        l.getWorldPosition(_v);
        const d = _v.distanceTo(camera.position);
        const k = Math.max(l.userData.size, d * (l.userData.grow ?? 0.0012));
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
export { routeRoad as _routeRoad, roadNodes as _roadNodes }; // for tests
