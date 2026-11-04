// Post-processing: the scene is rendered to an HDR, multisampled target; bright parts (the sun,
// afterburner, lights, sun glints on water) bloom; then filmic tone mapping, sRGB output and a
// subtle vignette. On low quality the scene is rendered directly instead.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.22 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - amount * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      gl_FragColor = c;
    }`,
};

// Heat shimmer: displaces the image inside a tapering band along the exhaust's on-screen path.
const HeatShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uA: { value: new THREE.Vector2() }, uB: { value: new THREE.Vector2() },
    uWidth: { value: 0 }, uStrength: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: VignetteShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uWidth, uStrength;
    uniform vec2 uA, uB, uRes;
    varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
    void main() {
      vec2 uv = vUv;
      if (uStrength > 0.0) {
        vec2 p = vUv * uRes, ab = uB - uA;
        float t = clamp(dot(p - uA, ab) / max(dot(ab, ab), 1.0), 0.0, 1.0);
        float d = length(p - (uA + ab * t));
        float w = uWidth * (0.6 + 1.4 * t);                       // the hot jet widens downstream
        float k = (1.0 - smoothstep(0.3 * w, w, d)) * (1.0 - t) * smoothstep(0.0, 0.05, t) * uStrength;
        if (k > 0.001) {
          // Ripples flow away from the nozzle.
          vec2 q = p / max(uWidth * 0.35, 2.0) - normalize(ab + 1e-4) * uTime * 9.0;
          vec2 off = vec2(n2(q) - 0.5, n2(q + 17.3) - 0.5);
          uv += off * k * max(uWidth * 0.45, 6.0) / uRes;
        }
      }
      gl_FragColor = texture2D(tDiffuse, uv);
    }`,
};

export function createPost(renderer, scene, camera, { enabled = true } = {}) {
  if (!enabled) {
    return {
      render: () => renderer.render(scene, camera),
      setSize() {}, setPixelRatio() {}, setHeat() {}, enabled: false,
    };
  }
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const heat = new ShaderPass(HeatShader);
  composer.addPass(heat);
  // strength, radius, threshold (in linear HDR units: only things brighter than white bloom).
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.6, 0.45, 1.5);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass(VignetteShader));
  return {
    enabled: true,
    bloom, heat,
    render: () => composer.render(),
    setSize(w, h) { composer.setSize(w, h); },
    // a, b: nozzle and plume end in CSS pixels (y down); width in pixels; strength 0..1.
    setHeat(a, b, width, strength, dt) {
      const u = heat.uniforms, r = renderer.getPixelRatio();
      u.uTime.value += dt;
      u.uRes.value.set(innerWidth * r, innerHeight * r);
      u.uA.value.set(a[0] * r, (innerHeight - a[1]) * r);
      u.uB.value.set(b[0] * r, (innerHeight - b[1]) * r);
      u.uWidth.value = width * r;
      u.uStrength.value = strength;
      heat.enabled = strength > 0.001;
    },
    setPixelRatio(r) { composer.setPixelRatio(r); },
  };
}
