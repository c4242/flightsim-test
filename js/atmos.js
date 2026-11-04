// Aerial perspective: replaces three.js's distance fog for every material with haze whose density
// falls off exponentially with height (scale height about 1.8 km). The fog amount is integrated
// along each line of sight, so from high up the air is clear, while the ground far below and
// distant low terrain still fade into the haze. fogNear / fogFar keep their meaning at sea level.
// When visibility is very short (inside cloud or fog) the height falloff is switched off.
//
// Must be imported before anything is rendered: three.js caches compiled programs by material
// type and parameters, not by shader text.

import * as THREE from 'three';

const C = THREE.ShaderChunk;

C.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif`;

C.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // View space back to world space (the view matrix is a rigid transform).
  vFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;

C.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

C.fog_fragment = /* glsl */`
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogDist = length(vFogWorld - cameraPosition);
    // Scale height of the haze; effectively infinite when visibility is very short (cloud, fog).
    float fogH = mix(1.0e6, 1800.0, smoothstep(1500.0, 6000.0, fogFar));
    float fogH0 = max(cameraPosition.y, 0.0), fogH1 = max(vFogWorld.y, 0.0);
    float fogDh = fogH1 - fogH0;
    float fogMean = abs(fogDh) > 1.0
      ? fogH * (exp(-fogH0 / fogH) - exp(-fogH1 / fogH)) / fogDh
      : exp(-fogH0 / fogH);
    float fogB = 3.0 / max(fogFar - fogNear, 1.0);
    float fogFactor = 1.0 - exp(-fogB * max(fogDist - fogNear, 0.0) * fogMean);
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

export const AERIAL_PERSPECTIVE = true;
