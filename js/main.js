import * as THREE from 'three';
import './atmos.js'; // must come before anything is rendered
import { buildWorld, bakeTerrainShadows, terrainHeight, AIRFIELDS, fieldToWorld, runwayAt } from './terrain.js';
import { createSky, TIMES_OF_DAY } from './sky.js';
import { Aircraft, MS_TO_KT } from './aircraft.js';
import { createAircraftModel } from './model.js';
import { createF16Model } from './model-f16.js';
import { SKYLARK } from './planes/skylark.js';
import { F16 } from './planes/f16.js';
import { initInput, initTouch, updateControls, consumePresses, getLook, KEYMAP, setInputOptions } from './input.js';
import { createHud } from './hud.js';
import { startAudio, updateAudio, toggleMute, setPaused, playThump, playCrash, playChime, setVolume, playBoom, setRain } from './audio.js';
import { ilsGuidance } from './nav.js';
import { Tanker } from './tanker.js';
import { Weather, WIND_LEVELS } from './weather.js';
import { Autopilot } from './autopilot.js';
import { Effects } from './effects.js';
import { RingCourse } from './rings.js';
import { SCENARIOS } from './scenarios.js';
import { MISSIONS, MissionRunner } from './missions.js';
import { Traffic } from './traffic.js';
import { Recorder } from './replay.js';
import { loadSettings, saveSettings, isTouch } from './settings.js';
import { clamp } from './noise.js';
import { createPost } from './post.js';
import { createFlare } from './flare.js';
import { Contrails } from './trails.js';
import { Rain } from './rain.js';
import { Birds } from './birds.js';

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
const post = createPost(renderer, scene, camera, { enabled: !low });

const sky = createSky(scene, renderer);
sky.setShadows(!low);
const world = buildWorld(scene, renderer, sky.env, settings.quality);

const weather = new Weather();
weather.set(settings.wind);
weather.randomise();

// Both aircraft are built up front; only the selected one is shown.
const TYPES = { skylark: SKYLARK, f16: F16 };
const MODELS = { skylark: createAircraftModel(), f16: createF16Model({ renderer }) };
for (const m of Object.values(MODELS)) { scene.add(m.object); m.object.visible = false; m.camera = camera; }
if (!TYPES[settings.aircraft]) settings.aircraft = 'skylark';
const aircraft = new Aircraft(TYPES[settings.aircraft]);
let model = MODELS[settings.aircraft];
model.object.visible = true;
const kind = () => aircraft.type.kind;

function selectAircraft(id) {
  settings.aircraft = id;
  saveSettings(settings);
  aircraft.setType(TYPES[id]);
  model.setCockpitView(false);
  model.object.visible = false;
  model = MODELS[id];
  model.object.visible = true;
  renderScenarioList();
  renderMissionList();
  updateTouchLabels();
}

// The two flap buttons become gear and speedbrake buttons in the jet.
function updateTouchLabels() {
  const down = document.getElementById('tFlapDown'), up = document.getElementById('tFlapUp');
  const jet = kind() === 'jet';
  down.textContent = jet ? 'GEAR' : 'FLAP ▼';
  up.textContent = jet ? 'SPD BRK' : 'FLAP ▲';
  up.dataset.key = jet ? 'KeyX' : 'KeyT';
}

let shadowsFor = null;
function applyTime(name) {
  sky.setTimeOfDay(name);
  // Re-bake the mountain shadows when the sun (or moon) moves.
  if (shadowsFor !== name) { bakeTerrainShadows(sky.env.sunDir); shadowsFor = name; }
  for (const m of Object.values(MODELS)) m.setLights(sky.env.night);
  traffic?.model.setLights(sky.env.night);
}
const effects = new Effects(scene);
const rings = new RingCourse(scene);
const autopilot = new Autopilot();
const traffic = new Traffic(scene);
const missions = new MissionRunner();
const tanker = new Tanker(scene);
const contrails = new Contrails(scene);
const rain = new Rain(scene);
const birds = new Birds(scene);
const NOZZLE = [new THREE.Vector3(0, -0.05, 5.6)];
const contrailColor = new THREE.Color();
missions.ctx = { tanker };
const recorder = new Recorder();
let replaying = false;
applyTime(settings.timeOfDay);
sky.setClouds(settings.clouds);

const hud = createHud(document.getElementById('hud'));
const flare = createFlare(document.getElementById('flare'));
initInput(renderer.domElement);
setInputOptions({ invertPitch: settings.invertPitch, lookSensitivity: settings.lookSensitivity });
setVolume(settings.volume);
if (isTouch) {
  initTouch(document.getElementById('touch'));
  hud.compact = true;
  hud.panelBar = false; // no room for the gauge panel; readouts and the F-16 HUD stay
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
});

// ---------- Camera ----------
const CAMERA_MODES = ['chase', 'cockpit', 'tower', 'flyby'];
let cameraMode = 'chase';
const chaseQuat = new THREE.Quaternion();
const lookQuat = new THREE.Quaternion();
const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.1);
const _xAxis = new THREE.Vector3(1, 0, 0);
const cockpitTilt = new THREE.Quaternion().setFromAxisAngle(_xAxis, -0.1);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const towers = [
  new THREE.Vector3(AIRFIELDS[0].width / 2 + 115, AIRFIELDS[0].elevation + 22, 240),
  fieldToWorld(AIRFIELDS[1], -30, 100, AIRFIELDS[1].elevation + 12),
];
const flybyPos = new THREE.Vector3();
let flybyAge = 1e9;
let shake = 0;

// The camera follows `subject`: the live aircraft, or the replay's display state.
let subject = aircraft;

function snapCamera() { chaseQuat.copy(subject.quat); flybyAge = 1e9; }

function placeFlyby() {
  const dir = _v.copy(subject.vel);
  if (dir.lengthSq() < 1) dir.set(0, 0, -1).applyQuaternion(subject.quat);
  dir.normalize();
  const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(Math.random() < 0.5 ? -22 : 22);
  flybyPos.copy(subject.pos).addScaledVector(dir, Math.min(420, Math.max(120, subject.speed * 3))).add(side);
  flybyPos.y += 4 + Math.random() * 8;
  flybyPos.y = Math.max(flybyPos.y, Math.max(0, terrainHeight(flybyPos.x, flybyPos.z)) + 2);
  flybyAge = 0;
}

function updateCamera(dt) {
  const aircraft = subject;
  const look = getLook(dt);
  lookEuler.set(look.pitch, look.yaw, 0);
  lookQuat.setFromEuler(lookEuler);
  let fov = 65;
  model.setCockpitView(cameraMode === 'cockpit');

  if (cameraMode === 'cockpit') {
    fov = model.cockpitFov ?? 74;
    camera.position.copy(_v.copy(model.eye).applyQuaternion(aircraft.quat).add(aircraft.pos));
    cockpitTilt.setFromAxisAngle(_xAxis, model.viewPitch ?? -0.1);
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
    camera.position.copy((kind() === 'jet' ? _v.set(0, 3.4, 24) : _v.set(0, 2.2, 14)).multiplyScalar(look.zoom).applyQuaternion(_q).add(aircraft.pos));
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
  // A close near plane is only needed inside the cockpit; elsewhere a farther one keeps depth precision.
  const near = cameraMode === 'cockpit' ? 0.2 : 0.6;
  if (Math.abs(camera.fov - fov) > 0.01 || camera.near !== near) { camera.fov = fov; camera.near = near; camera.updateProjectionMatrix(); }
}

// ---------- Menus ----------
const menu = document.getElementById('menu');
const resultBox = document.getElementById('result');
document.getElementById('keys').innerHTML = KEYMAP.map(([k, d]) => `<tr><td>${k}</td><td>${d}</td></tr>`).join('');
function renderScenarioList() {
  document.getElementById('scenarios').innerHTML = Object.entries(SCENARIOS)
    .filter(([, s]) => !s.aircraft || s.aircraft.includes(kind()))
    .map(([id, s]) => `<button data-spawn="${id}">${s.label}</button>`).join('');
}
function renderMissionList() {
  document.getElementById('missions').innerHTML = MISSIONS.filter((m) => m.aircraft.includes(kind())).map((m) => {
    const st = missions.stars[m.id] ?? 0;
    return `<button data-spawn="mission:${m.id}"><span>${m.title}</span><span class="stars">${'★'.repeat(st)}${'☆'.repeat(3 - st)}</span></button>`;
  }).join('');
}
renderScenarioList();
renderMissionList();
updateTouchLabels();
let paused = true;
let started = false;

function fillSelect(id, values, current, label = (v) => v[0].toUpperCase() + v.slice(1)) {
  const el = document.getElementById(id);
  el.innerHTML = values.map((v) => `<option value="${v}" ${v === current ? 'selected' : ''}>${label(v)}</option>`).join('');
  return el;
}
fillSelect('setAircraft', Object.keys(TYPES), settings.aircraft, (v) => TYPES[v].name).addEventListener('change', (e) => {
  selectAircraft(e.target.value);
  missions.stop();
  rings.stop();
  autopilot.disengage();
  hud.clearMessages();
  started = false;
  showMenu(true);
  spawnPreview();
});
fillSelect('setTime', TIMES_OF_DAY, settings.timeOfDay).addEventListener('change', (e) => {
  settings.timeOfDay = e.target.value; saveSettings(settings);
  if (!missions.mission?.time) applyTime(settings.timeOfDay);
});
const CLOUD_LABELS = { clear: 'Clear', scattered: 'Scattered', overcast: 'Overcast (1,500 ft)', rain: 'Rain (overcast, 1,100 ft)', fog: 'Fog', variable: 'Changing (showers come and go)' };
fillSelect('setClouds', Object.keys(CLOUD_LABELS), settings.clouds, (v) => CLOUD_LABELS[v]).addEventListener('change', (e) => {
  settings.clouds = e.target.value; saveSettings(settings);
  if (!missions.mission?.clouds) sky.setClouds(settings.clouds);
});
fillSelect('setWind', Object.keys(WIND_LEVELS), settings.wind).addEventListener('change', (e) => {
  settings.wind = e.target.value; saveSettings(settings);
  if (!missions.mission) weather.set(settings.wind);
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
  document.getElementById('resume').classList.toggle('hidden', !started || aircraft.crashed || missions.state === 'complete');
  setPaused(show);
}

function showResult({ title, text, color = '#ff6a4d', stars = null }) {
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('resultTitle').style.color = color;
  document.getElementById('resultText').textContent = text;
  const st = document.getElementById('resultStars');
  st.textContent = stars === null ? '' : '★'.repeat(stars) + '☆'.repeat(3 - stars);
  resultBox.classList.remove('hidden');
}

let lastSpawn = 'runway';
let announcedLiftoff = false;
let crashTime = null;
let resultTimer = null;

function spawn(id) {
  lastSpawn = id;
  stopReplay();
  clearTimeout(resultTimer);
  effects.clear();
  contrails.clear();
  autopilot.disengage();
  recorder.clear();
  traffic.reset();
  crashTime = null;
  let hint;
  if (id.startsWith('mission:')) {
    const m = MISSIONS.find((x) => x.id === id.slice(8));
    rings.stop();
    missions.start(m);
    weather.set(m.wind[0], m.wind[1]);
    applyTime(m.time ?? settings.timeOfDay);
    sky.setClouds(m.clouds ?? settings.clouds);
    m.setup?.(missions.ctx);
    aircraft.reset(m.spawn(kind(), missions.ctx));
    hint = `Mission: ${m.title}`;
  } else {
    missions.stop();
    weather.set(settings.wind);
    weather.randomise();
    applyTime(settings.timeOfDay);
    sky.setClouds(settings.clouds);
    if (id === 'rings') {
      aircraft.reset(rings.spawn(kind()));
      rings.start();
    } else {
      rings.stop();
      aircraft.reset(SCENARIOS[id].spawn(kind()));
    }
    const sc = SCENARIOS[id];
    hint = (kind() === 'jet' && sc.jetHint) || (isTouch && sc.touchHint) || sc.hint;
  }
  subject = aircraft;
  prevMach = aircraft.mach;
  snapCamera();
  resultBox.classList.add('hidden');
  started = true;
  announcedLiftoff = aircraft.onGround === false;
  startAudio();
  showMenu(false);
  hud.clearMessages();
  hud.message(hint, '#cfe8ff', 9);
}
document.querySelectorAll('#menu').forEach((el) => el.addEventListener('click', (e) => {
  const b = e.target.closest('[data-spawn]');
  if (b) spawn(b.dataset.spawn);
}));
document.getElementById('resume').addEventListener('click', () => { startAudio(); showMenu(false); });
document.getElementById('retry').addEventListener('click', () => spawn(lastSpawn));
document.getElementById('watchReplay').addEventListener('click', () => { resultBox.classList.add('hidden'); startReplay(); });
document.getElementById('resultMenu').addEventListener('click', () => { resultBox.classList.add('hidden'); renderMissionList(); showMenu(true); });

// ---------- Replay ----------
function startReplay() {
  if (replaying || !recorder.start()) { hud.message('Nothing to replay yet', '#fc6', 1.5); return; }
  replaying = true;
  resultBox.classList.add('hidden');
  subject = recorder.sample(0);
  if (cameraMode === 'cockpit') cameraMode = 'chase';
  snapCamera();
  setPaused(false);
}
function stopReplay() {
  if (!replaying) return;
  replaying = false;
  recorder.stop();
  subject = aircraft;
  snapCamera();
  if (aircraft.crashed || missions.state === 'complete' || missions.state === 'failed') resultBox.classList.remove('hidden');
}

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

// F1 cockpit, F2 chase, F3 tower, F4 flyby (C cycles through them).
const CAMERA_KEYS = { F1: 'cockpit', F2: 'chase', F3: 'tower', F4: 'flyby' };
function setCamera(mode, announce = true) {
  if (mode === cameraMode) return;
  cameraMode = mode;
  snapCamera();
  if (cameraMode === 'flyby') placeFlyby();
  if (announce) hud.message(`Camera: ${cameraMode}`, '#fff', 1.5);
}

function handlePresses() {
  for (const code of consumePresses()) {
    if (replaying) {
      if (code === 'KeyV' || code === 'Escape' || code === 'KeyP') stopReplay();
      else if (code === 'KeyC') setCamera(['chase', 'tower', 'flyby'][(['chase', 'tower', 'flyby'].indexOf(cameraMode) + 1) % 3], false);
      else if (CAMERA_KEYS[code] && CAMERA_KEYS[code] !== 'cockpit') setCamera(CAMERA_KEYS[code], false);
      continue;
    }
    if (code === 'KeyP' || code === 'Escape') {
      if (started && !aircraft.crashed && resultBox.classList.contains('hidden')) showMenu(!paused);
    } else if (code === 'Enter') {
      if (!started || aircraft.crashed || !resultBox.classList.contains('hidden')) spawn(lastSpawn);
    } else if (code === 'KeyV') {
      if (started && menu.classList.contains('hidden')) startReplay();
    } else if (paused) {
      continue;
    } else if (code === 'KeyC') {
      setCamera(CAMERA_MODES[(CAMERA_MODES.indexOf(cameraMode) + 1) % CAMERA_MODES.length]);
    } else if (CAMERA_KEYS[code]) {
      setCamera(CAMERA_KEYS[code]);
    } else if (code === 'KeyG' && kind() === 'jet') {
      if (aircraft.onGround && aircraft.gearHandle) hud.message('Gear handle locked: weight on wheels', '#fc6', 2);
      else {
        aircraft.gearHandle = !aircraft.gearHandle;
        playChime([aircraft.gearHandle ? 520 : 700], 0.12, 'triangle', 0.1);
        hud.message(aircraft.gearHandle ? 'Gear down' : 'Gear up', '#7cf', 1.5);
      }
    } else if (code === 'KeyX' && kind() === 'jet') {
      aircraft.speedbrakeCmd = !aircraft.speedbrakeCmd;
      hud.message(aircraft.speedbrakeCmd ? 'Speedbrakes out' : 'Speedbrakes in', '#7cf', 1.5);
    } else if (code === 'KeyG') {
      if (aircraft.flaps < 2) { aircraft.flaps++; hud.message(`Flaps ${[0, 15, 30][aircraft.flaps]}°`, '#7cf', 1.5); }
    } else if (code === 'KeyT' && kind() !== 'jet') {
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
function gearWorld(i) { return _gear.copy(aircraft.type.gear[i].p).applyQuaternion(aircraft.quat).add(aircraft.pos); }

function handleEvents() {
  for (const e of aircraft.events) {
    if (e.type === 'touchdown') {
      missions.onTouchdown(e);
      const fpm = Math.round(e.fpm);
      const rating = fpm < 150 ? 'Butter!' : fpm < 350 ? 'Smooth landing' : fpm < 600 ? 'Firm landing' : 'Hard landing';
      hud.message(`${rating} ${fpm} ft/min${e.onRunway ? '' : ' (off the runway)'}`, fpm < 600 ? '#9f6' : '#fc6', 4);
      if (e.score !== undefined) hud.showLanding(e, AIRFIELDS.find((f) => f.name === e.field).papiDist);
      playThump(0.2 + fpm / 800);
      shake += 0.004 + fpm / 60000;
      const strength = clamp(aircraft.speed / 40, 0, 1);
      effects.tyreSmoke(gearWorld(1), strength);
      effects.tyreSmoke(gearWorld(2), strength);
    } else if (e.type === 'liftoff') {
      if (!announcedLiftoff) hud.message('Airborne', '#cfe8ff', 2);
      announcedLiftoff = true;
    } else if (e.type === 'crash') {
      autopilot.disengage();
      playCrash();
      shake += 0.05;
      effects.crash(aircraft.pos);
      crashTime = clock;
      resultTimer = setTimeout(() => {
        if (aircraft.crashed && !replaying) showResult({ title: 'Crashed', text: e.reason });
      }, 1500);
    }
  }
  aircraft.events.length = 0;
}

function handleMission(dt) {
  const r = missions.update(aircraft, dt);
  if (!r) return;
  if (r.type === 'event') {
    playChime([440, 330, 440, 330], 0.18, 'square', 0.12);
    hud.message(r.msg, '#ff6a4d', 6);
  } else if (r.type === 'objective') {
    playChime([660, 990], 0.1);
    hud.message(`✓ ${r.text}  ·  next: ${r.next}`, '#ffcf6a', 4);
  } else if (r.type === 'complete') {
    playChime([660, 880, 1100, 1320], 0.14);
    hud.message('Mission complete!', '#9f6', 4);
    resultTimer = setTimeout(() => {
      if (!replaying) showResult({
        title: 'Mission complete', color: '#9f6', stars: r.stars,
        text: `${missions.mission.title}: landing score ${r.score}/100, time ${Math.floor(r.time / 60)}:${String(Math.round(r.time % 60)).padStart(2, '0')}.`,
      });
    }, 2500);
  } else if (r.type === 'fail' && !aircraft.crashed) {
    hud.message(`Mission failed: ${r.reason}`, '#ff6a4d', 4);
    resultTimer = setTimeout(() => { if (!replaying) showResult({ title: 'Mission failed', text: r.reason }); }, 2000);
  }
}

let failSmokeT = 0;
const _smokeV = new THREE.Vector3(), _smokeC = new THREE.Color();
function updateParticles(dt) {
  if (aircraft.crashed) return;
  // Engine failure: a smoke trail (oil smoke from the prop's cowling, fuel vapour and smoke from
  // the jet's nozzle) that thins out over about 20 s.
  const failed = aircraft.engineFailed || (kind() === 'jet' && aircraft.fuel <= 0);
  failSmokeT = failed ? failSmokeT + dt : 0;
  if (failed && !aircraft.onGround) {
    const fade = Math.max(0.2, 1 - failSmokeT / 30);
    // Several puffs a frame, spread along the path flown, so the trail is continuous.
    for (let e = 0, n = Math.min(4, Math.round(dt * 40 * fade + Math.random())); e < n; e++) {
      const jet = kind() === 'jet';
      _v.set(0, jet ? -0.05 : -0.3, jet ? 5.6 : -2.6).applyQuaternion(aircraft.quat).add(aircraft.pos).addScaledVector(aircraft.vel, -dt * Math.random());
      // Puffs are left behind in the air (slow down quickly), spreading and rising a little.
      _smokeV.copy(aircraft.vel).multiplyScalar(0.15).add(new THREE.Vector3((Math.random() - 0.5) * 2, 0.6, (Math.random() - 0.5) * 2));
      effects.emit(_v, _smokeV, {
        color: _smokeC.setHex(jet ? 0x9a9a9a : 0x3a3633).multiplyScalar(0.8 + Math.random() * 0.4),
        life: 7 + Math.random() * 4, size0: jet ? 1.8 : 1.6, size1: (jet ? 18 : 15) * (0.7 + Math.random() * 0.6),
        alpha: (jet ? 0.42 : 0.55) * fade * (0.6 + Math.random() * 0.4), drag: 2.5, rise: 0.4,
      });
    }
  }
  // Dust when rolling fast on grass.
  if (aircraft.onGround && aircraft.speed > 6 && !runwayAt(aircraft.pos.x, aircraft.pos.z) && Math.random() < dt * 25) {
    effects.dust(gearWorld(Math.random() < 0.5 ? 1 : 2));
  }
  // Wingtip vapour when pulling hard in humid air.
  if (!aircraft.onGround && aircraft.gLoad > 3 && aircraft.speed > 45) {
    const tip = kind() === 'jet' ? 4.98 : 5.4;
    for (const sx of [-tip, tip]) {
      _v.set(sx, -0.1, 0.4).applyQuaternion(aircraft.quat).add(aircraft.pos);
      effects.vapour(_v, ZERO);
    }
    // Strake vortices on the jet at high AoA.
    if (kind() === 'jet' && aircraft.alpha > 0.25) {
      for (const sx of [-1.0, 1.0]) {
        _v.set(sx, 0.1, -2.6 + Math.random() * 3).applyQuaternion(aircraft.quat).add(aircraft.pos);
        effects.vapour(_v, ZERO);
      }
    }
  }
  // Transonic shock collar (vapour cone) in humid air at low level.
  if (kind() === 'jet' && aircraft.mach > 0.95 && aircraft.mach < 1.05 && aircraft.altitude < 3000 && Math.random() < 0.8) {
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      _v.set(Math.cos(a) * 1.6, 0.2 + Math.sin(a) * 1.3, 0.5 + Math.random()).applyQuaternion(aircraft.quat).add(aircraft.pos);
      effects.vapour(_v, ZERO);
    }
  }
}

// ---------- Pilot physiology and ground-collision warning ----------
// Sustained G drains blood from the head: first the edges of vision grey out, then it blacks out.
// Negative G gives a red-out. This is a simple model of a pilot in a G-suit doing straining manoeuvres.
const gfx = document.getElementById('gfx');
let gStress = 0;
function updatePilot(dt) {
  const g = aircraft.crashed ? 1 : aircraft.gLoad;
  if (g > 5.5) gStress += (g - 5.5) * 0.12 * dt;
  else gStress -= (0.35 + (5.5 - Math.max(g, 1)) * 0.06) * dt;
  if (g < -2) gStress -= 0; // handled as red-out below
  gStress = clamp(gStress, 0, 1.4);
  const grey = clamp((gStress - 0.25) / 0.9, 0, 1);
  const red = clamp((-g - 2) / 2, 0, 0.8);
  if (grey > 0.01) {
    gfx.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,${grey * 0.3}) ${Math.round(45 - grey * 40)}%, rgba(0,0,0,${0.35 + grey * 0.62}) 100%)`;
  } else if (red > 0.01) {
    gfx.style.background = `radial-gradient(ellipse at center, rgba(170,0,0,${red * 0.4}) 30%, rgba(120,0,0,${red}) 100%)`;
  } else gfx.style.background = 'none';
  // Ground-collision warning: descending towards the terrain with less than ~5 s to impact.
  const sink = -aircraft.vel.y;
  aircraft.gcas = !aircraft.onGround && !aircraft.crashed && aircraft.gearDown < 0.5 && sink > 8 && aircraft.agl / sink < 5;
}

// ---------- Adaptive resolution ----------
// Lowers the render resolution when frames take too long, and raises it again when there is headroom.
const maxRatio = Math.min(devicePixelRatio || 1, low ? 1 : 2);
let pixelRatio = maxRatio, frameAvg = 1 / 60, resTimer = 0;
function adaptResolution(dt) {
  frameAvg += (dt - frameAvg) * 0.05;
  resTimer += dt;
  if (resTimer < 2) return;
  resTimer = 0;
  let next = pixelRatio;
  if (frameAvg > 1 / 40) next = Math.max(0.6, pixelRatio - 0.15);
  else if (frameAvg < 1 / 57) next = Math.min(maxRatio, pixelRatio + 0.1);
  if (Math.abs(next - pixelRatio) > 0.01) { pixelRatio = next; renderer.setPixelRatio(pixelRatio); post.setPixelRatio(pixelRatio); }
}
let prevMach = 0;

// ---------- Heat shimmer behind the jet nozzle (outside views only) ----------
const _hA = new THREE.Vector3(), _hB = new THREE.Vector3();
function updateHeatShimmer(dt) {
  const s = subject;
  const power = kind() === 'jet' && !aircraft.crashed && cameraMode !== 'cockpit' ? Math.max(0, ((s.n2 ?? 0) - 0.7) / 0.3) : 0;
  if (power <= 0) { post.setHeat([0, 0], [0, 0], 0, 0, dt); return; }
  _hA.set(0, -0.05, 5.4).applyQuaternion(s.quat).add(s.pos);
  _hB.set(0, -0.05, 5.4 + 16).applyQuaternion(s.quat).add(s.pos);
  const dist = camera.position.distanceTo(_hA);
  _hA.project(camera); _hB.project(camera);
  if (_hA.z > 1 || _hB.z > 1) { post.setHeat([0, 0], [0, 0], 0, 0, dt); return; }
  const toPx = (v) => [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight];
  const pxPerM = innerHeight / (2 * Math.tan(camera.fov * Math.PI / 360)) / Math.max(1, dist);
  // Stronger in afterburner; the shimmer is washed out by high-speed airflow.
  const strength = power * (s.abLit ? 1 : 0.6) * (1 - 0.5 * Math.min(1, (s.speed ?? 0) / 300));
  post.setHeat(toPx(_hA), toPx(_hB), Math.max(10, 1.3 * pxPerM), strength, dt);
}

// ---------- Rain ----------
// Heaviest below the cloud base, lighter inside the cloud, none above it.
let glassMist = 0, showerOn = false; // droplets collected flying through cloud; they blow off over a few seconds
function updateRain(dt) {
  const mist = sky.inCloud * 0.4;
  glassMist = mist > glassMist ? glassMist + (mist - glassMist) * Math.min(1, dt * 3) : glassMist * Math.exp(-dt / 4);
  weather.rain = sky.raining;
  weather.shower = sky.rain;
  const h = camera.position.y;
  const layer = sky.cloudLayer;
  const amount = sky.rain > 0.01 && layer ? sky.rain * (h < layer[0] ? 1 : h < layer[1] ? 0.5 : 0) : 0;
  // Announce showers arriving and passing when the weather is changing.
  if (sky.cloudMode === 'variable' && !replaying) {
    if (!showerOn && sky.rain > 0.3) { showerOn = true; hud.message('Rain shower moving in', '#9cf', 3); }
    if (showerOn && sky.rain < 0.1) { showerOn = false; hud.message('The rain is clearing', '#9cf', 3); }
  }
  const ground = Math.max(0, terrainHeight(camera.position.x, camera.position.z));
  const light = sky.env.night ? 0.25 : 1;
  rain.update(dt, camera, subject.vel ?? aircraft.vel, weather.surfaceWind, amount, ground, light);
  // Drops on the windscreen in the cockpit view; the airflow sweeps them away at speed.
  // Flying through cloud mists the glass too.
  const onGlass = cameraMode === 'cockpit' && !replaying ? Math.max(amount * 0.55, glassMist) : 0;
  post.setRainGlass(onGlass, Math.min(1, (subject.speed ?? 0) / 75), dt);
  setRain(amount);
}

// ---------- Main loop ----------
const STEP = 1 / 240;
let acc = 0;
let last = performance.now();
let panelTimer = 0;
let clock = 0;

function frame(now) {
  const rawDt = (now - last) / 1000;
  const dt = Math.min(0.05, rawDt);
  last = now;
  if (!paused) adaptResolution(Math.min(rawDt, 0.25));
  handlePresses();

  if (replaying) {
    clock += dt;
    subject = recorder.sample(dt);
    traffic.update(dt);
    tanker.update(dt, null);
    birds.update(dt, null, sky.env.night);
    effects.update(dt);
  } else if (!paused) {
    clock += dt;
    const intent = updateControls(aircraft, dt);
    autopilot.update(aircraft, dt, autopilot.on ? intent : null);
    weather.update(dt);
    weather.cloud = sky.densityAt(aircraft.pos.x, aircraft.pos.y, aircraft.pos.z);
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 24) {
      aircraft.step(STEP, weather);
      acc -= STEP;
      steps++;
    }
    if (steps === 24) acc = 0;
    traffic.update(dt);
    updatePilot(dt);
    if (!aircraft.crashed && aircraft.pos.distanceTo(traffic.pos) < (kind() === 'jet' ? 9 : 7)) aircraft.crash('Mid-air collision with other traffic');
    tanker.update(dt, aircraft);
    const strike = birds.update(dt, aircraft, sky.env.night);
    if (strike) {
      playThump(0.8);
      shake += 0.01;
      for (let i = 0; i < 14; i++) {
        effects.emit(strike.pos, new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.2) * 4, (Math.random() - 0.5) * 6).addScaledVector(aircraft.vel, 0.3),
          { color: Math.random() < 0.6 ? 0xeeeeee : 0x777777, life: 1.5 + Math.random(), size0: 0.3, size1: 1.2, alpha: 0.8, drag: 3 });
      }
      // A jet engine can surge and flame out after ingesting a bird.
      if (kind() === 'jet' && !aircraft.engineFailed && Math.random() < 0.15) {
        aircraft.engineFailed = true;
        hud.message('BIRD STRIKE: bird ingested, engine failure!', '#ff6a4d', 5);
      } else hud.message('Bird strike!', '#fc6', 3);
    }
    for (const e of tanker.events) {
      if (e.type === 'contact') { playChime([660, 990], 0.12); hud.message('Contact: taking on fuel', '#3dff6e', 2.5); }
      if (e.type === 'disconnect') { playChime([700, 500], 0.12); hud.message(`Disconnect (${e.reason === 'limits' ? 'out of limits' : 'closure rate'})`, '#fc6', 2.5); }
      if (e.type === 'full') hud.message('Tanks full', '#3dff6e', 2.5);
    }
    // Sonic boom heard from outside when the jet accelerates through Mach 1.
    if (kind() === 'jet' && prevMach < 1 && aircraft.mach >= 1 && cameraMode !== 'cockpit') playBoom(cameraMode === 'chase' ? 0.6 : 1);
    prevMach = aircraft.mach;
    handleEvents();
    handleMission(dt);
    const r = rings.update(aircraft, dt);
    if (r?.type === 'ring') { playChime([880, 1320], 0.1); hud.message(`Ring ${r.index}/${r.total}`, '#3dff7a', 1.5); }
    if (r?.type === 'finish') {
      playChime([660, 880, 1100, 1320], 0.14);
      const t = r.time;
      hud.message(`Course complete: ${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}${r.best ? ' (new best!)' : ''}`, '#3dff7a', 8);
    }
    // Keep recording briefly after a crash so the replay shows the impact.
    if (crashTime === null || clock - crashTime < 2) recorder.record(aircraft, dt);
    updateParticles(dt);
    effects.update(dt);
    // Contrails above about 26,000 ft (the cold, humid air the exhaust water vapour freezes in).
    // Sunlit ice crystals: near-white, tinted a little by the sun's colour and dimmed at night.
    contrailColor.setRGB(0.8, 0.82, 0.86).lerp(sky.env.sunColor, 0.25).multiplyScalar(sky.env.night ? 0.35 : 1.15);
    contrails.update(dt, aircraft, NOZZLE, kind() === 'jet' && aircraft.altitude > 8000 && !aircraft.onGround, scene, camera, contrailColor);
  }

  model.nav = replaying || aircraft.crashed ? null : ilsGuidance(aircraft.pos, aircraft.heading);
  model.object.position.copy(subject.pos);
  model.object.quaternion.copy(subject.quat);
  model.update(subject, paused && !replaying ? 0 : dt);
  updateCamera(paused && !replaying ? 0 : dt);
  sky.update(camera, subject.pos, paused && !replaying ? 0 : dt);
  world.update(clock, camera, weather.surfaceWind, sky.env.night || sky.haze > 0.3 || sky.weatherState.deck > 0.6);
  if (cameraMode === 'cockpit' && !replaying) {
    panelTimer -= dt;
    if (panelTimer <= 0) {
      if (model.fgCockpit) {
        hud.drawMfdPage(model.mfdCanvases[0], aircraft, 'engine');
        hud.drawMfdPage(model.mfdCanvases[1], aircraft, 'attitude');
        for (const t of model.fgCockpit.mfdTextures) t.needsUpdate = true;
      } else hud.drawPanelTexture(model.panelCanvas, aircraft, autopilot);
      model.panelTex.needsUpdate = true;
      panelTimer = 1 / 30;
    }
  }
  updateAudio(replaying ? { ...aircraft, crashed: true } : aircraft);
  updateHeatShimmer(dt);
  updateRain(paused && !replaying ? 0 : dt);
  post.render();
  flare.draw(camera, sky.env.sunDir, { haze: sky.haze, night: sky.env.night, dt });
  hud.draw(aircraft, camera, cameraMode, paused && !replaying ? 0 : dt, {
    wind: aircraft.wind, ap: autopilot, rings, mission: missions, tanker: kind() === 'jet' ? tanker : null,
    nav: aircraft.crashed ? null : ilsGuidance(aircraft.pos, aircraft.heading),
    replay: replaying ? { t: recorder.t, duration: recorder.duration } : null,
  });
  requestAnimationFrame(frame);
}

function spawnPreview() {
  aircraft.reset(SCENARIOS.runway.spawn(kind()));
  subject = aircraft;
  snapCamera();
}
spawnPreview();
showMenu(true);
requestAnimationFrame(frame);

// Handy for debugging from the console.
window.sim = { sky, birds, updateParticles, effects, post, contrails, contrailColor, models: MODELS, aircraft, camera, scene, weather, autopilot, rings, missions, traffic, tanker, recorder, spawn, snapCamera, MS_TO_KT };
