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

export function createPost(renderer, scene, camera, { enabled = true } = {}) {
  if (!enabled) {
    return {
      render: () => renderer.render(scene, camera),
      setSize() {}, setPixelRatio() {}, enabled: false,
    };
  }
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  // strength, radius, threshold (in linear HDR units: only things brighter than white bloom).
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.6, 0.45, 1.5);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass(VignetteShader));
  return {
    enabled: true,
    bloom,
    render: () => composer.render(),
    setSize(w, h) { composer.setSize(w, h); },
    setPixelRatio(r) { composer.setPixelRatio(r); },
  };
}
