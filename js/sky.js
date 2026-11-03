// Sky dome, sun lighting with a shadow that follows the aircraft, and clouds.

import * as THREE from 'three';

export const SUN_DIR = new THREE.Vector3(-0.45, 0.62, -0.38).normalize();
const HORIZON = new THREE.Color('#c9dcec');
const ZENITH = new THREE.Color('#3f78c0');

export function createSky(scene) {
  scene.fog = new THREE.Fog(HORIZON.clone(), 3000, 38000);
  scene.background = HORIZON.clone();

  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      horizon: { value: HORIZON.clone() },
      zenith: { value: ZENITH.clone() },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 horizon, zenith, sunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float up = max(d.y, 0.0);
        vec3 col = mix(horizon, zenith, pow(up, 0.55));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.92, 0.75) * (pow(s, 900.0) * 4.0 + pow(s, 40.0) * 0.25 + pow(s, 6.0) * 0.08);
        if (d.y < 0.0) col = mix(horizon, horizon * 0.85, min(-d.y * 4.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  scene.add(dome);

  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b7350, 1.1);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 400;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);

  const clouds = buildClouds();
  scene.add(clouds);

  return {
    update(camera, focus) {
      dome.position.copy(camera.position);
      sun.target.position.copy(focus);
      sun.position.copy(focus).addScaledVector(SUN_DIR, 200);
    },
  };
}

function cloudTexture() {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const x = S / 2 + (Math.random() - 0.5) * S * 0.45;
    const y = S / 2 + (Math.random() - 0.5) * S * 0.3;
    const r = S * (0.18 + Math.random() * 0.16);
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
  const tex = cloudTexture();
  const mats = [0.95, 0.88, 0.8].map((v) => new THREE.SpriteMaterial({
    map: tex, color: new THREE.Color(v, v, v * 1.02), transparent: true, depthWrite: false, fog: true,
  }));
  let s = 99;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let c = 0; c < 110; c++) {
    const cx = (rnd() - 0.5) * 40000, cz = (rnd() - 0.5) * 40000;
    const cy = 1100 + rnd() * 700;
    const size = 250 + rnd() * 350;
    const puffs = 5 + Math.floor(rnd() * 7);
    for (let p = 0; p < puffs; p++) {
      const top = rnd();
      const sp = new THREE.Sprite(mats[top > 0.6 ? 0 : top > 0.25 ? 1 : 2]);
      const k = size * (0.6 + rnd() * 0.7);
      sp.scale.set(k * 1.6, k, 1);
      sp.position.set(cx + (rnd() - 0.5) * size * 2.2, cy + top * size * 0.35, cz + (rnd() - 0.5) * size * 1.4);
      group.add(sp);
    }
  }
  return group;
}
