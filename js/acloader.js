// Loader for AC3D (.ac) models, the format FlightGear aircraft use.
// Every object is baked into model space (its loc/rot chain applied) and returned as a named
// THREE.Group, so that FlightGear-style animations (rotations about a centre and axis given in
// model coordinates) can be applied by setting each group's matrix.
//
// AC3D format summary: MATERIAL lines, then a tree of OBJECTs with optional name, texture,
// texrep/texoff, rot (3x3), loc, crease, numvert (vertex list), numsurf (SURF flags, mat index,
// refs: vertex index + uv) and kids. SURF flags: low nibble 0 = polygon (1/2 = lines),
// 0x10 = smooth shaded, 0x20 = two-sided.

import * as THREE from 'three';

function parseMaterials(lines) {
  const mats = [];
  for (const l of lines) {
    if (!l.startsWith('MATERIAL')) continue;
    const num = (key) => {
      const m = l.match(new RegExp(`\\b${key}\\s+([-\\d.]+)(?:\\s+([-\\d.]+)\\s+([-\\d.]+))?`));
      return m ? (m[2] !== undefined ? [Number(m[1]), Number(m[2]), Number(m[3])] : Number(m[1])) : null;
    };
    mats.push({
      name: (l.match(/"([^"]*)"/) || [])[1] ?? '',
      rgb: num('rgb') ?? [1, 1, 1], emis: num('emis') ?? [0, 0, 0], spec: num('spec') ?? [0, 0, 0],
      shi: num('shi') ?? 32, trans: num('trans') ?? 0,
    });
  }
  return mats;
}

/**
 * @param {string} text   contents of the .ac file
 * @param {object} opts   { toModel(x, y, z) -> [x, y, z], textures: { name: THREE.Texture }, skip: Set<string>,
 *                          material(matInfo, texName, twoSided) -> THREE.Material (optional) }
 * @returns {{ root: THREE.Group, objects: Map<string, THREE.Group> }}
 */
export function parseAC(text, opts) {
  const lines = text.split(/\r?\n/);
  const acMats = parseMaterials(lines);
  const root = new THREE.Group();
  const objects = new Map();
  const matCache = new Map();
  const getMaterial = (mi, tex, twoSided, objName) => {
    const key = `${mi}|${tex}|${twoSided}|${opts.materialKey?.(objName) ?? ''}`;
    if (matCache.has(key)) return matCache.get(key);
    const m = acMats[mi] ?? acMats[0];
    let mat = opts.material?.(m, tex, twoSided, objName);
    if (!mat) {
      const map = tex ? (opts.textureFor ? opts.textureFor(tex) : opts.textures?.[tex.split('/').pop()] ?? null) : null;
      mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(m.rgb[0], m.rgb[1], m.rgb[2]),
        emissive: new THREE.Color(m.emis[0], m.emis[1], m.emis[2]),
        map,
        roughness: THREE.MathUtils.clamp(1 - m.shi / 160, 0.3, 0.9),
        metalness: 0.15,
        side: twoSided ? THREE.DoubleSide : THREE.FrontSide,
        transparent: m.trans > 0.01,
        opacity: 1 - m.trans,
      });
    }
    matCache.set(key, mat);
    return mat;
  };

  let i = 0;
  const next = () => lines[i++];
  // Parses one OBJECT block (lines[i] is the OBJECT line) with the parent's transform.
  function parseObject(parentMatrix) {
    const header = next().trim().split(/\s+/);
    const kind = header[1];
    let name = kind, tex = null, texrep = [1, 1], texoff = [0, 0], crease = 61;
    const local = new THREE.Matrix4();
    const loc = new THREE.Vector3();
    let rot = null;
    let verts = null;
    const surfaces = [];
    let kids = 0;
    while (i < lines.length) {
      const l = lines[i].trim();
      const tok = l.split(/\s+/);
      i++;
      switch (tok[0]) {
        case 'name': name = l.slice(5).trim().replace(/^"|"$/g, ''); break;
        case 'data': {
          // "data N" is followed by N characters of text, possibly over several lines.
          let need = Number(tok[1]);
          while (need > 0 && i < lines.length) need -= lines[i++].length + 1;
          break;
        }
        case 'texture': tex = (l.match(/"([^"]*)"/) || [])[1] ?? null; break;
        case 'texrep': texrep = [Number(tok[1]), Number(tok[2])]; break;
        case 'texoff': texoff = [Number(tok[1]), Number(tok[2])]; break;
        case 'rot': rot = tok.slice(1, 10).map(Number); break;
        case 'loc': loc.set(Number(tok[1]), Number(tok[2]), Number(tok[3])); break;
        case 'crease': crease = Number(tok[1]); break;
        case 'numvert': {
          const n = Number(tok[1]);
          verts = new Float32Array(n * 3);
          for (let k = 0; k < n; k++) {
            const v = lines[i++].trim().split(/\s+/);
            verts[k * 3] = Number(v[0]); verts[k * 3 + 1] = Number(v[1]); verts[k * 3 + 2] = Number(v[2]);
          }
          break;
        }
        case 'numsurf': {
          const n = Number(tok[1]);
          for (let s = 0; s < n; s++) {
            let flags = 0, mat = 0, refs = null;
            while (!refs) {
              const t = lines[i++].trim().split(/\s+/);
              if (t[0] === 'SURF') flags = parseInt(t[1], 16);
              else if (t[0] === 'mat') mat = Number(t[1]);
              else if (t[0] === 'refs') {
                const r = Number(t[1]);
                refs = [];
                for (let k = 0; k < r; k++) {
                  const v = lines[i++].trim().split(/\s+/);
                  refs.push([Number(v[0]), Number(v[1] ?? 0), Number(v[2] ?? 0)]);
                }
              }
            }
            surfaces.push({ flags, mat, refs });
          }
          break;
        }
        case 'kids': kids = Number(tok[1]); break;
        default: break;
      }
      if (tok[0] === 'kids') break;
    }
    // Transform: parent * translate(loc) * rotation.
    local.makeTranslation(loc.x, loc.y, loc.z);
    if (rot) {
      const r = new THREE.Matrix4().set(rot[0], rot[1], rot[2], 0, rot[3], rot[4], rot[5], 0, rot[6], rot[7], rot[8], 0, 0, 0, 0, 1);
      local.multiply(r);
    }
    const world = parentMatrix.clone().multiply(local);
    const skipped = opts.skip?.has(name);
    let node = null;
    if (verts && surfaces.length && !skipped) node = buildObject(name, verts, surfaces, world, tex, texrep, texoff, crease);
    if (opts.hierarchy && !node) {
      // Empty group objects still need a node so animations can target them.
      node = new THREE.Group();
      node.name = name;
      node.matrixAutoUpdate = false;
      if (!skipped) { if (objects.has(name)) objects.get(name).push(node); else objects.set(name, [node]); }
    }
    for (let k = 0; k < kids; k++) {
      while (i < lines.length && !lines[i].startsWith('OBJECT')) i++;
      if (i < lines.length) {
        const child = parseObject(world);
        if (opts.hierarchy && child) node.add(child);
      }
    }
    if (opts.hierarchy && skipped) node.visible = false;
    return node;
  }

  const _p = new THREE.Vector3();
  function buildObject(name, verts, surfaces, world, tex, texrep, texoff, crease) {
    const n = verts.length / 3;
    // Vertices in model space.
    const P = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      _p.set(verts[k * 3], verts[k * 3 + 1], verts[k * 3 + 2]).applyMatrix4(world);
      const m = opts.toModel(_p.x, _p.y, _p.z);
      P[k * 3] = m[0]; P[k * 3 + 1] = m[1]; P[k * 3 + 2] = m[2];
    }
    // Face normals (Newell's method) and vertex -> faces adjacency for smoothing.
    const polys = surfaces.filter((s) => (s.flags & 0x0f) === 0 && s.refs.length >= 3);
    const fn = polys.map((s) => {
      let nx = 0, ny = 0, nz = 0;
      const r = s.refs;
      for (let a = 0; a < r.length; a++) {
        const p = r[a][0] * 3, q = r[(a + 1) % r.length][0] * 3;
        nx += (P[p + 1] - P[q + 1]) * (P[p + 2] + P[q + 2]);
        ny += (P[p + 2] - P[q + 2]) * (P[p] + P[q]);
        nz += (P[p] - P[q]) * (P[p + 1] + P[q + 1]);
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    });
    const adj = Array.from({ length: n }, () => []);
    polys.forEach((s, f) => { for (const r of s.refs) adj[r[0]].push(f); });
    const cosC = Math.cos(crease * Math.PI / 180);

    // Group triangles by (material, two-sided) into separate meshes.
    const buckets = new Map();
    polys.forEach((s, f) => {
      const two = !!(s.flags & 0x20);
      const key = `${s.mat}|${two}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { mat: s.mat, two, pos: [], nor: [], uv: [] }));
      const smooth = !!(s.flags & 0x10);
      const corner = (r) => {
        const vi = r[0];
        b.pos.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]);
        let nx = fn[f][0], ny = fn[f][1], nz = fn[f][2];
        if (smooth) {
          nx = ny = nz = 0;
          for (const g of adj[vi]) {
            const d = fn[g][0] * fn[f][0] + fn[g][1] * fn[f][1] + fn[g][2] * fn[f][2];
            if (d >= cosC) { nx += fn[g][0]; ny += fn[g][1]; nz += fn[g][2]; }
          }
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
        }
        b.nor.push(nx, ny, nz);
        b.uv.push(r[1] * texrep[0] + texoff[0], r[2] * texrep[1] + texoff[1]);
      };
      // Triangle fan.
      for (let k = 1; k < s.refs.length - 1; k++) { corner(s.refs[0]); corner(s.refs[k]); corner(s.refs[k + 1]); }
    });
    const group = new THREE.Group();
    group.name = name;
    for (const b of buckets.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      const mesh = new THREE.Mesh(geo, getMaterial(b.mat, tex, b.two, name));
      mesh.name = name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    group.matrixAutoUpdate = false;
    if (!opts.hierarchy) root.add(group);
    if (objects.has(name)) objects.get(name).push(group); else objects.set(name, [group]);
    return group;
  }

  while (i < lines.length && !lines[i].startsWith('OBJECT')) i++;
  if (i < lines.length) {
    const top = parseObject(new THREE.Matrix4());
    if (opts.hierarchy && top) root.add(top);
  }
  return { root, objects };
}

// Download progress of the model files (for the loading indicator).
export const assetProgress = { started: 0, done: 0 };

// fetch() a text file, retrying a couple of times (a single dropped request on a slow or flaky
// connection shouldn't lose the whole model).
export async function fetchTextRetry(url, tries = 3) {
  assetProgress.started++;
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) { const t = await r.text(); assetProgress.done++; return t; }
      err = new Error(`${url}: HTTP ${r.status}`);
      if (r.status === 404) break;
    } catch (e) { err = new Error(`${url}: ${e.message}`); }
    await new Promise((res) => setTimeout(res, 800 * (i + 1)));
  }
  assetProgress.done++;
  throw err;
}

export async function loadAC(url, opts) {
  return parseAC(await fetchTextRetry(url), opts);
}
