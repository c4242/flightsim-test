import * as THREE from 'three';
import { buildWorld, terrainHeight, AIRFIELDS, fieldToWorld, runwayAt } from './terrain.js';
import { createSky, TIMES_OF_DAY } from './sky.js';
import { Aircraft, MS_TO_KT } from './aircraft.js';
import { createAircraftModel } from './model.js';
import { initInput, initTouch, updateControls, consumePresses, getLook, KEYMAP, setInputOptions } from './input.js';
import { createHud } from './hud.js';
import { startAudio, updateAudio, toggleMute, setPaused, playThump, playCrash, playChime, setVolume } from './audio.js';
import { Weather, WIND_LEVELS } from './weather.js';
import { Autopilot } from './autopilot.js';
import { Effects } from './effects.js';
import { RingCourse } from './rings.js';
import { SCENARIOS } from './scenarios.js';
import { loadSettings, saveSettings, isTouch } from './settings.js';
import { clamp } from './noise.js';

const settings = loadSettings();
const low = settings.quality === 'low';

// ---------- Renderer & scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, low ? 1 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = !low;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.2, 60000);

const sky = createSky(scene);
sky.setTimeOfDay(settings.timeOfDay);
sky.setShadows(!low);
const world = buildWorld(scene, renderer, sky.env, settings.quality);

const weather = new Weather();
weather.set(settings.wind);
weather.randomise();

const aircraft = new Aircraft();
const model = createAircraftModel();
scene.add(model.object);
const effects = new Effects(scene);
const rings = new RingCourse(scene);
const autopilot = new Autopilot();

const hud = createHud(document.getElementById('hud'));
initInput(renderer.domElement);
setInputOptions({ invertPitch: settings.invertPitch, lookSensitivity: settings.lookSensitivity });
setVolume(settings.volume);
if (isTouch) {
  initTouch(document.getElementById('touch'));
  hud.compact = true;
  hud.togglePanel();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- Camera ----------
const CAMERA_MODES = ['chase', 'cockpit', 'tower', 'flyby'];
let cameraMode = 'chase';
const chaseQuat = new THREE.Quaternion();
const lookQuat = new THREE.Quaternion();
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.1);
const cockpitTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.1);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const towers = [
  new THREE.Vector3(130, AIRFIELDS[0].elevation + 22, 240),
  fieldToWorld(AIRFIELDS[1], -30, 100, AIRFIELDS[1].elevation + 12),
];
const flybyPos = new THREE.Vector3();
let flybyAge = 1e9;
let shake = 0;

function snapCamera() { chaseQuat.copy(aircraft.quat); flybyAge = 1e9; }

function placeFlyby() {
  const dir = _v.copy(aircraft.vel);
  if (dir.lengthSq() < 1) dir.set(0, 0, -1).applyQuaternion(aircraft.quat);
  dir.normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(Math.random() < 0.5 ? -22 : 22);
  flybyPos.copy(aircraft.pos).addScaledVector(dir, Math.max(120, aircraft.speed * 4)).add(side);
  flybyPos.y += 4 + Math.random() * 8;
  flybyPos.y = Math.max(flybyPos.y, Math.max(0, terrainHeight(flybyPos.x, flybyPos.z)) + 2);
  flybyAge = 0;
}

function updateCamera(dt) {
  const look = getLook(dt);
  lookEuler.set(look.pitch, look.yaw, 0);
  lookQuat.setFromEuler(lookEuler);
  let fov = 65;
  model.setCockpitView(cameraMode === 'cockpit');

  if (cameraMode === 'cockpit') {
    fov = 74;
    camera.position.copy(_v.set(0, 0.88, -0.45).applyQuaternion(aircraft.quat).add(aircraft.pos));
    camera.quaternion.copy(aircraft.quat).multiply(cockpitTilt).multiply(lookQuat);
  } else if (cameraMode === 'tower') {
    let best = towers[0];
    for (const t of towers) if (t.distanceTo(aircraft.pos) < best.distanceTo(aircraft.pos)) best = t;
    camera.position.copy(best);
    camera.lookAt(aircraft.pos);
    fov = clamp(2 * Math.atan(14 / camera.position.distanceTo(aircraft.pos)) * 180 / Math.PI, 2, 60);
  } else if (cameraMode === 'flyby') {
    flybyAge += dt;
    const d = flybyPos.distanceTo(aircraft.pos);
    const ahead = _v.subVectors(flybyPos, aircraft.pos).dot(aircraft.vel);
    if (flybyAge > 0.5 && ((ahead < 0 && d > 200) || d > 1200)) placeFlyby();
    camera.position.copy(flybyPos);
    camera.lookAt(aircraft.pos);
    fov = clamp(2 * Math.atan(18 / Math.max(1, d)) * 180 / Math.PI, 10, 60);
  } else {
    if (!aircraft.crashed) chaseQuat.slerp(aircraft.quat, 1 - Math.exp(-dt * 4));
    _q.copy(chaseQuat).multiply(lookQuat).multiply(tilt);
    camera.position.copy(_v.set(0, 2.2, 14).applyQuaternion(_q).add(aircraft.pos));
    camera.quaternion.copy(_q);
    const ground = Math.max(0, terrainHeight(camera.position.x, camera.position.z)) + 1;
    if (camera.position.y < ground) camera.position.y = ground;
    if (aircraft.crashed) camera.lookAt(aircraft.pos);
  }
  // Buffet near the stall, rumble on the ground, jolts from turbulence and landings.
  let s = shake;
  if (aircraft.stalling) s += 0.004;
  if (aircraft.onGround) s += Math.min(0.0015, aircraft.speed * 0.00005) * (runwayAt(aircraft.pos.x, aircraft.pos.z) ? 0.5 : 2);
  if (cameraMode === 'cockpit' || cameraMode === 'chase') {
    s += Math.abs(aircraft.gLoad - 1) * 0.0008;
    if (s > 0) {
      camera.rotateX((Math.random() - 0.5) * s);
      camera.rotateY((Math.random() - 0.5) * s);
    }
  }
  shake *= Math.exp(-dt * 6);
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
}

// ---------- Menus ----------
const menu = document.getElementById('menu');
const crashBox = document.getElementById('crash');
document.getElementById('keys').innerHTML = KEYMAP.map(([k, d]) => `<tr><td>${k}</td><td>${d}</td></tr>`).join('');
const scenarioList = document.getElementById('scenarios');
scenarioList.innerHTML = Object.entries(SCENARIOS)
  .map(([id, s]) => `<button data-spawn="${id}">${s.label}</button>`).join('');
let paused = true;
let started = false;

function fillSelect(id, values, current, label = (v) => v[0].toUpperCase() + v.slice(1)) {
  const el = document.getElementById(id);
  el.innerHTML = values.map((v) => `<option value="${v}" ${v === current ? 'selected' : ''}>${label(v)}</option>`).join('');
  return el;
}
fillSelect('setTime', TIMES_OF_DAY, settings.timeOfDay).addEventListener('change', (e) => {
  settings.timeOfDay = e.target.value; sky.setTimeOfDay(settings.timeOfDay); saveSettings(settings);
});
fillSelect('setWind', Object.keys(WIND_LEVELS), settings.wind).addEventListener('change', (e) => {
  settings.wind = e.target.value; weather.set(settings.wind); saveSettings(settings);
});
fillSelect('setQuality', ['high', 'low'], settings.quality).addEventListener('change', (e) => {
  settings.quality = e.target.value; saveSettings(settings); location.reload();
});
const inv = document.getElementById('setInvert');
inv.checked = settings.invertPitch;
inv.addEventListener('change', () => { settings.invertPitch = inv.checked; setInputOptions({ invertPitch: inv.checked }); saveSettings(settings); });
const vol = document.getElementById('setVolume');
vol.value = settings.volume;
vol.addEventListener('input', () => { settings.volume = Number(vol.value); setVolume(settings.volume); saveSettings(settings); });

function showMenu(show) {
  paused = show;
  menu.classList.toggle('hidden', !show);
  document.getElementById('resume').classList.toggle('hidden', !started || aircraft.crashed);
  setPaused(show);
}

let lastSpawn = 'runway';
let announcedLiftoff = false;
function spawn(id) {
  lastSpawn = id;
  effects.clear();
  autopilot.disengage();
  weather.randomise();
  if (id === 'rings') {
    aircraft.reset(rings.spawn());
    rings.start();
  } else {
    rings.stop();
    aircraft.reset(SCENARIOS[id].spawn());
  }
  snapCamera();
  crashBox.classList.add('hidden');
  started = true;
  announcedLiftoff = aircraft.onGround === false;
  startAudio();
  showMenu(false);
  hud.clearMessages();
  const sc = SCENARIOS[id];
  hud.message((isTouch && sc.touchHint) || sc.hint, '#cfe8ff', 7);
}
document.querySelectorAll('[data-spawn]').forEach((b) => b.addEventListener('click', () => spawn(b.dataset.spawn)));
document.getElementById('resume').addEventListener('click', () => { startAudio(); showMenu(false); });
document.getElementById('retry').addEventListener('click', () => spawn(lastSpawn));
document.getElementById('crashMenu').addEventListener('click', () => { crashBox.classList.add('hidden'); showMenu(true); });

function toggleAutopilot() {
  if (autopilot.on) {
    autopilot.disengage();
    playChime([880, 660, 440], 0.15);
    hud.message('Autopilot off', '#ff9fe8', 2);
  } else if (!aircraft.onGround && !aircraft.crashed) {
    autopilot.engage(aircraft);
    playChime([660, 880], 0.12);
    hud.message('Autopilot on: holding heading and altitude', '#ff9fe8', 2.5);
  } else hud.message('Autopilot needs the aircraft airborne', '#fc6', 2);
}

function handlePresses() {
  for (const code of consumePresses()) {
    if (code === 'KeyP' || code === 'Escape') {
      if (started && !aircraft.crashed) showMenu(!paused);
    } else if (code === 'Enter') {
      if (!started || aircraft.crashed) spawn(lastSpawn);
    } else if (paused) {
      continue;
    } else if (code === 'KeyC') {
      cameraMode = CAMERA_MODES[(CAMERA_MODES.indexOf(cameraMode) + 1) % CAMERA_MODES.length];
      snapCamera();
      if (cameraMode === 'flyby') placeFlyby();
      hud.message(`Camera: ${cameraMode}`, '#fff', 1.5);
    } else if (code === 'KeyG') {
      if (aircraft.flaps < 2) { aircraft.flaps++; hud.message(`Flaps ${[0, 15, 30][aircraft.flaps]}°`, '#7cf', 1.5); }
    } else if (code === 'KeyT') {
      if (aircraft.flaps > 0) { aircraft.flaps--; hud.message(`Flaps ${[0, 15, 30][aircraft.flaps]}°`, '#7cf', 1.5); }
    } else if (code === 'KeyZ') {
      toggleAutopilot();
    } else if (code === 'KeyN') {
      hud.toggleMap();
    } else if (code === 'KeyH') {
      hud.togglePanel();
    } else if (code === 'KeyM') {
      hud.message(toggleMute() ? 'Sound off' : 'Sound on', '#fff', 1.5);
    }
  }
}

const _gear = new THREE.Vector3();
const ZERO = new THREE.Vector3();
function gearWorld(x, z) { return _gear.set(x, -1.35, z).applyQuaternion(aircraft.quat).add(aircraft.pos); }

function handleEvents() {
  for (const e of aircraft.events) {
    if (e.type === 'touchdown') {
      const fpm = Math.round(e.fpm);
      const rating = fpm < 150 ? 'Butter!' : fpm < 350 ? 'Smooth landing' : fpm < 600 ? 'Firm landing' : 'Hard landing';
      hud.message(`${rating} ${fpm} ft/min${e.onRunway ? '' : ' (off the runway)'}`, fpm < 600 ? '#9f6' : '#fc6', 4);
      if (e.score !== undefined) hud.showLanding(e, AIRFIELDS.find((f) => f.name === e.field).papiDist);
      playThump(0.2 + fpm / 800);
      shake += 0.004 + fpm / 60000;
      const strength = clamp(aircraft.speed / 40, 0, 1);
      effects.tyreSmoke(gearWorld(-1.3, 0.3), strength);
      effects.tyreSmoke(gearWorld(1.3, 0.3), strength);
    } else if (e.type === 'liftoff') {
      if (!announcedLiftoff) hud.message('Airborne', '#cfe8ff', 2);
      announcedLiftoff = true;
    } else if (e.type === 'crash') {
      autopilot.disengage();
      playCrash();
      shake += 0.05;
      effects.crash(aircraft.pos);
      document.getElementById('crashReason').textContent = e.reason;
      setTimeout(() => { if (aircraft.crashed) crashBox.classList.remove('hidden'); }, 1500);
    }
  }
  aircraft.events.length = 0;
}

function updateParticles(dt) {
  if (aircraft.crashed) return;
  // Dust when rolling fast on grass.
  if (aircraft.onGround && aircraft.speed > 6 && !runwayAt(aircraft.pos.x, aircraft.pos.z) && Math.random() < dt * 25) {
    effects.dust(gearWorld(Math.random() < 0.5 ? -1.3 : 1.3, 0.6));
  }
  // Wingtip vapour when pulling hard in humid air.
  if (!aircraft.onGround && aircraft.gLoad > 3 && aircraft.speed > 45) {
    for (const sx of [-5.4, 5.4]) {
      _v.set(sx, -0.1, 0.4).applyQuaternion(aircraft.quat).add(aircraft.pos);
      effects.vapour(_v, ZERO);
    }
  }
}

// ---------- Main loop ----------
const STEP = 1 / 240;
let acc = 0;
let last = performance.now();
let panelTimer = 0;
let clock = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  handlePresses();

  if (!paused) {
    clock += dt;
    const intent = updateControls(aircraft, dt);
    autopilot.update(aircraft, dt, autopilot.on ? intent : null);
    weather.update(dt);
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 24) {
      aircraft.step(STEP, weather);
      acc -= STEP;
      steps++;
    }
    if (steps === 24) acc = 0;
    handleEvents();
    const r = rings.update(aircraft, dt);
    if (r?.type === 'ring') { playChime([880, 1320], 0.1); hud.message(`Ring ${r.index}/${r.total}`, '#3dff7a', 1.5); }
    if (r?.type === 'finish') {
      playChime([660, 880, 1100, 1320], 0.14);
      const t = r.time;
      hud.message(`Course complete: ${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}${r.best ? ' (new best!)' : ''}`, '#3dff7a', 8);
    }
    updateParticles(dt);
    effects.update(dt);
  }

  model.object.position.copy(aircraft.pos);
  model.object.quaternion.copy(aircraft.quat);
  model.update(aircraft, paused ? 0 : dt);
  updateCamera(paused ? 0 : dt);
  sky.update(camera, aircraft.pos);
  world.update(clock, camera, weather.surfaceWind);
  if (cameraMode === 'cockpit') {
    panelTimer -= dt;
    if (panelTimer <= 0) {
      hud.drawPanelTexture(model.panelCanvas, aircraft, autopilot);
      model.panelTex.needsUpdate = true;
      panelTimer = 1 / 30;
    }
  }
  updateAudio(aircraft);
  renderer.render(scene, camera);
  hud.draw(aircraft, camera, cameraMode, paused ? 0 : dt, { wind: aircraft.wind, ap: autopilot, rings });
  requestAnimationFrame(frame);
}

aircraft.reset(SCENARIOS.runway.spawn());
snapCamera();
showMenu(true);
requestAnimationFrame(frame);

// Handy for debugging from the console.
window.sim = { aircraft, camera, scene, weather, autopilot, rings, spawn, MS_TO_KT };
