// Shared state for cumulus shadows on the ground. The sky builds a top-down map of cloud cover;
// terrain, buildings and trees darken their sunlight where the sun ray towards them passes through
// a cloud. The map is sampled at the point where that ray crosses the cloud layer.

import * as THREE from 'three';

export const CLOUD_EXTENT = 48000;   // metres covered by the map (centred on the origin)
export const CLOUD_LAYER = 1650;     // representative height of the cumulus (m)

export const cloudShadow = {
  map: { value: null },
  strength: { value: 0 },            // 0 = no clouds, ~0.75 = dense cumulus in full sun
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  drift: { value: new THREE.Vector2() },         // how far the wind has carried the clouds (x, z)
  cover: { value: new THREE.Vector3(1, 1, 1) }, // how much of each coverage bucket is showing
};

// GLSL: returns the fraction of direct sunlight that reaches world position p.
export const CLOUD_SHADOW_GLSL = /* glsl */`
  uniform sampler2D cloudShadowMap;
  uniform float cloudShadowStrength;
  uniform vec3 cloudShadowSun, cloudShadowCover;
  uniform vec2 cloudShadowDrift;
  float cloudSun(vec3 p) {
    if (cloudShadowStrength <= 0.0 || cloudShadowSun.y <= 0.02) return 1.0;
    vec2 q = p.xz + cloudShadowSun.xz * max(0.0, ${CLOUD_LAYER.toFixed(1)} - p.y) / cloudShadowSun.y;
    vec2 uv = (q - cloudShadowDrift) / ${CLOUD_EXTENT.toFixed(1)} + 0.5;   // the map repeats
    // Above the cloud layer nothing shades you.
    float above = smoothstep(${(CLOUD_LAYER - 300).toFixed(1)}, ${(CLOUD_LAYER + 300).toFixed(1)}, p.y);
    return 1.0 - cloudShadowStrength * min(1.0, dot(texture2D(cloudShadowMap, uv).rgb, cloudShadowCover)) * (1.0 - above);
  }`;

export function cloudShadowUniforms(sh) {
  sh.uniforms.cloudShadowMap = cloudShadow.map;
  sh.uniforms.cloudShadowStrength = cloudShadow.strength;
  sh.uniforms.cloudShadowSun = cloudShadow.sunDir;
  sh.uniforms.cloudShadowCover = cloudShadow.cover;
  sh.uniforms.cloudShadowDrift = cloudShadow.drift;
}
