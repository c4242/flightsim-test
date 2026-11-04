// Detailed terrain patch around the camera. A fixed grid (12 m spacing, 2.4 km across) is moved
// with the camera in whole grid steps; the vertex shader computes each vertex's height from the
// coarse heightfield (a float texture, same triangulation as js/terrain.js) plus the fine detail,
// using a bit-exact GLSL copy of the hash, noise and amplitude functions in js/terrain.js. Near
// the patch edge the detail fades out so the patch meets the coarse mesh, which is not drawn inside it.

import * as THREE from 'three';

export function createDetailPatch({ heights, VERTS, CELLS, CELL, HALF, colors, detailTex, applyTerrainShadow, fields, DETAIL, fieldsGLSL = '', cells = 200 }) {
  const SPACING = 12;
  const HALFP = (cells / 2) * SPACING;

  // Coarse heights for exact lookups, and the coarse vertex colours (with their AO) for shading.
  const hTex = new THREE.DataTexture(heights, VERTS, VERTS, THREE.RedFormat, THREE.FloatType);
  hTex.minFilter = hTex.magFilter = THREE.NearestFilter;
  hTex.needsUpdate = true;
  const half = new Uint16Array(VERTS * VERTS * 4);
  for (let i = 0; i < VERTS * VERTS; i++) {
    half[i * 4] = THREE.DataUtils.toHalfFloat(colors[i * 3]);
    half[i * 4 + 1] = THREE.DataUtils.toHalfFloat(colors[i * 3 + 1]);
    half[i * 4 + 2] = THREE.DataUtils.toHalfFloat(colors[i * 3 + 2]);
    half[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const cTex = new THREE.DataTexture(half, VERTS, VERTS, THREE.RGBAFormat, THREE.HalfFloatType);
  cTex.minFilter = cTex.magFilter = THREE.LinearFilter;
  cTex.needsUpdate = true;

  // Grid geometry in patch-local coordinates.
  const n = cells + 1;
  const pos = new Float32Array(n * n * 3);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const k = (i * n + j) * 3;
    pos[k] = -HALFP + j * SPACING; pos[k + 1] = 0; pos[k + 2] = -HALFP + i * SPACING;
  }
  const idx = new Uint32Array(cells * cells * 6);
  let m = 0;
  for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) {
    const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
    idx[m++] = a; idx[m++] = c; idx[m++] = b; idx[m++] = b; idx[m++] = c; idx[m++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));

  const fieldData = fields.map((f) => new THREE.Vector4(f.x, f.z, f.dir.x, f.dir.z));
  const fieldSize = fields.map((f) => new THREE.Vector2(f.length / 2 + 120, f.margin));
  const center = new THREE.Vector2();
  const patchUniform = { value: new THREE.Vector3(0, 0, HALFP - 2 * SPACING) };
  const uniforms = {
    uHeights: { value: hTex }, uColors: { value: cTex }, uCenter: { value: center },
    uFields: { value: fieldData }, uFieldSize: { value: fieldSize },
  };
  const NF = fields.length;
  const f1 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

  const glsl = /* glsl */`
    uniform sampler2D uHeights, uColors;
    uniform vec2 uCenter;
    uniform vec4 uFields[${NF}];
    uniform vec2 uFieldSize[${NF}];
    float coarseH(vec2 p) {
      float gx = (p.x + ${f1(HALF)}) / ${CELL.toFixed(6)};
      float gz = (p.y + ${f1(HALF)}) / ${CELL.toFixed(6)};
      if (gx < 0.0 || gz < 0.0 || gx >= ${f1(CELLS)} || gz >= ${f1(CELLS)}) return -156.0;
      int j = int(floor(gx)), i = int(floor(gz));
      float fx = gx - float(j), fz = gz - float(i);
      float ha = texelFetch(uHeights, ivec2(j, i), 0).r;
      float hb = texelFetch(uHeights, ivec2(j + 1, i), 0).r;
      float hc = texelFetch(uHeights, ivec2(j, i + 1), 0).r;
      float hd = texelFetch(uHeights, ivec2(j + 1, i + 1), 0).r;
      if (fx + fz <= 1.0) return ha + (hb - ha) * fx + (hc - ha) * fz;
      return hd + (hc - hd) * (1.0 - fx) + (hb - hd) * (1.0 - fz);
    }
    float hash2i(int ix, int iz, uint seed) {
      uint h = (uint(ix) * 0x27d4eb2du) ^ (uint(iz) * 0x165667b1u) ^ seed;
      h = (h ^ (h >> 15u)) * 0x85ebca6bu;
      h = (h ^ (h >> 13u)) * 0xc2b2ae35u;
      h ^= h >> 16u;
      return float(h) / 4294967296.0;
    }
    float vnoise(vec2 p, uint seed) {
      vec2 i = floor(p), f = p - i;
      int ix = int(i.x), iz = int(i.y);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash2i(ix, iz, seed), b = hash2i(ix + 1, iz, seed), c = hash2i(ix, iz + 1, seed), d = hash2i(ix + 1, iz + 1, seed);
      return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
    }
    float detailNoise(vec2 p) {
      return (vnoise(p / ${f1(DETAIL.scales[0])}, ${DETAIL.seeds[0]}u) - 0.5) * ${f1(DETAIL.weights[0])}
           + (vnoise(p / ${f1(DETAIL.scales[1])}, ${DETAIL.seeds[1]}u) - 0.5) * ${f1(DETAIL.weights[1])}
           + (vnoise(p / ${f1(DETAIL.scales[2])}, ${DETAIL.seeds[2]}u) - 0.5) * ${f1(DETAIL.weights[2])};
    }
    float detailAmp(vec2 p) {
      float hc = coarseH(p);
      float w = smoothstep(2.0, 15.0, hc);
      if (w <= 0.0) return 0.0;
      for (int k = 0; k < ${NF}; k++) {
        vec2 d = p - uFields[k].xy;
        vec2 dir = uFields[k].zw;
        float along = d.x * dir.x + d.y * dir.y;
        float across = d.x * -dir.y + d.y * dir.x;
        float da = max(0.0, abs(along) - uFieldSize[k].x);
        float dc = max(0.0, abs(across) - uFieldSize[k].y);
        w *= smoothstep(0.0, ${f1(DETAIL.fieldFade)}, length(vec2(da, dc)));
      }
      if (w <= 0.0) return 0.0;
      float sx = (coarseH(p + vec2(30.0, 0.0)) - coarseH(p - vec2(30.0, 0.0))) / 60.0;
      float sz = (coarseH(p + vec2(0.0, 30.0)) - coarseH(p - vec2(0.0, 30.0))) / 60.0;
      float slope = length(vec2(sx, sz));
      return w * (0.7 + 9.0 * smoothstep(0.12, 0.5, slope) * smoothstep(60.0, 300.0, hc));
    }`;

  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: detailTex };
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = glsl + '\nvarying vec3 vWPos;\nvarying vec2 vCUv;\n' + sh.vertexShader
      .replace('#include <beginnormal_vertex>', `
        vec2 wxz = position.xz + uCenter;
        // Detail fades out towards the patch edge, where it meets the coarse mesh.
        vec2 rel = abs(position.xz) / ${f1(HALFP)};
        float edge = 1.0 - smoothstep(0.75, 0.98, max(rel.x, rel.y));
        float amp = detailAmp(wxz) * edge;
        float hTot = coarseH(wxz) + amp * detailNoise(wxz);
        const float E = 6.0;
        float hL = coarseH(wxz - vec2(E, 0.0)) + amp * detailNoise(wxz - vec2(E, 0.0));
        float hR = coarseH(wxz + vec2(E, 0.0)) + amp * detailNoise(wxz + vec2(E, 0.0));
        float hD = coarseH(wxz - vec2(0.0, E)) + amp * detailNoise(wxz - vec2(0.0, E));
        float hU = coarseH(wxz + vec2(0.0, E)) + amp * detailNoise(wxz + vec2(0.0, E));
        vec3 objectNormal = normalize(vec3(-(hR - hL) / (2.0 * E), 1.0, -(hU - hD) / (2.0 * E)));
        vCUv = (wxz + ${f1(HALF)}) / ${CELL.toFixed(6)} / ${f1(VERTS)} + ${(0.5 / VERTS).toFixed(7)};`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(wxz.x, hTot, wxz.y);
        vWPos = transformed;`);
    sh.fragmentShader = 'uniform sampler2D detailMap, uColors;\nvarying vec3 vWPos;\nvarying vec2 vCUv;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= texture2D(uColors, vCUv).rgb;
        float camDist = length(vWPos - cameraPosition);
        vec3 d1 = texture2D(detailMap, vWPos.xz / 11.0).rgb;
        vec3 d2 = texture2D(detailMap, vWPos.xz / 97.0).rgb;
        vec3 d3 = texture2D(detailMap, vWPos.xz / 820.0).rgb;
        float nearK = 1.0 - smoothstep(120.0, 1100.0, camDist);
        float midK = 1.0 - smoothstep(2000.0, 9000.0, camDist);
        float k = 1.0 + (d1.r - 0.5) * 0.5 * nearK + (d2.g - 0.5) * 0.45 * midK + (d3.b - 0.5) * 0.35;
        diffuseColor.rgb *= k;
        ${fieldsGLSL}`);
  };
  applyTerrainShadow(mat, { relief: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;

  return {
    mesh,
    patchUniform,
    update(camera) {
      // Follow the camera in whole grid steps so vertices stay at fixed world positions.
      const cx = Math.round(camera.position.x / SPACING) * SPACING;
      const cz = Math.round(camera.position.z / SPACING) * SPACING;
      center.set(cx, cz);
      // The coarse mesh stops two grid steps inside the patch edge, so the meshes overlap there
      // (no cracks); the coarse mesh is pushed back in depth so the patch wins in the overlap.
      patchUniform.value.set(cx, cz, HALFP - 2 * SPACING);
    },
  };
}
