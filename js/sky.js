// Sky dome, time-of-day lighting, a shadow that follows the aircraft, and clouds.
// `env` holds the shared sun/sky colours that the water shader also reads.

import * as THREE from 'three';
import { cloudShadow, CLOUD_EXTENT } from './cloudshadow.js';

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

export function createSky(scene, renderer) {
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
      groundColor: { value: new THREE.Color(0.12, 0.14, 0.1) }, envMode: { value: 0 }, sunDisc: { value: 1 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 horizon, zenith, sunDir, sunColor, hazeColor, groundColor;
      uniform float stars, haze, envMode, sunDisc;
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
        col += sunColor * (pow(s, 1200.0) * 6.0 * sunDisc + pow(s, 60.0) * 0.3 * sunDisc);
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
        if (d.y < 0.0) col = mix(col, envMode > 0.5 ? groundColor : horizon * 0.82, min(-d.y * (envMode > 0.5 ? 8.0 : 5.0), 1.0));
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

  // ---------- Image-based lighting ----------
  // A blurred copy of the current sky (with dark ground below the horizon) used as the
  // environment map, so metal, paint and glass pick up realistic reflections.
  const pmrem = renderer ? new THREE.PMREMGenerator(renderer) : null;
  const envScene = new THREE.Scene();
  const envMat = domeMat.clone();
  envMat.uniforms.envMode.value = 1;
  const envDome = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), envMat);
  envDome.frustumCulled = false;
  envScene.add(envDome);
  let envRT = null, envHaze = -1, envTimer = 0;
  function updateEnvironment() {
    if (!pmrem) return;
    for (const k of ['horizon', 'zenith', 'sunDir', 'sunColor', 'hazeColor']) envMat.uniforms[k].value.copy(domeMat.uniforms[k].value);
    envMat.uniforms.sunDisc.value = domeMat.uniforms.sunDisc.value;
    envMat.uniforms.haze.value = domeMat.uniforms.haze.value;
    envMat.uniforms.stars.value = 0;
    // Ground seen from the air: dark green-grey, scaled by the overall light level.
    const lum = env.horizon.r * 0.3 + env.horizon.g * 0.55 + env.horizon.b * 0.15;
    envMat.uniforms.groundColor.value.setRGB(0.16 * lum + 0.02, 0.19 * lum + 0.02, 0.13 * lum + 0.02);
    const rt = pmrem.fromScene(envScene, 0.04, 0.1, 100);
    if (envRT) envRT.dispose();
    envRT = rt;
    scene.environment = rt.texture;
    envHaze = domeMat.uniforms.haze.value;
  }

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
  cloudShadow.map.value = clouds.shadowTexture();
  let cumulus = 0; // cumulus density around the camera

  // ---------- Overcast cloud deck and fog ----------
  const deckTex = deckTexture();
  const deckMat = (c) => new THREE.MeshBasicMaterial({ map: deckTex, color: c, side: THREE.DoubleSide, fog: true, transparent: true });
  const deckBottom = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000).rotateX(-Math.PI / 2), deckMat(0x9aa2ab));
  const deckTop = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000).rotateX(-Math.PI / 2), deckMat(0xffffff));
  deckBottom.visible = deckTop.visible = false;
  scene.add(deckBottom, deckTop);
  const LAYERS = { overcast: [450, 1050], low: [200, 900], rain: [340, 2100], variable: [420, 1600] };
  // Weather as a continuous state: cumulus coverage, overcast deck opacity, rain, fog.
  const STATES = {
    clear: { cov: 0, deck: 0, rain: 0 }, scattered: { cov: 1, deck: 0, rain: 0 },
    overcast: { cov: 0, deck: 1, rain: 0 }, low: { cov: 0, deck: 1, rain: 0 },
    rain: { cov: 0, deck: 1, rain: 1 }, fog: { cov: 0, deck: 0, rain: 0 },
  };
  // 'variable': a ~16 minute cycle. Fair-weather cumulus build up, an overcast moves in, a rain
  // shower passes, then it clears. [minutes, cumulus cover, deck, rain]
  const CYCLE = [[0, 0.35, 0, 0], [3, 1, 0, 0], [5, 0.6, 0.5, 0], [6.5, 0, 1, 0], [8, 0, 1, 1], [11, 0, 1, 1],
    [12.5, 0, 1, 0], [14, 0.3, 0.4, 0], [15.5, 0.35, 0, 0]];
  const PERIOD = CYCLE[CYCLE.length - 1][0] * 60;
  const wx = { cov: 1, deck: 0, rain: 0 };
  let wxTime = 0;
  function cycleState(t) {
    const m = (t % PERIOD) / 60;
    for (let i = 1; i < CYCLE.length; i++) {
      if (m <= CYCLE[i][0]) {
        const a = CYCLE[i - 1], b = CYCLE[i], k = smooth(a[0], b[0], m);
        wx.cov = a[1] + (b[1] - a[1]) * k; wx.deck = a[2] + (b[2] - a[2]) * k; wx.rain = a[3] + (b[3] - a[3]) * k;
        return;
      }
    }
  }
  let cloudMode = 'scattered';
  let flash = 0;
  const windAloft = new THREE.Vector3();
  const flashColor = new THREE.Color(1.5, 1.55, 2.0);
  // Base (clear-sky) values for the current time of day, blended per frame.
  const base = { horizon: new THREE.Color(), zenith: new THREE.Color(), sun: new THREE.Color(), sunI: 1, hemiI: 1, fog: [3000, 38000], hemiSky: new THREE.Color() };
  const grey = new THREE.Color(), tmp = new THREE.Color(), altZenith = new THREE.Color(), altHorizon = new THREE.Color();

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
    // The moon is far dimmer than the sun: keep its disc from blooming into a glare.
    domeMat.uniforms.sunDisc.value = p.night ? 0.18 : 1;
    envHaze = -1; // regenerate the environment map on the next update
  }

  return {
    env,
    setTimeOfDay,
    setShadows(on) { sun.castShadow = on; },
    // 'clear', 'scattered', 'overcast' (base 1,500 ft), 'low' (base 650 ft), 'rain', 'fog' or
    // 'variable' (changes as you fly).
    setClouds(mode) {
      cloudMode = mode;
      const layer = LAYERS[mode];
      if (layer) { deckBottom.position.y = layer[0]; deckTop.position.y = layer[1]; }
      if (mode === 'variable') { wxTime = 0; cycleState(0); } else Object.assign(wx, STATES[mode] ?? STATES.clear);
      envHaze = -1;
    },
    get cloudMode() { return cloudMode; },
    // Rain intensity 0..1 and whether it's properly raining (wet runways).
    get rain() { return wx.rain; },
    get raining() { return wx.rain > 0.3; },
    get weatherState() { return { ...wx }; },
    // Base and top of the overcast layer (m), or null.
    get cloudLayer() { return LAYERS[cloudMode] ?? null; },
    // Skip ahead through the changing-weather cycle (seconds).
    advanceWeather(sec) { wxTime += sec; },
    setFlash(f) { flash = f; },
    setWind(surface) { windAloft.copy(surface).multiplyScalar(1.6); },
    // 0 = clear sky around the camera, 1 = under overcast / in cloud / in fog.
    get haze() { return domeMat.uniforms.haze.value; },
    // Cumulus density at the camera (0 outside, 1 deep in a cloud).
    get inCloud() { return cumulus; },
    densityAt: (x, y, z) => (wx.cov > 0.01 ? clouds.densityAt(x, y, z, wx.cov) : 0),
    update(camera, focus, dt = 1 / 60) {
      dome.position.copy(camera.position);
      cloudShadow.sunDir.value.copy(env.sunDir);
      if (cloudMode === 'variable') { wxTime += dt; cycleState(wxTime); }
      clouds.setCover(wx.cov);
      // Under a closing overcast there's no direct sun left to cast cumulus shadows.
      cloudShadow.strength.value = wx.cov > 0.01 ? (env.night ? 0.3 : 0.72) * (1 - wx.deck) : 0;
      cloudShadow.cover.value.set(0, 1, 2).multiplyScalar(-1 / 3).addScalar(wx.cov).multiplyScalar(3).clampScalar(0, 1);
      const cp = camera.position;
      const target = wx.cov > 0.01 ? clouds.densityAt(cp.x, cp.y, cp.z, wx.cov) : 0;
      cumulus += (target - cumulus) * Math.min(1, 12 * dt);
      clouds.update(env.sunDir, env.horizon, scene.fog);
      // Cumulus at ~1.5 km move with the wind there: stronger than at the surface.
      cloudShadow.drift.value.x += windAloft.x * dt; cloudShadow.drift.value.y += windAloft.z * dt;
      // Blend lighting, fog and sky for the weather around the camera.
      const h = camera.position.y;
      const lum = base.horizon.r * 0.3 + base.horizon.g * 0.55 + base.horizon.b * 0.15;
      grey.setRGB(lum, lum, lum * 1.04).multiplyScalar(0.9);
      let below = 0, inside = 0, fogNear = base.fog[0], fogFar = base.fog[1];
      const layer = LAYERS[cloudMode];
      const deck = wx.deck;
      deckBottom.visible = deckTop.visible = !!layer && deck > 0.01;
      if (layer && deck > 0.01) {
        deckBottom.position.x = deckTop.position.x = camera.position.x;
        deckBottom.position.z = deckTop.position.z = camera.position.z;
        // The deck follows the camera; shift its texture so the clouds stay fixed in the world.
        deckTex.offset.set((camera.position.x / 1500) % 1, (-camera.position.z / 1500) % 1);
        const [b, t] = layer;
        below = (1 - smooth(b - 60, b + 10, h)) * deck;
        // A broken layer only whites you out once it has closed up.
        inside = smooth(b - 30, b + 30, h) * (1 - smooth(t - 30, t + 30, h)) * smooth(0.45, 1, deck);
        if (h <= t) {
          // Visibility under the deck: a broken layer still lets you see a long way.
          fogNear += (300 * below - fogNear) * deck;
          fogFar += (6000 + (layer === LAYERS.low ? 0 : 3000) - fogFar) * deck;
        }
        const r = wx.rain;
        deckBottom.material.color.copy(grey).multiplyScalar(0.85 - 0.25 * r);
        deckBottom.material.opacity = deckTop.material.opacity = Math.min(1, deck * 1.3);
        if (r > 0) { grey.multiplyScalar(1 - 0.28 * r); fogFar = Math.min(fogFar, below > 0.5 ? fogFar + (5000 - fogFar) * r : fogFar); }
        deckTop.material.color.copy(base.sun).multiplyScalar(env.night ? 0.35 : 1);
      } else if (cloudMode === 'fog') {
        const clear = smooth(60, 450, h);
        below = 1 - clear * 0.75;
        fogNear = 0; fogFar = 900 + clear * 14000;
        grey.multiplyScalar(1.12);
      }
      inside = Math.max(inside, cumulus);
      // Inside cloud: white-out at a few dozen metres.
      if (inside > 0.01) { const k = 1 - (1 - inside) ** 4; fogNear *= 1 - k; fogFar = fogFar + (90 - fogFar) * k; }
      const haze = Math.max(below, inside);
      tmp.copy(grey).lerp(new THREE.Color(lum * 1.15, lum * 1.15, lum * 1.18), inside);
      domeMat.uniforms.hazeColor.value.copy(tmp);
      domeMat.uniforms.haze.value = haze;
      env.horizon.copy(base.horizon).lerp(tmp, haze);
      env.zenith.copy(base.zenith).lerp(tmp, haze);
      // Thinner air higher up: a deeper blue sky and far less haze (most of it is in the lowest few km).
      const alt = smooth(1500, 12000, h) * (1 - haze);
      if (alt > 0) {
        env.zenith.lerp(altZenith.copy(base.zenith).multiplyScalar(env.night ? 0.6 : 0.42), alt * 0.85);
        env.horizon.lerp(altHorizon.copy(base.horizon).lerp(base.zenith, 0.35), alt * 0.6);
      }
      env.sunColor.copy(base.sun).multiplyScalar(1 - 0.85 * haze);
      sun.intensity = base.sunI * (1 - 0.8 * haze);
      hemi.intensity = base.hemiI * (1 + 0.25 * haze);
      // Lightning: the whole sky and cloud base light up blue-white for an instant.
      if (flash > 0.001) {
        hemi.intensity += flash * 2.5;
        env.horizon.lerp(flashColor, Math.min(0.4, flash * 0.3));
        env.zenith.lerp(flashColor, Math.min(0.3, flash * 0.25));
        deckBottom.material.color.lerp(flashColor, Math.min(0.6, flash * 0.45));
      }
      scene.fog.color.copy(env.horizon);
      scene.background.copy(env.horizon);
      scene.fog.near = fogNear;
      scene.fog.far = fogFar;
      // Refresh the reflections when the light has changed noticeably (at most twice a second).
      envTimer -= 1 / 60;
      if (envHaze < 0 || (Math.abs(haze - envHaze) > 0.2 && envTimer <= 0)) { updateEnvironment(); envTimer = 0.5; }
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

// Cumulus built from camera-facing puffs, each shaded as a soft sphere lit by the sun: bright
// sunlit tops, grey bases, light scattering through the thin edges, and a silver lining when
// looking towards the sun. One instanced draw call; fog applied in the shader.
function buildClouds() {
  const puffs = [];
  let s = 99;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let c = 0; c < 200; c++) {
    const cx = (rnd() - 0.5) * 44000, cz = (rnd() - 0.5) * 44000;
    const base = 1200 + rnd() * 800;
    const size = 220 + rnd() * 380;
    const n = 8 + Math.floor(rnd() * 10);
    const cr = (c * 0.6180339887) % 1; // per-cloud value: the cloud shows when coverage exceeds it
    for (let p = 0; p < n; p++) {
      const up = rnd();
      // A flat base and a heaped top: puffs higher up are smaller and nearer the middle.
      const spread = 1 - 0.55 * up;
      const r = size * (0.32 + 0.28 * rnd()) * (1 - 0.3 * up);
      puffs.push([cx + (rnd() - 0.5) * size * 2.0 * spread, base + r * 0.55 + up * size * 0.75, cz + (rnd() - 0.5) * size * 1.4 * spread, r, base, rnd(), cr]);
    }
  }
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(new Float32Array(puffs.flatMap((p) => p.slice(0, 4))), 4));
  geo.setAttribute('aExtra', new THREE.InstancedBufferAttribute(new Float32Array(puffs.flatMap((p) => [p[4], p[5], p[6]])), 3));
  geo.instanceCount = puffs.length;
  const uniforms = {
    sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color(1, 1, 1) },
    ambient: { value: new THREE.Color(0.6, 0.65, 0.75) }, shadeColor: { value: new THREE.Color(0.55, 0.58, 0.65) },
    fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 1e5 }, cover: { value: 1 }, drift: { value: cloudShadow.drift.value },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: /* glsl */`
      attribute vec4 aPuff;   // centre xyz, radius
      attribute vec3 aExtra;  // cloud base height, random, cloud's coverage threshold
      uniform float cover;
      uniform vec2 drift;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying float vBase, vRand, vR, vFade;
      varying vec3 vCentre;
      void main() {
        vUv = position.xy;
        // Clouds drift with the wind and repeat every CLOUD_EXTENT metres; each puff is drawn at
        // the copy nearest the camera, so the sky never runs out of cloud.
        vec3 c = aPuff.xyz;
        c.xz += drift;
        c.xz += ${CLOUD_EXTENT.toFixed(1)} * floor((cameraPosition.xz - c.xz) / ${CLOUD_EXTENT.toFixed(1)} + 0.5);
        vCentre = c;
        // Clouds grow in as the coverage rises past their threshold and shrink away as it falls.
        vFade = clamp((cover - aExtra.z) * 8.0, 0.0, 1.0);
        if (vFade <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vWorld = c + (right * position.x + up * position.y) * aPuff.w * (0.55 + 0.45 * vFade);
        vBase = aExtra.x; vRand = aExtra.y; vR = aPuff.w;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 sunDir, sunColor, ambient, shadeColor, fogColor;
      uniform float fogNear, fogFar;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying float vBase, vRand, vR, vFade;
      varying vec3 vCentre;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        // Lumpy outline from noise, so puffs don't look like discs.
        vec2 q = vUv * 2.2 + vRand * 31.0;
        float lump = n2(q) * 0.5 + n2(q * 2.3) * 0.3 + n2(q * 5.1) * 0.2;
        float r2 = dot(vUv, vUv) * (0.75 + 0.5 * lump);
        if (r2 > 1.0) discard;
        // Sphere normal in view space, then to world space.
        vec3 nv = vec3(vUv, sqrt(max(0.0, 1.0 - min(r2, 1.0))));
        vec3 n = normalize(transpose(mat3(viewMatrix)) * nv);
        vec3 V = normalize(cameraPosition - vWorld);
        float diff = dot(n, sunDir) * 0.5 + 0.5;              // wrapped lighting (light scatters through)
        float height = clamp((vWorld.y - vBase) / max(vR * 2.0, 1.0), 0.0, 1.0);
        vec3 col = mix(shadeColor, sunColor, diff * (0.55 + 0.45 * height)) + ambient * 0.25;
        // Silver lining: thin edges glow when the sun is behind the cloud.
        float back = pow(max(dot(-V, sunDir), 0.0), 6.0);
        col += sunColor * back * (0.25 + 0.35 * smoothstep(0.2, 0.9, r2));
        float alpha = smoothstep(1.0, 0.55, r2) * (0.75 + 0.25 * lump);
        float d = length(vWorld - cameraPosition);
        // Fade a puff out as the camera reaches it, so flying in never shows a flat card;
        // the white-out fog takes over inside the cloud.
        alpha *= smoothstep(0.25, 1.1, length(vCentre - cameraPosition) / vR) * vFade;
        col = mix(col, fogColor, smoothstep(fogNear, fogFar, d));
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh);
  // Spatial grid of puffs for "am I inside a cloud?" queries.
  const GRID = 1000, grid = new Map();
  for (const p of puffs) {
    const x0 = Math.floor((p[0] - p[3]) / GRID), x1 = Math.floor((p[0] + p[3]) / GRID);
    const z0 = Math.floor((p[2] - p[3]) / GRID), z1 = Math.floor((p[2] + p[3]) / GRID);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const k = i * 4096 + j;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
  }
  return {
    group,
    // Cloud density 0..1 at a point: 1 deep inside a puff, fading out towards its edge.
    setCover(c) { uniforms.cover.value = c; group.visible = c > 0.01; },
    densityAt(x, y, z, cover = 1) {
      // Into the drifting, repeating cloud field's own coordinates.
      const E = CLOUD_EXTENT, dr = uniforms.drift.value;
      x -= dr.x; z -= dr.y;
      x -= E * Math.floor(x / E + 0.5); z -= E * Math.floor(z / E + 0.5);
      const list = grid.get(Math.floor(x / GRID) * 4096 + Math.floor(z / GRID));
      if (!list) return 0;
      let d = 0;
      for (const p of list) {
        if (p[6] > cover - 0.06) continue;
        const dx = x - p[0], dy = (y - p[1]) * 1.3, dz = z - p[2];
        const q = Math.sqrt(dx * dx + dy * dy + dz * dz) / p[3];
        if (q < 1) d = Math.max(d, smooth(1, 0.55, q));
      }
      return d;
    },
    // Top-down cover map: soft blobs where the puffs are, used for shadows on the ground.
    shadowTexture() {
      const S = 1024, cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const g = cv.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
      // Clouds are split by coverage threshold into the red, green and blue channels, so the
      // shadows can follow the cumulus as they build up and decay.
      g.globalCompositeOperation = 'lighter';
      const k = S / CLOUD_EXTENT;
      for (const p of puffs) {
        const x = (p[0] / CLOUD_EXTENT + 0.5) * S, y = (p[2] / CLOUD_EXTENT + 0.5) * S, r = p[3] * 0.95 * k;
        const ch = ['255,0,0', '0,255,0', '0,0,255'][Math.min(2, Math.floor(p[6] * 3))];
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(${ch},0.45)`);
        grad.addColorStop(0.6, `rgba(${ch},0.3)`);
        grad.addColorStop(1, `rgba(${ch},0)`);
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.anisotropy = 4;
      return tex;
    },
    tint(color, elev) {
      const bright = 0.7 + 0.3 * Math.min(1, elev / 40);
      uniforms.sunColor.value.copy(color).multiplyScalar(1.05 * bright);
      uniforms.shadeColor.value.copy(color).multiplyScalar(0.5 * bright).lerp(new THREE.Color(0.45, 0.5, 0.6), 0.4);
    },
    update(sunDir, horizon, fog) {
      uniforms.sunDir.value.copy(sunDir);
      uniforms.ambient.value.copy(horizon);
      if (fog) { uniforms.fogColor.value.copy(fog.color); uniforms.fogNear.value = fog.near; uniforms.fogFar.value = fog.far; }
    },
  };
}
