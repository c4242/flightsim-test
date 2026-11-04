// Engine, wind, stall horn and impact sounds synthesised with the Web Audio API.

let ctx = null;
let master, engineA, engineB, engineFilter, engineGain, windGain, windFilter, hornGain, rumbleGain;
let muted = false;
let volume = 0.5;
let warnGain;
let rainGain, rainLevel = 0;
let jetWhine, jetWhineGain, jetWhineFilter, jetRoarGain, jetRoarFilter, abGain, gcasGain, gcasOsc;

function noiseBuffer(seconds = 2) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function loopNoise() {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  src.loop = true;
  src.start();
  return src;
}

export function startAudio() {
  if (ctx) { ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  master.connect(ctx.destination);

  // Engine: two detuned oscillators through a low-pass filter.
  engineFilter = ctx.createBiquadFilter();
  engineFilter.type = 'lowpass';
  engineFilter.frequency.value = 400;
  engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  engineFilter.connect(engineGain).connect(master);
  engineA = ctx.createOscillator(); engineA.type = 'sawtooth';
  engineB = ctx.createOscillator(); engineB.type = 'square';
  const gb = ctx.createGain(); gb.gain.value = 0.4;
  engineA.connect(engineFilter);
  engineB.connect(gb).connect(engineFilter);
  engineA.start(); engineB.start();

  // Wind / airflow.
  windFilter = ctx.createBiquadFilter();
  windFilter.type = 'bandpass';
  windFilter.Q.value = 0.6;
  windGain = ctx.createGain();
  windGain.gain.value = 0;
  loopNoise().connect(windFilter).connect(windGain).connect(master);

  // Tyre rumble.
  const rf = ctx.createBiquadFilter();
  rf.type = 'lowpass'; rf.frequency.value = 180;
  rumbleGain = ctx.createGain(); rumbleGain.gain.value = 0;
  loopNoise().connect(rf).connect(rumbleGain).connect(master);

  // Stall horn.
  const horn = ctx.createOscillator();
  horn.type = 'square'; horn.frequency.value = 520;
  hornGain = ctx.createGain(); hornGain.gain.value = 0;
  horn.connect(hornGain).connect(master);
  horn.start();

  // Overspeed warble.
  const warn = ctx.createOscillator();
  warn.type = 'triangle'; warn.frequency.value = 900;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 6;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 250;
  lfo.connect(lfoGain).connect(warn.frequency);
  warnGain = ctx.createGain(); warnGain.gain.value = 0;
  warn.connect(warnGain).connect(master);
  warn.start(); lfo.start();
  buildJet();
  // Rain: high-passed noise (patter) plus a low rumble on the airframe.
  const rainFilter = ctx.createBiquadFilter(); rainFilter.type = 'highpass'; rainFilter.frequency.value = 1800;
  rainGain = ctx.createGain(); rainGain.gain.value = 0;
  loopNoise().connect(rainFilter).connect(rainGain).connect(master);
}

export function setRain(level) {
  if (!ctx || Math.abs(level - rainLevel) < 0.01) return;
  rainLevel = level;
  rainGain.gain.setTargetAtTime(level * 0.12, ctx.currentTime, 0.5);
}

function buildJet() {
  // Turbine whine: a bright tone that rises with core RPM.
  jetWhine = ctx.createOscillator();
  jetWhine.type = 'sawtooth';
  jetWhineFilter = ctx.createBiquadFilter();
  jetWhineFilter.type = 'bandpass';
  jetWhineFilter.Q.value = 4;
  jetWhineGain = ctx.createGain();
  jetWhineGain.gain.value = 0;
  jetWhine.connect(jetWhineFilter).connect(jetWhineGain).connect(master);
  jetWhine.start();
  // Exhaust roar: broadband noise that grows with thrust.
  jetRoarFilter = ctx.createBiquadFilter();
  jetRoarFilter.type = 'lowpass';
  jetRoarGain = ctx.createGain();
  jetRoarGain.gain.value = 0;
  loopNoise().connect(jetRoarFilter).connect(jetRoarGain).connect(master);
  // Afterburner: deep, crackling rumble.
  const abFilter = ctx.createBiquadFilter();
  abFilter.type = 'lowpass';
  abFilter.frequency.value = 220;
  abGain = ctx.createGain();
  abGain.gain.value = 0;
  loopNoise().connect(abFilter).connect(abGain).connect(master);
  // Ground-collision warning tone (pulsed in updateAudio).
  gcasOsc = ctx.createOscillator();
  gcasOsc.type = 'square';
  gcasOsc.frequency.value = 760;
  gcasGain = ctx.createGain();
  gcasGain.gain.value = 0;
  gcasOsc.connect(gcasGain).connect(master);
  gcasOsc.start();
}

export function setVolume(v) {
  volume = v;
  if (master && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.05);
}

// Short sequence of beeps, e.g. for ring passes and autopilot changes.
export function playChime(freqs, dur = 0.12, type = 'sine', level = 0.18) {
  if (!ctx) return;
  freqs.forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    const g = ctx.createGain();
    const t = ctx.currentTime + i * dur;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.95);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + dur);
  });
}

export function toggleMute() {
  muted = !muted;
  if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.05);
  return muted;
}

export function setPaused(paused) {
  if (!ctx) return;
  if (paused) ctx.suspend(); else ctx.resume();
}

export function updateAudio(ac) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const alive = !ac.crashed;
  const jet = ac.type?.kind === 'jet';
  if (jet) {
    const n = ac.n2 ?? 0;
    const thrustFrac = Math.max(0, Math.min(1, ((ac.thrust ?? 0) / 80000)));
    jetWhine.frequency.setTargetAtTime(400 + n * 1400, t, 0.1);
    jetWhineFilter.frequency.setTargetAtTime(1200 + n * 3500, t, 0.1);
    jetWhineGain.gain.setTargetAtTime(alive ? n * n * 0.06 : 0, t, 0.1);
    jetRoarFilter.frequency.setTargetAtTime(300 + thrustFrac * 1800, t, 0.15);
    jetRoarGain.gain.setTargetAtTime(alive ? 0.05 + thrustFrac * 0.35 : 0, t, 0.15);
    abGain.gain.setTargetAtTime(alive && ac.abLit ? 0.4 + (ac.ab ?? 0) * 0.5 : 0, t, 0.2);
    gcasGain.gain.setTargetAtTime(alive && ac.gcas && (t % 0.5) < 0.25 ? 0.06 : 0, t, 0.01);
    engineGain.gain.setTargetAtTime(0, t, 0.05);
  } else {
    jetWhineGain.gain.setTargetAtTime(0, t, 0.05);
    jetRoarGain.gain.setTargetAtTime(0, t, 0.05);
    abGain.gain.setTargetAtTime(0, t, 0.05);
    gcasGain.gain.setTargetAtTime(0, t, 0.05);
  }
  // Four-cylinder, four-stroke: two firing pulses per revolution.
  const f = (ac.rpm / 60) * 2;
  engineA.frequency.setTargetAtTime(f, t, 0.05);
  engineB.frequency.setTargetAtTime(f * 0.5, t, 0.05);
  engineFilter.frequency.setTargetAtTime(250 + (ac.engineFailed ? 0 : ac.controls.throttle) * 900, t, 0.1);
  const power = ac.engineFailed ? 0 : ac.controls.throttle;
  if (!jet) engineGain.gain.setTargetAtTime(alive ? (ac.engineFailed ? Math.min(0.05, ac.rpm / 20000) : 0.12 + power * 0.18) : 0, t, 0.1);

  warnGain.gain.setTargetAtTime(alive && ac.limitWarning ? 0.05 : 0, t, 0.05);
  const s = ac.tas ?? ac.speed;
  windFilter.frequency.setTargetAtTime(300 + s * 18, t, 0.2);
  windFilter.frequency.setTargetAtTime(Math.min(4000, 300 + s * 18), t, 0.2);
  windGain.gain.setTargetAtTime(alive ? Math.min(0.35, (s / (jet ? 160 : 70)) ** 2 * 0.3) : 0, t, 0.2);
  rumbleGain.gain.setTargetAtTime(alive && ac.onGround ? Math.min(0.5, s / 30) * 0.6 : 0, t, 0.05);
  hornGain.gain.setTargetAtTime(alive && ac.stalling ? 0.05 : 0, t, 0.03);
}

export function playThump(strength = 0.5) {
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(0.4);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 600;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(Math.min(1, strength), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  src.connect(f).connect(g).connect(master);
  src.start();
}

// Sonic boom: the classic double "boom-boom" of the bow and tail shocks.
export function playBoom(level = 1) {
  if (!ctx) return;
  for (const delay of [0, 0.16]) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(1.2);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 140;
    const g = ctx.createGain();
    const t = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.6 * level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    src.connect(f).connect(g).connect(master);
    src.start(t);
  }
}

export function playCrash() {
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(2.5);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 900;
  f.frequency.setTargetAtTime(150, ctx.currentTime, 0.6);
  const g = ctx.createGain();
  const t = ctx.currentTime;
  g.gain.setValueAtTime(1.2, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 2.4);
  src.connect(f).connect(g).connect(master);
  src.start();
}
