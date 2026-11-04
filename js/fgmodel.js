// Loader for FlightGear model XML files (PropertyList) and the subset of FlightGear's model
// animation system needed to show a 3D cockpit:
//   - <path> to an AC3D model, <model> sub-models with <offsets> (x/y/z-m, heading/pitch/roll-deg)
//   - animations: rotate, translate, select, textranslate, spin, knob and slider (shown, not clickable);
//     material, pick, range, noshadow, light and effects are ignored
//   - <property>, <factor>, <offset-*>, <min/max>, <interpolation>, <axis> (x/y/z or two points),
//     <center>, and <condition> with and/or/not/equals/less-than/greater-than(-equals)
// Animations insert a transform node above their target objects, in document order, as
// FlightGear does, so animations compose in the same way.
//
// Everything is built in the FlightGear frame: x aft, y right, z up, metres.

import * as THREE from 'three';
import { parseAC, fetchTextRetry, assetProgress } from './acloader.js';

const DEG = Math.PI / 180;
const acToFg = (x, y, z) => [x, -z, y];

// ---------- XML helpers ----------
const kids = (el, tag) => Array.from(el.children).filter((c) => c.tagName === tag);
const kid = (el, tag) => Array.from(el.children).find((c) => c.tagName === tag) ?? null;
const text = (el, tag) => { const k = kid(el, tag); return k ? k.textContent.trim() : null; };
const num = (el, tag, d = null) => { const t = text(el, tag); return t === null || t === '' ? d : Number(t); };
const normProp = (p) => p.replace(/^\/+/, '').replace(/\[0\]/g, '');

// Conditions: returns a function(props) -> boolean.
function compileCondition(el) {
  if (!el) return null;
  const parts = Array.from(el.children).map(compileNode).filter(Boolean);
  return (P) => parts.every((f) => f(P));
}
function operand(el) {
  // Either <property> or <value>; two children of the comparison.
  if (el.tagName === 'property') { const p = normProp(el.textContent.trim()); return (P) => P(p); }
  const v = el.textContent.trim();
  const n = Number(v);
  return () => (Number.isNaN(n) ? v : n);
}
function compileNode(el) {
  const t = el.tagName;
  if (t === 'and' || t === 'condition') { const c = Array.from(el.children).map(compileNode).filter(Boolean); return (P) => c.every((f) => f(P)); }
  if (t === 'or') { const c = Array.from(el.children).map(compileNode).filter(Boolean); return (P) => c.some((f) => f(P)); }
  if (t === 'not') { const c = Array.from(el.children).map(compileNode).filter(Boolean); return (P) => !c.every((f) => f(P)); }
  if (t === 'property') { const p = normProp(el.textContent.trim()); return (P) => !!P(p); }
  const ops = {
    equals: (a, b) => a == b, 'not-equals': (a, b) => a != b, 'less-than': (a, b) => a < b, 'greater-than': (a, b) => a > b,
    'less-than-equals': (a, b) => a <= b, 'greater-than-equals': (a, b) => a >= b,
  };
  if (ops[t]) {
    const [a, b] = Array.from(el.children).filter((c) => c.tagName === 'property' || c.tagName === 'value').map(operand);
    if (!a || !b) return null;
    return (P) => ops[t](a(P), b(P));
  }
  return null;
}

// ---------- Loading ----------
const textCache = new Map();
async function fetchText(url) {
  if (!textCache.has(url)) textCache.set(url, fetchTextRetry(url));
  return textCache.get(url);
}
const texCache = new Map();

/**
 * @param {string} url              URL of the model XML
 * @param {object} env              { resolve(path, fromUrl) -> url, skipModel(name, path) -> bool, renderer,
 *                                    material(mat, texUrl, twoSided, objName) -> THREE.Material | undefined,
 *                                    texture(texUrl) -> THREE.Texture | undefined }
 */
export async function loadFGModel(url, env) {
  const anims = [];
  const named = new Map();     // object or sub-model name -> [nodes]
  const root = await loadModelFile(url, env, anims, named);
  return { root, named, anims, update: (P, dt) => updateAnimations(anims, P, dt) };
}

async function loadModelFile(url, env, anims, globalNamed) {
  const xml = new DOMParser().parseFromString(await fetchText(url), 'application/xml');
  const pl = xml.documentElement;
  const group = new THREE.Group();
  group.name = url;
  const local = new Map(); // names visible to this file's animations
  const addName = (n, node) => { if (!n) return; (local.get(n) ?? local.set(n, []).get(n)).push(node); (globalNamed.get(n) ?? globalNamed.set(n, []).get(n)).push(node); };

  // The AC3D model.
  const acPath = text(pl, 'path');
  if (acPath) {
    const acUrl = env.resolve(acPath, url);
    if (acUrl) {
      try {
        const acText = await fetchText(acUrl);
        const texNames = Array.from(new Set(Array.from(acText.matchAll(/^texture "([^"]+)"/gm), (m) => m[1])));
        const textures = {};
        await Promise.all(texNames.map(async (t) => { textures[t] = await loadTexture(env.resolve(t, acUrl), env); }));
        const ac = parseAC(acText, {
          toModel: acToFg, hierarchy: true,
          textureFor: (t) => textures[t] ?? null,
          material: env.material ? (m, tex, two, name) => env.material(m, tex ? textures[tex] : null, two, name) : undefined,
          materialKey: env.materialKey,
        });
        group.add(ac.root);
        for (const [n, nodes] of ac.objects) for (const node of nodes) addName(n, node);
      } catch (e) { console.warn('FG model: could not load', acUrl, e.message); }
    }
  }

  // Sub-models.
  const subs = kids(pl, 'model');
  await Promise.all(subs.map(async (m) => {
    const name = text(m, 'name');
    const path = text(m, 'path');
    if (!path || env.skipModel?.(name, path)) return;
    const subUrl = env.resolve(path, url);
    if (!subUrl || !subUrl.endsWith('.xml')) return;
    const sub = await loadModelFile(subUrl, env, anims, globalNamed);
    const o = kid(m, 'offsets');
    if (o) {
      const t = new THREE.Matrix4().makeTranslation(num(o, 'x-m', 0), num(o, 'y-m', 0), num(o, 'z-m', 0));
      const r = new THREE.Matrix4().makeRotationZ(num(o, 'heading-deg', 0) * DEG)
        .multiply(new THREE.Matrix4().makeRotationX(num(o, 'roll-deg', 0) * DEG))
        .multiply(new THREE.Matrix4().makeRotationY(num(o, 'pitch-deg', 0) * DEG));
      sub.matrixAutoUpdate = false;
      sub.matrix.copy(t.multiply(r));
    }
    group.add(sub);
    addName(name, sub);
  }));

  // Animations, in document order.
  for (const a of kids(pl, 'animation')) {
    const type = text(a, 'type');
    if (!['rotate', 'translate', 'select', 'textranslate', 'spin', 'knob', 'slider'].includes(type)) continue;
    const objNames = kids(a, 'object-name').map((e) => e.textContent.trim());
    const targets = objNames.flatMap((n) => local.get(n) ?? []);
    if (!targets.length) continue;
    const anim = compileAnimation(a, type);
    if (!anim) continue;
    if (type === 'textranslate') {
      anim.materials = [];
      for (const t of targets) t.traverse((o) => {
        if (!o.isMesh || !o.material.map) return;
        // Give the object its own material and texture transform.
        o.material = o.material.clone();
        o.material.map = o.material.map.clone();
        o.material.map.needsUpdate = true;
        anim.materials.push(o.material);
      });
    } else {
      anim.nodes = targets.map((t) => {
        const wrap = new THREE.Group();
        wrap.matrixAutoUpdate = false;
        const parent = t.parent;
        // Put the wrapper where the target was among the parent's children.
        const idx = parent.children.indexOf(t);
        parent.children[idx] = wrap;
        wrap.parent = parent;
        t.parent = null;
        wrap.add(t);
        return wrap;
      });
    }
    anims.push(anim);
  }
  return group;
}

function loadTexture(url, env) {
  if (!url) return Promise.resolve(null);
  if (!texCache.has(url)) {
    assetProgress.started++;
    texCache.set(url, new Promise((resolve) => {
      new THREE.TextureLoader().load(url, (t) => {
        assetProgress.done++;
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = env.renderer ? Math.min(8, env.renderer.capabilities.getMaxAnisotropy()) : 4;
        resolve(t);
      }, undefined, () => { console.warn('FG model: missing texture', url); assetProgress.done++; resolve(null); });
    }));
  }
  return texCache.get(url);
}

function compileAnimation(a, type) {
  const propEl = kid(a, 'property');
  const prop = propEl ? normProp(propEl.textContent.trim()) : null;
  const interp = kid(a, 'interpolation');
  const table = interp ? kids(interp, 'entry').map((e) => [num(e, 'ind', 0), num(e, 'dep', 0)]) : null;
  const ax = kid(a, 'axis');
  let axis = new THREE.Vector3(0, 0, 1), center = new THREE.Vector3();
  if (ax) {
    if (kid(ax, 'x1-m')) {
      const p1 = new THREE.Vector3(num(ax, 'x1-m', 0), num(ax, 'y1-m', 0), num(ax, 'z1-m', 0));
      const p2 = new THREE.Vector3(num(ax, 'x2-m', 0), num(ax, 'y2-m', 0), num(ax, 'z2-m', 0));
      axis = p2.clone().sub(p1);
      center = p1.add(p2).multiplyScalar(0.5);
    } else axis.set(num(ax, 'x', 0), num(ax, 'y', 0), num(ax, 'z', 0));
    if (axis.lengthSq() > 0) axis.normalize(); else axis.set(0, 0, 1);
  }
  const c = kid(a, 'center');
  if (c) center.set(num(c, 'x-m', 0), num(c, 'y-m', 0), num(c, 'z-m', 0));
  const isTex = type === 'textranslate';
  const anim = {
    type, prop, table, axis, center,
    factor: num(a, 'factor', 1),
    offset: num(a, isTex ? 'offset' : type === 'translate' || type === 'slider' ? 'offset-m' : 'offset-deg', 0),
    min: num(a, isTex ? 'min' : type === 'translate' || type === 'slider' ? 'min-m' : 'min-deg', null),
    max: num(a, isTex ? 'max' : type === 'translate' || type === 'slider' ? 'max-m' : 'max-deg', null),
    step: num(a, 'step', null), scroll: num(a, 'scroll', null),
    cond: compileCondition(kid(a, 'condition')),
    spin: 0,
  };
  if (isTex) {
    // Texture axis: x or y in texture space.
    anim.texAxis = ax ? [num(ax, 'x', 0), num(ax, 'y', 0)] : [1, 0];
  }
  return anim;
}

const _m = new THREE.Matrix4(), _t = new THREE.Matrix4();
function valueOf(a, P) {
  let v = a.prop ? Number(P(a.prop)) || 0 : 0;
  if (a.table) {
    const t = a.table;
    if (v <= t[0][0]) v = t[0][1];
    else if (v >= t[t.length - 1][0]) v = t[t.length - 1][1];
    else for (let k = 1; k < t.length; k++) if (v <= t[k][0]) { const f = (v - t[k - 1][0]) / (t[k][0] - t[k - 1][0]); v = t[k - 1][1] + f * (t[k][1] - t[k - 1][1]); break; }
  } else {
    if (a.type === 'textranslate' && a.step) {
      // Drum counters: step through digits, rolling over only near the end of each step.
      const s = a.step, sc = a.scroll ?? 0;
      const base = Math.floor(v / s), rem = v - base * s;
      v = base + (sc > 0 && rem > s - sc ? (rem - (s - sc)) / sc : 0);
      v = v * a.factor + a.offset;
    } else v = v * a.factor + a.offset;
  }
  if (a.min !== null) v = Math.max(a.min, v);
  if (a.max !== null) v = Math.min(a.max, v);
  return v;
}

function updateAnimations(anims, P, dt) {
  for (const a of anims) {
    if (a.type === 'select') {
      const vis = a.cond ? a.cond(P) : true;
      for (const n of a.nodes) n.visible = vis;
      continue;
    }
    if (a.cond && !a.cond(P)) continue; // FlightGear freezes the animation when its condition is false
    if (a.type === 'textranslate') {
      const v = valueOf(a, P);
      for (const m of a.materials) m.map.offset.set(a.texAxis[0] * v, a.texAxis[1] * v);
      continue;
    }
    let v;
    if (a.type === 'spin') { a.spin += (Number(P(a.prop)) || 0) * a.factor * 6 * dt; v = a.spin; }
    else v = valueOf(a, P);
    if (a.type === 'translate' || a.type === 'slider') _m.makeTranslation(a.axis.x * v, a.axis.y * v, a.axis.z * v);
    else {
      _m.makeTranslation(a.center.x, a.center.y, a.center.z)
        .multiply(_t.makeRotationAxis(a.axis, v * DEG))
        .multiply(_t.makeTranslation(-a.center.x, -a.center.y, -a.center.z));
    }
    for (const n of a.nodes) { n.matrix.copy(_m); n.matrixWorldNeedsUpdate = true; }
  }
}
