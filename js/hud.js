// 2D overlay: round flight instruments, status readouts, cockpit HUD and messages.

import * as THREE from 'three';
import { SPEC } from './aircraft.js';

const MS_TO_KT = 1.94384;
const M_TO_FT = 3.28084;
const DEG = 180 / Math.PI;

export function createHud(canvas) {
  const g = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  let showPanel = true;
  const messages = [];
  const _p = new THREE.Vector3();

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }
  resize();
  addEventListener('resize', resize);

  function message(text, color = '#fff', seconds = 3.5) {
    messages.push({ text, color, t: seconds, total: seconds });
    if (messages.length > 3) messages.shift();
  }

  // ---------- Gauge helpers ----------
  function bezel(x, y, R, label) {
    g.save();
    g.beginPath(); g.arc(x, y, R + 4, 0, Math.PI * 2);
    g.fillStyle = '#2b2e33'; g.fill();
    g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2);
    g.fillStyle = '#0d0f12'; g.fill();
    g.restore();
    if (label) {
      g.fillStyle = '#9aa3ad';
      g.font = `${Math.round(R * 0.13)}px "Share Tech Mono", monospace`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, x, y + R * 0.42);
    }
  }

  function ticks(x, y, R, a0, a1, n, len, width, color = '#e8e8e8') {
    g.strokeStyle = color; g.lineWidth = width;
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      g.beginPath();
      g.moveTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
      g.lineTo(x + Math.cos(a) * (R - len), y + Math.sin(a) * (R - len));
      g.stroke();
    }
  }

  function needle(x, y, R, a, len, width, color = '#fff') {
    g.save();
    g.translate(x, y); g.rotate(a);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(-R * 0.12, -width); g.lineTo(R * len, 0); g.lineTo(-R * 0.12, width);
    g.closePath(); g.fill();
    g.restore();
    g.beginPath(); g.arc(x, y, R * 0.06, 0, Math.PI * 2); g.fillStyle = '#555'; g.fill();
  }

  function numbersAround(x, y, R, values, angleOf, size) {
    g.fillStyle = '#eee';
    g.font = `${size}px "Share Tech Mono", monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const v of values) {
      const a = angleOf(v);
      g.fillText(String(v), x + Math.cos(a) * R, y + Math.sin(a) * R);
    }
  }

  function arc(x, y, R, a0, a1, color, width) {
    g.beginPath(); g.arc(x, y, R, a0, a1);
    g.strokeStyle = color; g.lineWidth = width; g.stroke();
  }

  // ---------- Instruments ----------
  function airspeed(x, y, R, kt) {
    bezel(x, y, R, 'KNOTS');
    const A0 = -Math.PI / 2, SPAN = Math.PI * 2 * (320 / 360), MAX = 200;
    const ang = (v) => A0 + Math.min(v, MAX) / MAX * SPAN;
    arc(x, y, R * 0.86, ang(46), ang(85), '#eeeeee', R * 0.05);
    arc(x, y, R * 0.92, ang(52), ang(130), '#2fbf4a', R * 0.07);
    arc(x, y, R * 0.92, ang(130), ang(160), '#e5c22d', R * 0.07);
    ticks(x, y, R * 0.97, ang(160), ang(162), 1, R * 0.16, 3, '#e33');
    ticks(x, y, R * 0.97, ang(0), ang(200), 20, R * 0.1, 1.5);
    numbersAround(x, y, R * 0.68, [40, 80, 120, 160, 200], ang, Math.round(R * 0.15));
    needle(x, y, R, ang(Math.max(0, kt)), 0.85, R * 0.04);
  }

  function attitude(x, y, R, pitch, roll) {
    bezel(x, y, R, null);
    g.save();
    g.beginPath(); g.arc(x, y, R * 0.96, 0, Math.PI * 2); g.clip();
    g.translate(x, y); g.rotate(-roll);
    const pxPerDeg = R / 30;
    const off = pitch * DEG * pxPerDeg;
    g.fillStyle = '#3d7cc9'; g.fillRect(-R * 2, -R * 4 + off, R * 4, R * 4);
    g.fillStyle = '#7a5530'; g.fillRect(-R * 2, off, R * 4, R * 4);
    g.strokeStyle = '#fff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-R * 2, off); g.lineTo(R * 2, off); g.stroke();
    g.lineWidth = 1.2;
    g.fillStyle = '#fff';
    g.font = `${Math.round(R * 0.11)}px "Share Tech Mono", monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 5) {
      if (!p) continue;
      const yy = off - p * pxPerDeg;
      const half = p % 10 === 0 ? R * 0.28 : R * 0.13;
      g.beginPath(); g.moveTo(-half, yy); g.lineTo(half, yy); g.stroke();
      if (p % 10 === 0) { g.fillText(Math.abs(p), -half - R * 0.12, yy); g.fillText(Math.abs(p), half + R * 0.12, yy); }
    }
    // Bank scale (rotates with the horizon).
    for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const a = -Math.PI / 2 + b / DEG;
      const l = b % 30 === 0 ? R * 0.12 : R * 0.07;
      g.beginPath();
      g.moveTo(Math.cos(a) * R * 0.95, Math.sin(a) * R * 0.95);
      g.lineTo(Math.cos(a) * (R * 0.95 - l), Math.sin(a) * (R * 0.95 - l));
      g.stroke();
    }
    g.restore();
    // Fixed aircraft symbol and bank pointer.
    g.strokeStyle = '#ffb21a'; g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x - R * 0.5, y); g.lineTo(x - R * 0.18, y); g.lineTo(x - R * 0.08, y + R * 0.08);
    g.moveTo(x + R * 0.5, y); g.lineTo(x + R * 0.18, y); g.lineTo(x + R * 0.08, y + R * 0.08);
    g.stroke();
    g.fillStyle = '#ffb21a';
    g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
    g.beginPath();
    g.moveTo(x, y - R * 0.82); g.lineTo(x - R * 0.06, y - R * 0.72); g.lineTo(x + R * 0.06, y - R * 0.72);
    g.closePath(); g.fill();
  }

  function altimeter(x, y, R, ft) {
    bezel(x, y, R, 'ALT FT');
    const ang = (v) => -Math.PI / 2 + (v / 10) * Math.PI * 2;
    ticks(x, y, R * 0.97, -Math.PI / 2, Math.PI * 1.5, 50, R * 0.06, 1);
    ticks(x, y, R * 0.97, -Math.PI / 2, Math.PI * 1.5, 10, R * 0.13, 2);
    numbersAround(x, y, R * 0.72, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], ang, Math.round(R * 0.17));
    // Digital window.
    g.fillStyle = '#000'; g.fillRect(x - R * 0.36, y + R * 0.15, R * 0.72, R * 0.22);
    g.fillStyle = '#7cf'; g.font = `${Math.round(R * 0.17)}px "Share Tech Mono", monospace`;
    g.fillText(String(Math.round(ft / 10) * 10).padStart(5, ' '), x, y + R * 0.27);
    needle(x, y, R, ang(((ft / 1000) % 10 + 10) % 10), 0.5, R * 0.07);
    needle(x, y, R, ang(((ft / 100) % 10 + 10) % 10), 0.88, R * 0.035);
  }

  function headingIndicator(x, y, R, hdg) {
    bezel(x, y, R, null);
    g.save();
    g.translate(x, y); g.rotate(-hdg);
    g.strokeStyle = '#eee';
    for (let d = 0; d < 360; d += 5) {
      const a = d / DEG - Math.PI / 2;
      const l = d % 30 === 0 ? R * 0.14 : d % 10 === 0 ? R * 0.09 : R * 0.05;
      g.lineWidth = d % 10 === 0 ? 1.6 : 1;
      g.beginPath();
      g.moveTo(Math.cos(a) * R * 0.96, Math.sin(a) * R * 0.96);
      g.lineTo(Math.cos(a) * (R * 0.96 - l), Math.sin(a) * (R * 0.96 - l));
      g.stroke();
    }
    g.fillStyle = '#eee';
    g.font = `${Math.round(R * 0.16)}px "Share Tech Mono", monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let d = 0; d < 360; d += 30) {
      g.save();
      g.rotate(d / DEG);
      g.fillStyle = labels[d] ? '#ffcc33' : '#eee';
      g.fillText(labels[d] ?? String(d / 10), 0, -R * 0.66);
      g.restore();
    }
    g.restore();
    // Aircraft symbol.
    g.strokeStyle = '#ffb21a'; g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x, y - R * 0.4); g.lineTo(x, y + R * 0.35);
    g.moveTo(x - R * 0.3, y - R * 0.05); g.lineTo(x + R * 0.3, y - R * 0.05);
    g.moveTo(x - R * 0.12, y + R * 0.3); g.lineTo(x + R * 0.12, y + R * 0.3);
    g.stroke();
    g.fillStyle = '#ffb21a';
    g.beginPath(); g.moveTo(x, y - R * 0.98); g.lineTo(x - R * 0.06, y - R * 0.86); g.lineTo(x + R * 0.06, y - R * 0.86); g.fill();
  }

  function vsi(x, y, R, fpm) {
    bezel(x, y, R, 'VS ×100');
    const ang = (v) => Math.PI + Math.max(-20, Math.min(20, v / 100)) / 20 * Math.PI * 0.9;
    ticks(x, y, R * 0.97, ang(-2000), ang(2000), 20, R * 0.08, 1.2);
    numbersAround(x, y, R * 0.7, [0, 5, 10, 15, 20], (v) => ang(-v * 100), Math.round(R * 0.15));
    numbersAround(x, y, R * 0.7, [5, 10, 15, 20], (v) => ang(v * 100), Math.round(R * 0.15));
    g.fillStyle = '#9aa3ad';
    g.font = `${Math.round(R * 0.12)}px "Share Tech Mono", monospace`;
    g.fillText('UP', x - R * 0.35, y - R * 0.25);
    g.fillText('DN', x - R * 0.35, y + R * 0.25);
    needle(x, y, R, ang(fpm), 0.85, R * 0.04);
  }

  function tach(x, y, R, rpm) {
    bezel(x, y, R, 'RPM ×100');
    const A0 = Math.PI * 0.75, SPAN = Math.PI * 1.5, MAX = 3000;
    const ang = (v) => A0 + Math.min(v, MAX) / MAX * SPAN;
    arc(x, y, R * 0.9, ang(2100), ang(2700), '#2fbf4a', R * 0.08);
    ticks(x, y, R * 0.97, ang(2700), ang(2720), 1, R * 0.16, 3, '#e33');
    ticks(x, y, R * 0.97, ang(0), ang(3000), 30, R * 0.07, 1);
    ticks(x, y, R * 0.97, ang(0), ang(3000), 6, R * 0.13, 2);
    numbersAround(x, y, R * 0.68, [0, 5, 10, 15, 20, 25, 30], (v) => ang(v * 100), Math.round(R * 0.15));
    needle(x, y, R, ang(rpm), 0.85, R * 0.04);
  }

  function sideStrip(x, y, h, ac) {
    // Throttle, flaps, trim, brakes.
    const w = h * 0.12;
    const bar = (bx, label, frac, color, center = false) => {
      g.fillStyle = '#0d0f12'; g.fillRect(bx, y, w, h);
      g.strokeStyle = '#555'; g.strokeRect(bx, y, w, h);
      g.fillStyle = color;
      if (center) {
        const mid = y + h / 2, len = -frac * h / 2;
        g.fillRect(bx + 2, Math.min(mid, mid + len), w - 4, Math.max(2, Math.abs(len)));
      } else g.fillRect(bx + 2, y + h * (1 - frac), w - 4, h * frac);
      g.fillStyle = '#9aa3ad';
      g.font = `${Math.round(h * 0.09)}px "Share Tech Mono", monospace`;
      g.textAlign = 'center';
      g.fillText(label, bx + w / 2, y + h + h * 0.1);
    };
    bar(x, 'THR', ac.controls.throttle, '#e0e0e0');
    bar(x + w * 1.8, 'FLP', ac.flaps / 2, '#7cf');
    bar(x + w * 3.6, 'TRM', ac.trim / 0.5, '#9f6', true);
    const lamp = (ly, label, on, color) => {
      g.fillStyle = on ? color : '#222';
      g.fillRect(x + w * 5.4, ly, w * 3.2, h * 0.2);
      g.fillStyle = on ? '#000' : '#555';
      g.font = `bold ${Math.round(h * 0.1)}px "Share Tech Mono", monospace`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, x + w * 7, ly + h * 0.1);
    };
    const flash = Math.floor(performance.now() / 250) % 2 === 0;
    lamp(y, 'STALL', ac.stalling && flash, '#ff3b30');
    lamp(y + h * 0.27, 'BRAKE', ac.controls.brake > 0, '#ffb21a');
    lamp(y + h * 0.54, 'GROUND', ac.onGround, '#2fbf4a');
    lamp(y + h * 0.81, 'LOW ALT', !ac.onGround && ac.agl < 60 && ac.vel.y < -5, '#ffb21a');
  }

  // ---------- Cockpit HUD (pitch ladder + flight path marker) ----------
  function cockpitHud(ac, camera) {
    const project = (dir) => {
      _p.copy(camera.position).addScaledVector(dir, 1000).project(camera);
      if (_p.z > 1) return null;
      return [(_p.x * 0.5 + 0.5) * W, (-_p.y * 0.5 + 0.5) * H];
    };
    g.save();
    g.strokeStyle = 'rgba(120,255,140,0.85)';
    g.fillStyle = 'rgba(120,255,140,0.9)';
    g.lineWidth = 1.5;
    g.font = '13px "Share Tech Mono", monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const h = ac.heading;
    const dir = new THREE.Vector3();
    for (let p = -60; p <= 60; p += 10) {
      const pr = p / DEG;
      dir.set(Math.sin(h) * Math.cos(pr), Math.sin(pr), -Math.cos(h) * Math.cos(pr));
      const s = project(dir);
      if (!s) continue;
      const len = p === 0 ? 260 : 80;
      g.save();
      g.translate(s[0], s[1]);
      g.rotate(-ac.roll);
      g.beginPath();
      if (p < 0) g.setLineDash([8, 6]);
      g.moveTo(-len, 0); g.lineTo(-30, 0);
      g.moveTo(30, 0); g.lineTo(len, 0);
      g.stroke();
      g.setLineDash([]);
      if (p) { g.fillText(String(p), -len - 18, 0); g.fillText(String(p), len + 18, 0); }
      g.restore();
    }
    // Flight path marker: where the aircraft is actually going.
    if (ac.speed > 5) {
      const s = project(dir.copy(ac.vel).normalize());
      if (s) {
        g.beginPath(); g.arc(s[0], s[1], 8, 0, Math.PI * 2);
        g.moveTo(s[0] - 20, s[1]); g.lineTo(s[0] - 8, s[1]);
        g.moveTo(s[0] + 8, s[1]); g.lineTo(s[0] + 20, s[1]);
        g.moveTo(s[0], s[1] - 8); g.lineTo(s[0], s[1] - 16);
        g.stroke();
      }
    }
    // Heading tape.
    const deg = h * DEG;
    const cx = W / 2, ty = 30;
    for (let d = Math.ceil((deg - 30) / 5) * 5; d <= deg + 30; d += 5) {
      const xx = cx + (d - deg) * 8;
      const nd = ((d % 360) + 360) % 360;
      g.beginPath(); g.moveTo(xx, ty); g.lineTo(xx, ty + (d % 10 === 0 ? 10 : 5)); g.stroke();
      if (d % 10 === 0) g.fillText(String(nd).padStart(3, '0'), xx, ty + 22);
    }
    g.beginPath(); g.moveTo(cx, ty - 2); g.lineTo(cx - 6, ty - 10); g.lineTo(cx + 6, ty - 10); g.closePath(); g.fill();
    g.restore();
  }

  function readouts(ac, x, y) {
    const kt = ac.speed * MS_TO_KT;
    const rows = [
      ['IAS', `${Math.round(kt * Math.sqrt(Math.exp(-Math.max(0, ac.altitude) / 8500)))} kt`],
      ['ALT', `${Math.round(ac.altitude * M_TO_FT)} ft`],
      ['AGL', `${Math.max(0, Math.round(ac.agl * M_TO_FT))} ft`],
      ['HDG', `${String(Math.round(ac.heading * DEG) % 360).padStart(3, '0')}°`],
      ['VS', `${Math.round(ac.vel.y * 196.85 / 10) * 10} fpm`],
      ['AOA', `${(ac.alpha * DEG).toFixed(1)}°`],
      ['G', (ac.gLoad ?? 1).toFixed(1)],
      ['THR', `${Math.round(ac.controls.throttle * 100)}%`],
      ['FLAPS', `${SPEC.flaps[ac.flaps][0]}°`],
    ];
    g.font = '14px "Share Tech Mono", monospace';
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = 'rgba(10,14,20,0.45)';
    g.fillRect(x - 8, y - 6, 150, rows.length * 18 + 10);
    rows.forEach(([k, v], i) => {
      g.fillStyle = '#9fb3c8'; g.fillText(k, x, y + i * 18);
      g.fillStyle = '#fff'; g.fillText(v, x + 52, y + i * 18);
    });
  }

  function draw(ac, camera, cameraMode, dt) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    if (cameraMode === 'cockpit') cockpitHud(ac, camera);
    readouts(ac, 16, 16);

    if (showPanel) {
      const R = Math.max(34, Math.min(72, W / 17, H / 9));
      const gap = R * 2.3;
      const n = 6;
      const panelW = gap * n + R * 3.2;
      const px = (W - panelW) / 2;
      const cy = H - R - 16;
      g.fillStyle = 'rgba(20,22,26,0.82)';
      g.beginPath();
      g.roundRect(px - 10, cy - R - 10, panelW + 20, R * 2 + 20, 12);
      g.fill();
      let x = px + R + 4;
      const kt = ac.speed * MS_TO_KT * Math.sqrt(Math.exp(-Math.max(0, ac.altitude) / 8500));
      airspeed(x, cy, R, kt); x += gap;
      attitude(x, cy, R, ac.pitch, ac.roll); x += gap;
      altimeter(x, cy, R, ac.altitude * M_TO_FT); x += gap;
      tach(x, cy, R, ac.rpm); x += gap;
      headingIndicator(x, cy, R, ac.heading); x += gap;
      vsi(x, cy, R, ac.vel.y * 196.85); x += gap;
      sideStrip(x - R + 6, cy - R * 0.85, R * 1.55, ac);
    }

    // Messages.
    for (let i = messages.length - 1; i >= 0; i--) {
      messages[i].t -= dt;
      if (messages[i].t <= 0) messages.splice(i, 1);
    }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 22px "Share Tech Mono", monospace';
    messages.forEach((m, i) => {
      g.globalAlpha = Math.min(1, m.t / 0.6);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      const tw = g.measureText(m.text).width;
      g.fillRect(W / 2 - tw / 2 - 14, H * 0.22 + i * 40 - 17, tw + 28, 34);
      g.fillStyle = m.color;
      g.fillText(m.text, W / 2, H * 0.22 + i * 40);
    });
    g.globalAlpha = 1;
  }

  return {
    draw,
    message,
    togglePanel() { showPanel = !showPanel; },
    clearMessages() { messages.length = 0; },
  };
}
