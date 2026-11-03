// Sky dome, time-of-day lighting, a shadow that follows the aircraft, and clouds.
// `env` holds the shared sun/sky colours that the water shader also reads.

import * as THREE from 'three';

const PRESETS = {
  morning: { elev: 14, az: 95, sun: '#ffd2a0', sunI: 2.3, hemiSky: '#c9d8f0', hemiGround: '#5e5a48', hemiI: 0.9,
    horizon: '#efd3b8', zenith: '#5182c4', cloud: '#fff0e2', fog: [2500, 30000] },
  noon: { elev: 55, az: 160, sun: '#fff3e0', sunI: 2.7, hemiSky: '#cfe3ff', hemiGround: '#6b7350', hemiI: 1.05,
    horizon: '#c6dbee', zenith: '#3b74c0', cloud: '#ffffff', fog: [3500, 40000] },
  evening: { elev: 9, az: 262, sun: '#ffb070', sunI: 2.2, hemiSky: '#c4bfdc', hemiGround: '#5a4c3e', hemiI: 0.85,
    horizon: '#f2a875', zenith: '#3a5590', cloud: '#ffd2b0', fog: [2000, 26000] },
  // At night the "sun" is a full moon: dim, blue-white light.
  night: { elev: 38, az: 200, sun: '#b4c6ee', sunI: 0.95, hemiSky: '#3d5486', hemiGround: '#141a24', hemiI: 0.75,
    horizon: '#101b30', zenith: '#02050d', cloud: '#56607a', fog: [1500, 24000], night: true },
};
export const TIMES_OF_DAY = Object.keys(PRESETS);

export function createSky(scene) {
  const env = {
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(),
    night: false,
    horizon: new THREE.Color(),
    zenith: new THREE.Color(),
  };
  scene.fog = new THREE.Fog(0xffffff, 3000, 38000);
  scene.background = new THREE.Color();

  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      horizon: { value: env.horizon }, zenith: { value: env.zenith },
      sunDir: { value: env.sunDir }, sunColor: { value: env.sunColor }, stars: { value: 0 },
      hazeColor: { value: new THREE.Color() }, haze: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 horizon, zenith, sunDir, sunColor, hazeColor;
      uniform float stars, haze;
      varying vec3 vDir;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        vec3 col = mix(horizon, zenith, pow(up, 0.5));
        float s = max(dot(d, sunDir), 0.0);
        // Warm glow around the sun that hugs the horizon when the sun is low.
        float low = 1.0 - smoothstep(0.0, 0.5, sunDir.y);
        col += sunColor * (pow(s, 8.0) * (0.12 + 0.35 * low) * (1.0 - up * 0.7));
        col += sunColor * (pow(s, 1200.0) * 6.0 + pow(s, 60.0) * 0.3);
        if (stars > 0.0 && d.y > 0.0) {
          // Procedural star field: one possible star per cell of a grid around the sky.
          vec3 p = d * 230.0;
          vec3 c = floor(p);
          float h = hash(c);
          if (h > 0.982) {
            float dd = length(fract(p) - 0.5);
            float b = smoothstep(0.32, 0.0, dd) * (0.4 + 0.6 * (h - 0.982) / 0.018);
            col += vec3(0.9, 0.93, 1.0) * b * stars * smoothstep(0.0, 0.2, d.y);
          }
        }
        if (d.y < 0.0) col = mix(col, horizon * 0.82, min(-d.y * 5.0, 1.0));
        // Under an overcast, inside cloud or in fog the sky is a flat grey.
        col = mix(col, hazeColor * (0.92 + 0.08 * up), haze);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  scene.add(dome);

  const hemi = new THREE.HemisphereLight();
  scene.add(hemi);

  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -35; sc.right = 35; sc.top = 35; sc.bottom = -35; sc.near = 1; sc.far = 600;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);

  const clouds = buildClouds();
  scene.add(clouds.group);

  // ---------- Overcast cloud deck and fog ----------
  const deckTex = deckTexture();
  const deckMat = (c) => new THREE.MeshBasicMaterial({ map: deckTex, color: c, side: THREE.DoubleSide, fog: true });
  const deckBottom = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000).rotateX(-Math.PI / 2), deckMat(0x9aa2ab));
  const deckTop = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000).rotateX(-Math.PI / 2), deckMat(0xffffff));
  deckBottom.visible = deckTop.visible = false;
  scene.add(deckBottom, deckTop);
  const LAYERS = { overcast: [450, 1050], low: [200, 900] };
  let cloudMode = 'scattered';
  // Base (clear-sky) values for the current time of day, blended per frame.
  const base = { horizon: new THREE.Color(), zenith: new THREE.Color(), sun: new THREE.Color(), sunI: 1, hemiI: 1, fog: [3000, 38000], hemiSky: new THREE.Color() };
  const grey = new THREE.Color(), tmp = new THREE.Color();

  function setTimeOfDay(name) {
    const p = PRESETS[name] ?? PRESETS.noon;
    const e = p.elev * Math.PI / 180, a = p.az * Math.PI / 180;
    env.sunDir.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
    env.sunColor.set(p.sun);
    env.horizon.set(p.horizon);
    env.zenith.set(p.zenith);
    sun.color.set(p.sun);
    sun.intensity = p.sunI;
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemiI;
    scene.fog.color.copy(env.horizon);
    scene.fog.near = p.fog[0];
    scene.fog.far = p.fog[1];
    scene.background.copy(env.horizon);
    clouds.tint(new THREE.Color(p.cloud), p.night ? 10 : p.elev);
    base.horizon.copy(env.horizon); base.zenith.copy(env.zenith); base.sun.copy(env.sunColor);
    base.sunI = p.sunI; base.hemiI = p.hemiI; base.fog = p.fog; base.hemiSky.set(p.hemiSky);
    env.night = !!p.night;
    domeMat.uniforms.stars.value = p.night ? 1.2 : 0;
  }

  return {
    env,
    setTimeOfDay,
    setShadows(on) { sun.castShadow = on; },
    // 'clear', 'scattered', 'overcast' (base 1,500 ft), 'low' (base 650 ft) or 'fog'.
    setClouds(mode) {
      cloudMode = mode;
      clouds.group.visible = mode === 'scattered';
      const layer = LAYERS[mode];
      deckBottom.visible = deckTop.visible = !!layer;
      if (layer) { deckBottom.position.y = layer[0]; deckTop.position.y = layer[1]; }
    },
    get cloudMode() { return cloudMode; },
    update(camera, focus) {
      dome.position.copy(camera.position);
      // Blend lighting, fog and sky for the weather around the camera.
      const h = camera.position.y;
      const lum = base.horizon.r * 0.3 + base.horizon.g * 0.55 + base.horizon.b * 0.15;
      grey.setRGB(lum, lum, lum * 1.04).multiplyScalar(0.9);
      let below = 0, inside = 0, fogNear = base.fog[0], fogFar = base.fog[1];
      const layer = LAYERS[cloudMode];
      if (layer) {
        deckBottom.position.x = deckTop.position.x = camera.position.x;
        deckBottom.position.z = deckTop.position.z = camera.position.z;
        // The deck follows the camera; shift its texture so the clouds stay fixed in the world.
        deckTex.offset.set((camera.position.x / 1500) % 1, (-camera.position.z / 1500) % 1);
        const [b, t] = layer;
        below = 1 - smooth(b - 60, b + 10, h);
        inside = smooth(b - 30, b + 30, h) * (1 - smooth(t - 30, t + 30, h));
        fogNear = 300 * below; fogFar = 6000 + (layer === LAYERS.low ? 0 : 3000);
        if (h > t) { fogNear = base.fog[0]; fogFar = base.fog[1]; }
        deckBottom.material.color.copy(grey).multiplyScalar(0.85);
        deckTop.material.color.copy(base.sun).multiplyScalar(env.night ? 0.35 : 1);
      } else if (cloudMode === 'fog') {
        const clear = smooth(60, 450, h);
        below = 1 - clear * 0.75;
        fogNear = 0; fogFar = 900 + clear * 14000;
        grey.multiplyScalar(1.12);
      }
      // Inside cloud: white-out at a few dozen metres.
      if (inside > 0.01) { fogNear = 0; fogFar = fogFar + (90 - fogFar) * inside; }
      const haze = Math.max(below, inside);
      tmp.copy(grey).lerp(new THREE.Color(lum * 1.15, lum * 1.15, lum * 1.18), inside);
      domeMat.uniforms.hazeColor.value.copy(tmp);
      domeMat.uniforms.haze.value = haze;
      env.horizon.copy(base.horizon).lerp(tmp, haze);
      env.zenith.copy(base.zenith).lerp(tmp, haze);
      env.sunColor.copy(base.sun).multiplyScalar(1 - 0.85 * haze);
      sun.intensity = base.sunI * (1 - 0.8 * haze);
      hemi.intensity = base.hemiI * (1 + 0.25 * haze);
      scene.fog.color.copy(env.horizon);
      scene.background.copy(env.horizon);
      scene.fog.near = fogNear;
      scene.fog.far = fogFar;
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(env.sunDir, 300);
    },
  };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Soft, tiling grey-white texture for the overcast deck.
function deckTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#d8dde2';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 220; i++) {
    const x = Math.random() * S, y = Math.random() * S, r = 8 + Math.random() * 30;
    const v = Math.random() < 0.5 ? 255 : 170;
    for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
      const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      grad.addColorStop(0, `rgba(${v},${v},${v + 5},0.35)`);
      grad.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = grad;
      g.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function cloudTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  for (let i = 0; i < 16; i++) {
    const x = S / 2 + (Math.random() - 0.5) * S * 0.45;
    const y = S / 2 + (Math.random() - 0.5) * S * 0.3;
    const r = S * (0.16 + Math.random() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildClouds() {
  const group = new THREE.Group();
  const tex = [cloudTexture(), cloudTexture(), cloudTexture()];
  // Lit tops, mid and shaded bases.
  const shades = [1.0, 0.86, 0.72];
  const mats = shades.map((v, i) => new THREE.SpriteMaterial({
    map: tex[i], color: new THREE.Color(v, v, v), transparent: true, depthWrite: false, fog: true,
  }));
  let s = 99;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let c = 0; c < 130; c++) {
    const cx = (rnd() - 0.5) * 44000, cz = (rnd() - 0.5) * 44000;
    const cy = 1200 + rnd() * 800;
    const size = 220 + rnd() * 380;
    const puffs = 6 + Math.floor(rnd() * 8);
    for (let p = 0; p < puffs; p++) {
      const top = rnd();
      const sp = new THREE.Sprite(mats[top > 0.55 ? 0 : top > 0.2 ? 1 : 2]);
      const k = size * (0.55 + rnd() * 0.7);
      sp.scale.set(k * 1.6, k, 1);
      sp.position.set(cx + (rnd() - 0.5) * size * 2.2, cy + top * size * 0.4, cz + (rnd() - 0.5) * size * 1.4);
      group.add(sp);
    }
  }
  return {
    group,
    tint(color, elev) {
      const bright = 0.75 + 0.25 * Math.min(1, elev / 40);
      mats.forEach((m, i) => m.color.copy(color).multiplyScalar(shades[i] * bright));
    },
  };
}
