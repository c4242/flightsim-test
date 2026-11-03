// Keyboard, gamepad and mouse-look input. Produces smoothed control positions.

import { clamp } from './noise.js';

const held = new Set();
const pressedQueue = [];
const look = { yaw: 0, pitch: 0, dragging: false, idle: 0 };

export const KEYMAP = [
  ['W / S  or  ↑ / ↓', 'Pitch (nose down / nose up)'],
  ['A / D  or  ← / →', 'Roll left / right'],
  ['Q / E', 'Rudder left / right (steers on the ground)'],
  ['R / F', 'Throttle up / down'],
  ['G / T', 'Flaps down / up'],
  ['B', 'Wheel brakes (hold)'],
  ['[ / ]', 'Elevator trim nose down / up'],
  ['C', 'Change camera (chase, cockpit, tower)'],
  ['Mouse drag', 'Look around'],
  ['H', 'Show / hide instrument panel'],
  ['M', 'Mute sound'],
  ['P or Esc', 'Pause menu'],
  ['Enter', 'Restart after a crash'],
];

export function initInput(canvas) {
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (!held.has(e.code)) pressedQueue.push(e.code);
    held.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', (e) => held.delete(e.code));
  addEventListener('blur', () => held.clear());

  canvas.addEventListener('pointerdown', (e) => {
    look.dragging = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', () => { look.dragging = false; look.idle = 0; });
  canvas.addEventListener('pointermove', (e) => {
    if (!look.dragging) return;
    look.yaw = clamp(look.yaw - e.movementX * 0.006, -Math.PI, Math.PI);
    look.pitch = clamp(look.pitch - e.movementY * 0.006, -1.2, 1.2);
  });
  canvas.addEventListener('dblclick', () => { look.yaw = look.pitch = 0; });
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
    };
  }
  return null;
}

let padFlapLatch = false;

// Updates aircraft controls from the current input state.
export function updateControls(ac, dt) {
  const c = ac.controls;
  const pad = readGamepad();

  let pitch = 0, roll = 0, yaw = 0;
  if (anyHeld('KeyS', 'ArrowDown')) pitch += 1;
  if (anyHeld('KeyW', 'ArrowUp')) pitch -= 1;
  if (anyHeld('KeyD', 'ArrowRight')) roll += 1;
  if (anyHeld('KeyA', 'ArrowLeft')) roll -= 1;
  if (held.has('KeyE')) yaw += 1;
  if (held.has('KeyQ')) yaw -= 1;

  if (pad && (pad.pitch || pad.roll || pad.rudder)) {
    c.elevator = pad.pitch;
    c.aileron = pad.roll;
    c.rudder = pad.rudder;
  } else {
    // Keyboard: surfaces move at a finite rate and centre when released.
    c.elevator = approach(c.elevator, pitch, pitch ? 1.6 : 2.5, dt);
    c.aileron = approach(c.aileron, roll, roll ? 2.5 : 3.5, dt);
    c.rudder = approach(c.rudder, yaw, yaw ? 2.0 : 3.0, dt);
  }

  let thr = 0;
  if (anyHeld('KeyR', 'PageUp')) thr += 1;
  if (anyHeld('KeyF', 'PageDown')) thr -= 1;
  if (pad) thr += pad.throttleRate;
  c.throttle = clamp(c.throttle + thr * 0.6 * dt, 0, 1);

  if (held.has('BracketLeft')) ac.trim = clamp(ac.trim - 0.15 * dt, -0.5, 0.5);
  if (held.has('BracketRight')) ac.trim = clamp(ac.trim + 0.15 * dt, -0.5, 0.5);

  const braking = held.has('KeyB') || (pad && pad.brake > 0.1);
  c.brake = braking ? Math.max(pad?.brake ?? 0, held.has('KeyB') ? 1 : 0) : 0;

  if (pad) {
    const f = pad.flapsDown || pad.flapsUp;
    if (f && !padFlapLatch) ac.flaps = clamp(ac.flaps + (pad.flapsDown ? 1 : -1), 0, 2);
    padFlapLatch = f;
  }
}
