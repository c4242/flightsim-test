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
};
export const TIMES_OF_DAY = Object.keys(PRESETS);

export function createSky(scene) {
  const env = {
    sunDir: new THREE.Vector3(0, 1, 0),
    sunColor: new THREE.Color(),
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
      sunDir: { value: env.sunDir }, sunColor: { value: env.sunColor },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 horizon, zenith, sunDir, sunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        vec3 col = mix(horizon, zenith, pow(up, 0.5));
        float s = max(dot(d, sunDir), 0.0);
        // Warm glow around the sun that hugs the horizon when the sun is low.
        float low = 1.0 - smoothstep(0.0, 0.5, sunDir.y);
        col += sunColor * (pow(s, 8.0) * (0.12 + 0.35 * low) * (1.0 - up * 0.7));
        col += sunColor * (pow(s, 1200.0) * 6.0 + pow(s, 60.0) * 0.3);
        if (d.y < 0.0) col = mix(col, horizon * 0.82, min(-d.y * 5.0, 1.0));
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
    clouds.tint(new THREE.Color(p.cloud), p.elev);
  }

  return {
    env,
    setTimeOfDay,
    setShadows(on) { sun.castShadow = on; },
    update(camera, focus) {
      dome.position.copy(camera.position);
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(env.sunDir, 300);
    },
  };
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
