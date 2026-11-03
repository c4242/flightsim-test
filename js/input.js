// Keyboard, gamepad, touch and mouse-look input. Produces smoothed control positions.

import { clamp } from './noise.js';

const held = new Set();
const pressedQueue = [];
const look = { yaw: 0, pitch: 0, dragging: false, idle: 0 };
const touch = { active: false, stickX: 0, stickY: 0, stickOn: false, throttle: null, brake: false, rudder: 0 };
const options = { invertPitch: false, lookSensitivity: 1 };

export const KEYMAP = [
  ['W / S  or  ↑ / ↓', 'Pitch (nose down / nose up)'],
  ['A / D  or  ← / →', 'Roll left / right'],
  ['Q / E', 'Rudder left / right (steers on the ground)'],
  ['R / F', 'Throttle up / down (hold). F-16: above 80% is afterburner'],
  ['1 … 9, 0', 'Set throttle 10 … 90 %, 100 % (F-16: 8 = military power, 0 = full afterburner)'],
  ['G / T', 'Prop: flaps down / up.  F-16: G = landing gear up/down'],
  ['X', 'F-16: speedbrakes out / in'],
  ['B', 'Wheel brakes (hold)'],
  ['[ / ]', 'Elevator trim nose down / up'],
  ['Z', 'Autopilot on / off (stick keys then steer the heading and altitude)'],
  ['C', 'Camera: chase, cockpit, tower, flyby'],
  ['Mouse drag', 'Look around (double-click to recentre)'],
  ['N', 'Map'],
  ['V', 'Instant replay of the last minute (C changes camera)'],
  ['H', 'Hide / show the instrument panel, readouts and minimap (the F-16 HUD always stays on)'],
  ['M', 'Mute'],
  ['P or Esc', 'Pause menu'],
  ['Enter', 'Restart after a crash'],
];

export function setInputOptions(o) { Object.assign(options, o); }

export function initInput(canvas) {
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (!held.has(e.code)) pressedQueue.push(e.code);
    held.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', (e) => held.delete(e.code));
  addEventListener('blur', () => held.clear());

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    look.dragging = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => { look.dragging = false; look.idle = 0; });
  canvas.addEventListener('pointermove', (e) => {
    if (!look.dragging) return;
    const k = 0.006 * options.lookSensitivity;
    look.yaw = clamp(look.yaw - e.movementX * k, -Math.PI, Math.PI);
    look.pitch = clamp(look.pitch - e.movementY * k, -1.2, 1.2);
  });
  canvas.addEventListener('dblclick', () => { look.yaw = look.pitch = 0; });
}

// ---------- Touch controls ----------
export function initTouch(root) {
  touch.active = true;
  root.classList.remove('hidden');
  const stick = root.querySelector('#tStick');
  const knob = root.querySelector('#tKnob');
  let stickId = null;
  const setStick = (e) => {
    const r = stick.getBoundingClientRect();
    const R = r.width / 2;
    let dx = (e.clientX - r.left - R) / R, dy = (e.clientY - r.top - R) / R;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    touch.stickX = dx; touch.stickY = dy;
    knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
  };
  stick.addEventListener('pointerdown', (e) => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); touch.stickOn = true; setStick(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) setStick(e); });
  const release = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null; touch.stickOn = false; touch.stickX = touch.stickY = 0;
    knob.style.transform = '';
  };
  stick.addEventListener('pointerup', release);
  stick.addEventListener('pointercancel', release);

  const thr = root.querySelector('#tThrottle');
  const thrKnob = root.querySelector('#tThrKnob');
  const setThr = (e) => {
    const r = thr.getBoundingClientRect();
    touch.throttle = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
  };
  thr.addEventListener('pointerdown', (e) => { thr.setPointerCapture(e.pointerId); setThr(e); });
  thr.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') setThr(e); });
  touch.updateThrottleKnob = (v) => { thrKnob.style.bottom = `calc(${v * 100}% - 14px)`; };

  root.querySelectorAll('[data-key]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); pressedQueue.push(b.dataset.key); });
  });
  root.querySelectorAll('[data-hold]').forEach((b) => {
    const on = (v) => (e) => {
      e.preventDefault();
      if (b.dataset.hold === 'brake') touch.brake = v;
      if (b.dataset.hold === 'rudderL') touch.rudder = v ? -1 : 0;
      if (b.dataset.hold === 'rudderR') touch.rudder = v ? 1 : 0;
      b.classList.toggle('on', v);
    };
    b.addEventListener('pointerdown', on(true));
    b.addEventListener('pointerup', on(false));
    b.addEventListener('pointercancel', on(false));
    b.addEventListener('pointerleave', on(false));
  });
}

// Discrete key presses since last call.
export function consumePresses() {
  const out = pressedQueue.slice();
  pressedQueue.length = 0;
  return out;
}

export function getLook(dt) {
  if (!look.dragging) {
    look.idle += dt;
    if (look.idle > 1.5) {
      const k = Math.min(1, dt * 2.5);
      look.yaw -= look.yaw * k;
      look.pitch -= look.pitch * k;
    }
  }
  return look;
}

const anyHeld = (...codes) => codes.some((c) => held.has(c));

function approach(cur, target, rate, dt) {
  const d = target - cur;
  const step = rate * dt;
  return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
}

function readGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p || p.mapping !== 'standard') continue;
    const dz = (v) => (Math.abs(v) < 0.08 ? 0 : v);
    return {
      roll: dz(p.axes[0]),
      pitch: dz(p.axes[1]),        // stick back (positive) = nose up
      rudder: dz(p.axes[2]),
      throttleRate: -dz(p.axes[3]),
      brake: p.buttons[6]?.value ?? 0,
      flapsDown: p.buttons[0]?.pressed,
      flapsUp: p.buttons[3]?.pressed,
      ap: p.buttons[2]?.pressed,
      cam: p.buttons[1]?.pressed,
    };
  }
  return null;
}

const padLatch = {};
function padPress(name, down, code) {
  if (down && !padLatch[name]) pressedQueue.push(code);
  padLatch[name] = down;
}

// Updates aircraft controls from the current input state.
// Returns the pilot's raw pitch/roll intent (used to steer the autopilot).
export function updateControls(ac, dt) {
  const c = ac.controls;
  const pad = readGamepad();
  const inv = options.invertPitch ? -1 : 1;

  let pitch = 0, roll = 0, yaw = 0;
  if (anyHeld('KeyS', 'ArrowDown')) pitch += 1;
  if (anyHeld('KeyW', 'ArrowUp')) pitch -= 1;
  if (anyHeld('KeyD', 'ArrowRight')) roll += 1;
  if (anyHeld('KeyA', 'ArrowLeft')) roll -= 1;
  if (held.has('KeyE')) yaw += 1;
  if (held.has('KeyQ')) yaw -= 1;
  pitch *= inv;

  let intent;
  if (touch.stickOn || touch.rudder) {
    // Touch stick: pull down for nose up, like a yoke. A little expo for fine control.
    const ex = (v) => Math.sign(v) * (0.35 * Math.abs(v) + 0.65 * v * v);
    c.elevator = ex(touch.stickY) * inv;
    c.aileron = ex(touch.stickX);
    c.rudder = approach(c.rudder, touch.rudder, 3, dt);
    intent = { pitch: c.elevator, roll: c.aileron };
  } else if (pad && (pad.pitch || pad.roll || pad.rudder)) {
    c.elevator = pad.pitch * inv;
    c.aileron = pad.roll;
    c.rudder = pad.rudder;
    intent = { pitch: c.elevator, roll: c.aileron };
  } else {
    // Keyboard: surfaces move at a finite rate and centre when released.
    c.elevator = approach(c.elevator, pitch, pitch ? 1.6 : 2.5, dt);
    c.aileron = approach(c.aileron, roll, roll ? 2.5 : 3.5, dt);
    c.rudder = approach(c.rudder, yaw, yaw ? 2.0 : 3.0, dt);
    intent = { pitch, roll };
  }

  let thr = 0;
  if (anyHeld('KeyR', 'PageUp')) thr += 1;
  if (anyHeld('KeyF', 'PageDown')) thr -= 1;
  if (pad) thr += pad.throttleRate;
  if (thr) c.throttle = clamp(c.throttle + thr * 0.6 * dt, 0, 1);
  for (let d = 0; d <= 9; d++) if (held.has(`Digit${d}`)) c.throttle = d === 0 ? 1 : d / 10;
  if (touch.active) {
    if (touch.throttle !== null) { c.throttle = touch.throttle; touch.throttle = null; }
    touch.updateThrottleKnob?.(c.throttle);
  }

  if (held.has('BracketLeft')) ac.trim = clamp(ac.trim - 0.15 * dt, -0.5, 0.5);
  if (held.has('BracketRight')) ac.trim = clamp(ac.trim + 0.15 * dt, -0.5, 0.5);

  c.brake = Math.max(held.has('KeyB') ? 1 : 0, touch.brake ? 1 : 0, pad && pad.brake > 0.1 ? pad.brake : 0);

  if (pad) {
    padPress('flapsDown', pad.flapsDown, 'KeyG');
    padPress('flapsUp', pad.flapsUp, 'KeyT');
    padPress('ap', pad.ap, 'KeyZ');
    padPress('cam', pad.cam, 'KeyC');
  }
  return intent;
}
