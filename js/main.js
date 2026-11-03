import * as THREE from 'three';
import { buildWorld, terrainHeight, RUNWAY } from './terrain.js';
import { createSky } from './sky.js';
import { Aircraft } from './aircraft.js';
import { createAircraftModel } from './model.js';
import { initInput, updateControls, consumePresses, getLook, KEYMAP } from './input.js';
import { createHud } from './hud.js';
import { startAudio, updateAudio, toggleMute, setPaused, playThump, playCrash } from './audio.js';
import { clamp } from './noise.js';

// ---------- Renderer & scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.3, 60000);

buildWorld(scene, renderer);
const sky = createSky(scene);

const aircraft = new Aircraft();
const model = createAircraftModel();
scene.add(model.object);

const hud = createHud(document.getElementById('hud'));
initInput(renderer.domElement);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- Crash effect ----------
const smokeTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
const wreck = { group: new THREE.Group(), puffs: [] };
scene.add(wreck.group);

function startCrashEffect(pos) {
  for (let i = 0; i < 40; i++) {
    const fire = i < 14;
    const mat = new THREE.SpriteMaterial({
      map: smokeTex, transparent: true, depthWrite: false,
      color: fire ? new THREE.Color(1, 0.55 + Math.random() * 0.3, 0.15) : new THREE.Color(0.15, 0.14, 0.13),
      blending: fire ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    const v = new THREE.Vector3((Math.random() - 0.5) * 8, 3 + Math.random() * (fire ? 6 : 10), (Math.random() - 0.5) * 8);
    wreck.group.add(s);
    wreck.puffs.push({ s, v, age: -Math.random() * (fire ? 0.2 : 1.5), life: fire ? 1.2 + Math.random() : 5 + Math.random() * 4, fire });
  }
}

function updateCrashEffect(dt) {
  for (const p of wreck.puffs) {
    p.age += dt;
    if (p.age < 0) { p.s.visible = false; continue; }
    p.s.visible = true;
    const t = p.age / p.life;
    if (t >= 1) {
      if (p.fire) { p.s.visible = false; continue; }
      p.age = 0; p.s.position.copy(aircraft.pos); // keep the wreck smoking
    }
    p.s.position.addScaledVector(p.v, dt);
    const size = (p.fire ? 4 : 6) + t * (p.fire ? 10 : 30);
    p.s.scale.set(size, size, 1);
    p.s.material.opacity = (p.fire ? 1 : 0.75) * (1 - t);
  }
}

function clearCrashEffect() {
  for (const p of wreck.puffs) { wreck.group.remove(p.s); p.s.material.dispose(); }
  wreck.puffs.length = 0;
}

// ---------- Camera ----------
const CAMERA_MODES = ['chase', 'cockpit', 'tower'];
let cameraMode = 'chase';
const chaseQuat = new THREE.Quaternion();
const lookQuat = new THREE.Quaternion();
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.1);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const towerPos = new THREE.Vector3(RUNWAY.width / 2 + 115, RUNWAY.elevation + 22, 240);

function snapCamera() { chaseQuat.copy(aircraft.quat); }

function updateCamera(dt) {
  const look = getLook(dt);
  lookEuler.set(look.pitch, look.yaw, 0);
  lookQuat.setFromEuler(lookEuler);
  let fov = 65;

  if (cameraMode === 'cockpit') {
    fov = 72;
    camera.position.copy(_v.set(0, 0.88, -0.45).applyQuaternion(aircraft.quat).add(aircraft.pos));
    camera.quaternion.copy(aircraft.quat).multiply(lookQuat);
  } else if (cameraMode === 'tower') {
    camera.position.copy(towerPos);
    camera.lookAt(aircraft.pos);
    const dist = camera.position.distanceTo(aircraft.pos);
    fov = clamp(2 * Math.atan(14 / dist) * 180 / Math.PI, 3, 60);
  } else {
    if (!aircraft.crashed) chaseQuat.slerp(aircraft.quat, 1 - Math.exp(-dt * 4));
    _q.copy(chaseQuat).multiply(lookQuat).multiply(tilt);
    camera.position.copy(_v.set(0, 2.2, 14).applyQuaternion(_q).add(aircraft.pos));
    camera.quaternion.copy(_q);
    const ground = Math.max(0, terrainHeight(camera.position.x, camera.position.z)) + 1;
    if (camera.position.y < ground) camera.position.y = ground;
    if (aircraft.crashed) camera.lookAt(aircraft.pos);
  }
  // Buffet when stalling.
  if (aircraft.stalling && cameraMode !== 'tower') {
    camera.rotateX((Math.random() - 0.5) * 0.006);
    camera.rotateY((Math.random() - 0.5) * 0.006);
  }
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  model.object.visible = true;
}

// ---------- Menus ----------
const menu = document.getElementById('menu');
const crashBox = document.getElementById('crash');
const keysTable = document.getElementById('keys');
keysTable.innerHTML = KEYMAP.map(([k, d]) => `<tr><td>${k}</td><td>${d}</td></tr>`).join('');
let paused = true;
let started = false;

function showMenu(show) {
  paused = show;
  menu.classList.toggle('hidden', !show);
  document.getElementById('resume').classList.toggle('hidden', !started);
  setPaused(show);
}

let lastSpawn = 'runway';
function spawn(mode) {
  lastSpawn = mode;
  clearCrashEffect();
  aircraft.reset(mode);
  snapCamera();
  crashBox.classList.add('hidden');
  started = true;
  startAudio();
  showMenu(false);
  hud.clearMessages();
  const hints = {
    runway: 'Runway 36. Throttle up with R, pull back (S) at about 55 kt.',
    approach: 'On final for runway 36. Flaps 15°, aim for the threshold.',
    air: 'Cruising at 3,000 ft. Enjoy the view.',
  };
  hud.message(hints[mode], '#cfe8ff', 6);
}
menu.querySelectorAll('[data-spawn]').forEach((b) => b.addEventListener('click', () => spawn(b.dataset.spawn)));
document.getElementById('resume').addEventListener('click', () => { startAudio(); showMenu(false); });
crashBox.querySelectorAll('[data-spawn]').forEach((b) => b.addEventListener('click', () => spawn(b.dataset.spawn)));

function handlePresses() {
  for (const code of consumePresses()) {
    if (code === 'KeyP' || code === 'Escape') {
      if (started) showMenu(!paused);
    } else if (code === 'Enter') {
      if (!started || aircraft.crashed) spawn(lastSpawn);
    } else if (paused) {
      continue;
    } else if (code === 'KeyC') {
      cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(cameraMode) + 1) % CAMERA_MODES.length];
      snapCamera();
      hud.message(`Camera: ${cameraMode}`, '#fff', 1.5);
    } else if (code === 'KeyG') {
      if (aircraft.flaps < 2) { aircraft.flaps++; hud.message(`Flaps ${[0, 15, 30][aircraft.flaps]}°`, '#7cf', 1.5); }
    } else if (code === 'KeyT') {
      if (aircraft.flaps > 0) { aircraft.flaps--; hud.message(`Flaps ${[0, 15, 30][aircraft.flaps]}°`, '#7cf', 1.5); }
    } else if (code === 'KeyH') {
      hud.togglePanel();
    } else if (code === 'KeyM') {
      hud.message(toggleMute() ? 'Sound off' : 'Sound on', '#fff', 1.5);
    }
  }
}

function handleEvents() {
  for (const e of aircraft.events) {
    if (e.type === 'touchdown') {
      const fpm = Math.round(e.fpm);
      const rating = fpm < 150 ? 'Butter!' : fpm < 350 ? 'Smooth landing' : fpm < 600 ? 'Firm landing' : 'Hard landing';
      hud.message(`${rating} ${fpm} ft/min${e.onRunway ? '' : ' (off the runway)'}`, fpm < 600 ? '#9f6' : '#fc6', 4);
      playThump(0.2 + fpm / 800);
    } else if (e.type === 'crash') {
      playCrash();
      startCrashEffect(aircraft.pos);
      document.getElementById('crashReason').textContent = e.reason;
      setTimeout(() => { if (aircraft.crashed) crashBox.classList.remove('hidden'); }, 1200);
    }
  }
  aircraft.events.length = 0;
}

// ---------- Main loop ----------
const STEP = 1 / 240;
let acc = 0;
let last = performance.now();

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  handlePresses();

  if (!paused) {
    updateControls(aircraft, dt);
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 24) {
      aircraft.step(STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === 24) acc = 0;
    handleEvents();
    updateCrashEffect(dt);
  }

  model.object.position.copy(aircraft.pos);
  model.object.quaternion.copy(aircraft.quat);
  model.update(aircraft, paused ? 0 : dt);
  updateCamera(dt);
  sky.update(camera, aircraft.pos);
  updateAudio(aircraft);
  renderer.render(scene, camera);
  hud.draw(aircraft, camera, cameraMode, paused ? 0 : dt);
  requestAnimationFrame(frame);
}

snapCamera();
showMenu(true);
requestAnimationFrame(frame);

// Handy for debugging from the console.
window.sim = { aircraft, camera, scene };
