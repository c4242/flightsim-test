// Jet exhaust: a ray-marched volumetric afterburner plume with shock diamonds, a hot nozzle
// throat, and an orange light that the flame casts on the aircraft and the ground.
//
// The plume is drawn on the back faces of a bounding cylinder behind the nozzle. For each pixel
// the shader marches along the view ray through the cylinder and accumulates emitted light from
// an analytic flame: a blue-white core, orange-red outer flame, turbulent flicker and a row of
// bright Mach disks (shock diamonds). The output is HDR so it blooms.

import * as THREE from 'three';

const BOX_R = 0.7;   // bounding cylinder radius (m)
const BOX_L = 11;    // bounding cylinder length (m)

const vertexShader = /* glsl */`
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const fragmentShader = /* glsl */`
  uniform float uTime, uAb, uLen, uRadius, uDiamonds, uDry;
  uniform vec3 uCam;
  varying vec3 vLocal;

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }

  float gDensity; // flame density at the last emission() sample (for occlusion)

  // Emitted light at a point (z aft of the nozzle exit, r from the axis).
  vec3 emission(vec3 p) {
    float z = p.z;
    gDensity = 0.0;
    if (z < 0.0 || z > uLen) return vec3(0.0);
    float t = z / uLen;
    float r = length(p.xy);
    float Rn = uRadius;
    // Turbulence advected aft with the gas; stronger and coarser downstream.
    float n = noise(vec3(p.xy * 3.5, z * 1.4 - uTime * 30.0)) * 0.6 + noise(vec3(p.xy * 8.0, z * 3.0 - uTime * 50.0)) * 0.4;
    float wob = 1.0 + (n - 0.5) * (0.15 + 0.6 * t);
    // Shock cells: the jet repeatedly over-expands and pinches, about 1.1 nozzle diameters apart.
    float cell = Rn * 2.2;
    float k = z / cell;
    float pinch = 1.0 - 0.18 * (1.0 - t) * (0.5 + 0.5 * cos(6.2832 * (k - 0.55)));
    // Outer flame: a tapering cone, widening slightly as it mixes, ending in a ragged tip.
    float R = Rn * (1.0 - 0.55 * t) * pinch * wob + Rn * 0.25 * t;
    float edge = smoothstep(R, R * 0.55, r);
    float tail = smoothstep(1.0, 0.55 + 0.25 * n, t);
    float body = edge * tail;
    // Bright potential core right behind the nozzle.
    float core = smoothstep(Rn * 0.6, 0.0, r) * exp(-z / (Rn * 1.1));
    // Shock diamonds: bright lens-shaped kernels on the axis, shrinking and fading downstream.
    float ki = floor(k - 0.15) + 0.65;
    float dz = (k - ki) * cell;
    float kr = Rn * 0.55 * exp(-ki * 0.12);
    float diamond = exp(-pow(dz / (Rn * 0.22), 2.0) - pow(r / kr, 2.0) * 1.8) * exp(-ki * 0.38) * step(0.3, k) * step(ki, 6.0);
    // Colours: bluish-violet sheath near the nozzle, yellow-orange body, red-orange tail.
    vec3 hot = vec3(1.0, 0.58, 0.18);
    vec3 warm = vec3(1.0, 0.36, 0.06);
    vec3 cool = vec3(0.8, 0.16, 0.03);
    vec3 flame = mix(hot, warm, smoothstep(0.05, 0.5, t));
    flame = mix(flame, cool, smoothstep(0.5, 1.0, t));
    float sheath = smoothstep(R * 0.6, R, r) * (1.0 - smoothstep(0.0, 0.35, t));
    flame = mix(flame, vec3(0.45, 0.35, 1.0), sheath * 0.6);
    gDensity = (body * (0.7 + 0.6 * n) + core) * uAb;
    vec3 col = flame * body * (0.4 + 0.8 * n) * 1.15
             + vec3(1.0, 0.82, 0.55) * core * 1.4
             + vec3(1.0, 0.85, 0.5) * diamond * uDiamonds * 9.0;
    return col * uAb;
  }

  void main() {
    // Ray from the camera (in the plume's local frame) to this back-face point.
    vec3 ro = uCam;
    vec3 rd = normalize(vLocal - ro);
    float tExit = length(vLocal - ro);
    // Entry: intersect with the bounding cylinder (axis z, 0..L), clamped to the camera.
    float a = dot(rd.xy, rd.xy), b = dot(ro.xy, rd.xy), c = dot(ro.xy, ro.xy) - ${(BOX_R * BOX_R).toFixed(4)};
    float tIn = 0.0;
    if (a > 1e-6) { float h = b * b - a * c; if (h > 0.0) tIn = max(tIn, (-b - sqrt(h)) / a); }
    if (abs(rd.z) > 1e-6) { float t0 = (0.0 - ro.z) / rd.z, t1 = (${BOX_L.toFixed(1)} - ro.z) / rd.z; tIn = max(tIn, min(t0, t1)); }
    tIn = clamp(tIn, 0.0, tExit);
    const int STEPS = 40;
    float dt = (tExit - tIn) / float(STEPS);
    vec3 sum = vec3(0.0);
    float depth = 0.0;
    // Jitter the start to hide banding.
    float j = hash(vec3(gl_FragCoord.xy, uTime));
    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * (tIn + (float(i) + j) * dt);
      // Light from deeper in the plume is partly hidden by the flame in front of it.
      sum += emission(p) * dt * exp(-depth * 0.35);
      depth += gDensity * dt;
    }
    // Soft roll-off: looking down the plume's length saturates instead of blowing out to white,
    // while the thinner side view keeps most of its brightness. Still HDR so the hot core blooms.
    vec3 glow = sum * 2.2;
    glow = glow / (1.0 + 0.25 * max(max(glow.r, glow.g), glow.b));
    // Premultiplied output: the flame hides part of the background (alpha) and adds its own light.
    float alpha = clamp(1.0 - exp(-depth * 4.0), 0.0, 0.85);
    gl_FragColor = vec4(glow, alpha);
  }`;

export function createExhaust({ nozzleRadius = 0.4 } = {}) {
  const group = new THREE.Group();
  const uniforms = {
    uTime: { value: 0 }, uAb: { value: 0 }, uLen: { value: 5 }, uRadius: { value: nozzleRadius },
    uDiamonds: { value: 1 }, uDry: { value: 0 }, uCam: { value: new THREE.Vector3() },
  };
  const plumeMat = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const geo = new THREE.CylinderGeometry(BOX_R, BOX_R, BOX_L, 20, 1, false).rotateX(Math.PI / 2).translate(0, 0, BOX_L / 2);
  const plume = new THREE.Mesh(geo, plumeMat);
  plume.frustumCulled = false;
  plume.renderOrder = 10;
  group.add(plume);

  // Nozzle throat: glows orange-white in afterburner, dull red at high dry power.
  const throatMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const throat = new THREE.Mesh(new THREE.CircleGeometry(nozzleRadius * 0.95, 24), throatMat);
  throat.position.z = -0.25;
  group.add(throat);

  // Light from the flame (kept in the scene at zero intensity so shaders don't recompile).
  const light = new THREE.PointLight(0xff9040, 0, 60, 2);
  // A few metres behind the nozzle, so it lights the aircraft from behind rather than up close.
  light.position.z = 6.0;
  group.add(light);

  const _inv = new THREE.Matrix4();
  const hot = new THREE.Color();
  return {
    object: group,
    // ab: afterburner level 0..1 (0 = not lit); n2: core RPM fraction; mach and altitude shape the plume.
    update(dt, camera, { ab = 0, n2 = 0, mach = 0, altitude = 0, night = false } = {}) {
      uniforms.uTime.value += dt;
      const lit = ab > 0.005;
      const flicker = 0.92 + 0.08 * Math.sin(uniforms.uTime.value * 57) * Math.sin(uniforms.uTime.value * 23);
      uniforms.uAb.value = lit ? (0.45 + 0.55 * ab) * flicker : 0;
      // Longer, more defined plume at low altitude and low speed; shorter and fainter high and fast.
      const thin = Math.min(1, Math.max(0, altitude / 12000));
      uniforms.uLen.value = (3.8 + 4.6 * ab) * (1 - 0.25 * thin) * (1 - 0.15 * Math.min(1, mach));
      uniforms.uDiamonds.value = (1 - 0.6 * thin) * Math.min(1, 0.3 + ab);
      plume.visible = lit;
      group.updateMatrixWorld();
      uniforms.uCam.value.copy(camera.position).applyMatrix4(_inv.copy(group.matrixWorld).invert());
      // Throat glow.
      const heat = lit ? 1 : Math.max(0, (n2 - 0.85) / 0.15) * 0.25;
      hot.setRGB(1.0, 0.45 + 0.35 * (lit ? ab : 0), 0.15 + 0.4 * (lit ? ab : 0)).multiplyScalar(heat * (lit ? 3.0 : 1.2));
      throatMat.color.copy(hot);
      throat.visible = heat > 0.01;
      // Flame light: much more noticeable at night.
      light.intensity = lit ? (night ? 45 : 12) * (0.5 + 0.5 * ab) * flicker : 0;
    },
  };
}
