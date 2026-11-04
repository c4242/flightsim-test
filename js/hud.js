// 2D overlay: round flight instruments, status readouts, cockpit HUD, maps and messages.
// The same gauge drawing code also paints the 3D cockpit panel texture.

import * as THREE from 'three';
import { MS_TO_KT } from './aircraft.js';
import { AIRFIELDS, VILLAGES, terrainHeight, fieldToWorld } from './terrain.js';

const M_TO_FT = 3.28084;
const DEG = 180 / Math.PI;
const FONT = '"Share Tech Mono", ui-monospace, monospace';

// ---------- Island map image (computed once) ----------
const MAP_RANGE = 22000; // metres shown edge to edge
function buildMapImage() {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const m = MAP_RANGE / S;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const wx = -MAP_RANGE / 2 + x * m, wz = -MAP_RANGE / 2 + y * m;
      const h = terrainHeight(wx, wz);
      // Hill shading from the north-west.
      const shade = (terrainHeight(wx - m, wz - m) - h) * 0.02;
      let r, gg, b;
      if (h < 0) { const d = Math.min(1, -h / 40); r = 40 - d * 15; gg = 92 - d * 30; b = 128 - d * 30; }
      else if (h < 6) { r = 210; gg = 196; b = 150; }
      else if (h < 300) { r = 92 + h * 0.15; gg = 138 + h * 0.05; b = 70; }
      else if (h < 900) { const t = (h - 300) / 600; r = 137 + t * 20; gg = 150 - t * 30; b = 90 + t * 20; }
      else { const t = Math.min(1, (h - 900) / 400); r = 160 + t * 80; gg = 155 + t * 85; b = 140 + t * 100; }
      const k = 1 - Math.max(-0.35, Math.min(0.35, shade));
      const i = (y * S + x) * 4;
      img.data[i] = r * k; img.data[i + 1] = gg * k; img.data[i + 2] = b * k; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Runways.
  g.strokeStyle = '#1a1a1a';
  g.lineCap = 'round';
  for (const f of AIRFIELDS) {
    const a = fieldToWorld(f, -f.length / 2, 0), b = fieldToWorld(f, f.length / 2, 0);
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo((a.x + MAP_RANGE / 2) / m, (a.z + MAP_RANGE / 2) / m);
    g.lineTo((b.x + MAP_RANGE / 2) / m, (b.z + MAP_RANGE / 2) / m);
    g.stroke();
  }
  return cv;
}

export function createHud(canvas) {
  let g = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  let showPanel = true;
  let panelBar = true; // the big gauge panel / engine strip (off on small touch screens)
  let showMap = false;
  let compact = false;
  const messages = [];
  const _p = new THREE.Vector3();
  const _d = new THREE.Vector3();
  let mapImage = null;
  let landing = null; // last landing report
  let curNav = null;   // current ILS guidance (or null)
  let curTanker = null;

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  }
  resize();
  addEventListener('resize', resize);

  function message(text, color = '#fff', seconds = 3.5) {
    messages.push({ text, color, t: seconds });
    if (messages.length > 3) messages.shift();
  }

  // ---------- Gauge helpers ----------
  function bezel(x, y, R, label) {
    g.beginPath(); g.arc(x, y, R + 4, 0, Math.PI * 2);
    g.fillStyle = '#2b2e33'; g.fill();
    g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2);
    g.fillStyle = '#0d0f12'; g.fill();
    if (label) {
      g.fillStyle = '#9aa3ad';
      g.font = `${Math.round(R * 0.13)}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, x, y + R * 0.42);
    }
  }

  function ticks(x, y, R, a0, a1, n, len, width, color = '#e8e8e8') {
    g.strokeStyle = color; g.lineWidth = width;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      g.moveTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
      g.lineTo(x + Math.cos(a) * (R - len), y + Math.sin(a) * (R - len));
    }
    g.stroke();
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
    g.font = `${size}px ${FONT}`;
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
    arc(x, y, R * 0.92, ang(130), ang(165), '#e5c22d', R * 0.07);
    ticks(x, y, R * 0.97, ang(165), ang(167), 1, R * 0.16, 3, '#e33');
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
    g.font = `${Math.round(R * 0.11)}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let p = -30; p <= 30; p += 5) {
      if (!p) continue;
      const yy = off - p * pxPerDeg;
      const half = p % 10 === 0 ? R * 0.28 : R * 0.13;
      g.beginPath(); g.moveTo(-half, yy); g.lineTo(half, yy); g.stroke();
      if (p % 10 === 0) { g.fillText(Math.abs(p), -half - R * 0.12, yy); g.fillText(Math.abs(p), half + R * 0.12, yy); }
    }
    for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const a = -Math.PI / 2 + b / DEG;
      const l = b % 30 === 0 ? R * 0.12 : R * 0.07;
      g.beginPath();
      g.moveTo(Math.cos(a) * R * 0.95, Math.sin(a) * R * 0.95);
      g.lineTo(Math.cos(a) * (R * 0.95 - l), Math.sin(a) * (R * 0.95 - l));
      g.stroke();
    }
    g.restore();
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
    // ILS: localizer (vertical) and glideslope (horizontal) needles, with deviation dots.
    if (curNav) {
      const k = R * 0.62;
      g.fillStyle = 'rgba(255,255,255,0.8)';
      for (let i = -2; i <= 2; i++) {
        if (!i) continue;
        g.beginPath(); g.arc(x + (i / 2) * k, y + R * 0.55, 2.2, 0, 7); g.fill();
        g.beginPath(); g.arc(x + R * 0.82, y + (i / 2) * k, 2.2, 0, 7); g.fill();
      }
      g.strokeStyle = '#ff4fd8'; g.lineWidth = 3;
      g.beginPath();
      const lx = x + curNav.loc * k;
      g.moveTo(lx, y - R * 0.6); g.lineTo(lx, y + R * 0.6);
      if (curNav.gsValid) { const gy = y - curNav.gs * k; g.moveTo(x - R * 0.6, gy); g.lineTo(x + R * 0.6, gy); }
      g.stroke();
    }
  }

  function altimeter(x, y, R, ft) {
    bezel(x, y, R, 'ALT FT');
    const ang = (v) => -Math.PI / 2 + (v / 10) * Math.PI * 2;
    ticks(x, y, R * 0.97, -Math.PI / 2, Math.PI * 1.5, 50, R * 0.06, 1);
    ticks(x, y, R * 0.97, -Math.PI / 2, Math.PI * 1.5, 10, R * 0.13, 2);
    numbersAround(x, y, R * 0.72, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], ang, Math.round(R * 0.17));
    g.fillStyle = '#000'; g.fillRect(x - R * 0.36, y + R * 0.15, R * 0.72, R * 0.22);
    g.fillStyle = '#7cf'; g.font = `${Math.round(R * 0.17)}px ${FONT}`;
    g.fillText(String(Math.round(ft / 10) * 10).padStart(5, ' '), x, y + R * 0.27);
    needle(x, y, R, ang(((ft / 1000) % 10 + 10) % 10), 0.5, R * 0.07);
    needle(x, y, R, ang(((ft / 100) % 10 + 10) % 10), 0.88, R * 0.035);
  }

  function headingIndicator(x, y, R, hdg, bug) {
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
    g.font = `${Math.round(R * 0.16)}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let d = 0; d < 360; d += 30) {
      g.save();
      g.rotate(d / DEG);
      g.fillStyle = labels[d] ? '#ffcc33' : '#eee';
      g.fillText(labels[d] ?? String(d / 10), 0, -R * 0.66);
      g.restore();
    }
    if (bug !== null && bug !== undefined) {
      g.save();
      g.rotate(bug);
      g.fillStyle = '#ff4fd8';
      g.fillRect(-R * 0.07, -R * 0.99, R * 0.14, R * 0.1);
      g.restore();
    }
    g.restore();
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
    numbersAround(x, y, R * 0.7, [5, 10, 15], (v) => ang(v * 100), Math.round(R * 0.15));
    g.fillStyle = '#9aa3ad';
    g.font = `${Math.round(R * 0.12)}px ${FONT}`;
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

  function sideStrip(x, y, h, ac, ap) {
    const w = h * 0.12;
    const bar = (bx, label, frac, color, center = false) => {
      g.fillStyle = '#0d0f12'; g.fillRect(bx, y, w, h);
      g.strokeStyle = '#555'; g.lineWidth = 1; g.strokeRect(bx, y, w, h);
      g.fillStyle = color;
      if (center) {
        const mid = y + h / 2, len = -frac * h / 2;
        g.fillRect(bx + 2, Math.min(mid, mid + len), w - 4, Math.max(2, Math.abs(len)));
      } else g.fillRect(bx + 2, y + h * (1 - frac), w - 4, h * frac);
      g.fillStyle = '#9aa3ad';
      g.font = `${Math.round(h * 0.09)}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, bx + w / 2, y + h + h * 0.08);
    };
    bar(x, 'THR', ac.controls.throttle, '#e0e0e0');
    bar(x + w * 1.6, 'FLP', ac.flaps / 2, '#7cf');
    bar(x + w * 3.2, 'TRM', ac.trim / 0.5, '#9f6', true);
    const flash = Math.floor(performance.now() / 250) % 2 === 0;
    const lamps = [
      ['STALL', ac.stalling && flash, '#ff3b30'],
      ['LIMIT', ac.limitWarning && flash, '#ff3b30'],
      ['BRAKE', ac.controls.brake > 0, '#ffb21a'],
      ['A/P', ap?.on, '#ff4fd8'],
      ['GND', ac.onGround, '#2fbf4a'],
      ['LOW', !ac.onGround && ac.agl < 60 && ac.vel.y < -5, '#ffb21a'],
    ];
    const lw = w * 2.8, lh = h * 0.15;
    lamps.forEach(([label, on, color], i) => {
      const lx = x + w * 4.9 + (i % 2) * (lw + w * 0.3);
      const ly = y + Math.floor(i / 2) * (lh + h * 0.12);
      g.fillStyle = on ? color : '#222';
      g.fillRect(lx, ly, lw, lh);
      g.fillStyle = on ? '#000' : '#555';
      g.font = `bold ${Math.round(h * 0.085)}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, lx + lw / 2, ly + lh / 2);
    });
    return x + w * 4.9 + lw * 2 + w * 0.3;
  }

  // Draws the six-pack + strip in a row; returns the width used.
  function sixPack(x0, cy, R, ac, ap, dryRun = false) {
    const gap = R * 2.3;
    if (!dryRun) {
      let x = x0 + R + 4;
      airspeed(x, cy, R, ac.ias * MS_TO_KT); x += gap;
      attitude(x, cy, R, ac.pitch, ac.roll); x += gap;
      altimeter(x, cy, R, ac.altitude * M_TO_FT); x += gap;
      tach(x, cy, R, ac.rpm); x += gap;
      headingIndicator(x, cy, R, ac.heading, ap?.on ? ap.heading : null); x += gap;
      vsi(x, cy, R, ac.vel.y * 196.85); x += gap;
      return sideStrip(x - R + 4, cy - R * 0.85, R * 1.55, ac, ap) - x0;
    }
    return gap * 6 + R * 2.05 + 8;
  }

  // Paints the instrument panel onto the 3D cockpit texture.
  function drawPanelTexture(cv, ac, ap) {
    const prev = g;
    g = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#2e3238');
    grad.addColorStop(1, '#1d2024');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    // Screws and a placard for a bit of texture.
    g.fillStyle = '#4a4f57';
    for (const [sx, sy] of [[12, 12], [w - 12, 12], [12, h - 12], [w - 12, h - 12]]) { g.beginPath(); g.arc(sx, sy, 4, 0, 7); g.fill(); }
    const R = h * 0.2;
    g.save();
    // Two rows: the classic six-pack layout, plus the strip along the bottom.
    const gap = R * 2.35;
    const top = h * 0.29, bot = h * 0.72;
    const cx = w * 0.38;
    airspeed(cx - gap, top, R, ac.ias * MS_TO_KT);
    attitude(cx, top, R, ac.pitch, ac.roll);
    altimeter(cx + gap, top, R, ac.altitude * M_TO_FT);
    tach(cx - gap, bot, R, ac.rpm);
    headingIndicator(cx, bot, R, ac.heading, ap?.on ? ap.heading : null);
    vsi(cx + gap, bot, R, ac.vel.y * 196.85);
    sideStrip(cx + gap * 1.75, top - R * 0.8, R * 2.4, ac, ap);
    g.restore();
    g = prev;
  }

  // ---------- Cockpit HUD (pitch ladder + flight path marker) ----------
  function project(camera, worldPoint) {
    _p.copy(worldPoint).project(camera);
    const behind = _p.z > 1;
    return { x: (_p.x * 0.5 + 0.5) * W, y: (-_p.y * 0.5 + 0.5) * H, behind };
  }

  function cockpitHud(ac, camera) {
    g.save();
    // Keep the HUD within the windscreen, above the glare shield.
    g.beginPath(); g.rect(0, 0, W, H * 0.6); g.clip();
    g.strokeStyle = 'rgba(120,255,140,0.85)';
    g.fillStyle = 'rgba(120,255,140,0.9)';
    g.lineWidth = 1.5;
    g.font = `13px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const h = ac.heading;
    for (let p = -60; p <= 60; p += 10) {
      const pr = p / DEG;
      _d.set(Math.sin(h) * Math.cos(pr), Math.sin(pr), -Math.cos(h) * Math.cos(pr)).multiplyScalar(1000).add(camera.position);
      const s = project(camera, _d);
      if (s.behind) continue;
      const len = p === 0 ? 260 : 80;
      g.save();
      g.translate(s.x, s.y);
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
    if (ac.speed > 5) {
      _d.copy(ac.vel).normalize().multiplyScalar(1000).add(camera.position);
      const s = project(camera, _d);
      if (!s.behind) {
        g.beginPath(); g.arc(s.x, s.y, 8, 0, Math.PI * 2);
        g.moveTo(s.x - 20, s.y); g.lineTo(s.x - 8, s.y);
        g.moveTo(s.x + 8, s.y); g.lineTo(s.x + 20, s.y);
        g.moveTo(s.x, s.y - 8); g.lineTo(s.x, s.y - 16);
        g.stroke();
      }
    }
    const deg = h * DEG;
    const cx = W / 2, ty = 30;
    for (let d = Math.ceil((deg - 30) / 5) * 5; d <= deg + 30; d += 5) {
      const xx = cx + (d - deg) * 8;
      const nd = ((d % 360) + 360) % 360;
      g.beginPath(); g.moveTo(xx, ty); g.lineTo(xx, ty + (d % 10 === 0 ? 10 : 5)); g.stroke();
      if (d % 10 === 0) g.fillText(String(nd).padStart(3, '0'), xx, ty + 22);
    }
    g.beginPath(); g.moveTo(cx, ty - 2); g.lineTo(cx - 6, ty - 10); g.lineTo(cx + 6, ty - 10); g.closePath(); g.fill();
    // Speed and altitude boxes.
    g.font = `16px ${FONT}`;
    g.strokeRect(cx - 230, H * 0.45 - 14, 70, 28);
    g.strokeRect(cx + 160, H * 0.45 - 14, 80, 28);
    g.fillText(String(Math.round(ac.ias * MS_TO_KT)), cx - 195, H * 0.45);
    g.fillText(String(Math.round(ac.altitude * M_TO_FT)), cx + 200, H * 0.45);
    g.font = `11px ${FONT}`;
    g.fillText('KT', cx - 195, H * 0.45 + 24);
    g.fillText('FT', cx + 200, H * 0.45 + 24);
    g.restore();
  }

  function readouts(ac, x, y, wind, ap, extra) {
    const kt = ac.ias * MS_TO_KT;
    const windSpd = Math.hypot(wind.x, wind.z);
    let windFrom = Math.atan2(-wind.x, wind.z) * DEG;
    if (windFrom < 0) windFrom += 360;
    const rows = [
      ['IAS', `${Math.round(kt)} kt`],
      ['GS', `${Math.round(ac.groundSpeed * MS_TO_KT)} kt`],
      ['ALT', `${Math.round(ac.altitude * M_TO_FT)} ft`],
      ['AGL', `${Math.max(0, Math.round(ac.agl * M_TO_FT))} ft`],
      ['HDG', `${String(Math.round(ac.heading * DEG) % 360).padStart(3, '0')}°`],
      ['VS', `${Math.round(ac.vel.y * 196.85 / 10) * 10} fpm`],
      ['AOA', `${(ac.alpha * DEG).toFixed(1)}°`],
      ['G', ac.gLoad.toFixed(1)],
      ['WIND', windSpd < 0.5 ? 'calm' : `${String(Math.round(windFrom)).padStart(3, '0')}° ${Math.round(windSpd * MS_TO_KT)} kt`],
    ];
    if (ac.type?.kind === 'jet') {
      rows[0] = ['KCAS', `${Math.round(kt)} kt`];
      rows.splice(1, 0, ['MACH', ac.mach.toFixed(2)]);
      rows.push(['FUEL', `${Math.round(ac.fuel * 2.20462 / 10) * 10} lb`]);
    }
    if (curNav) rows.push(['ILS', `${curNav.name.slice(4)} ${curNav.dme.toFixed(1)} NM`]);
    if (ap?.on) rows.push(['A/P', `${String(Math.round(ap.heading * DEG) % 360).padStart(3, '0')}° ${Math.round(ap.altitude * M_TO_FT / 10) * 10} ft`]);
    if (extra) rows.push(...extra);
    const lh = compact ? 15 : 18;
    g.font = `${compact ? 12 : 14}px ${FONT}`;
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = 'rgba(10,14,20,0.45)';
    g.fillRect(x - 8, y - 6, compact ? 150 : 178, rows.length * lh + 10);
    rows.forEach(([k, v], i) => {
      g.fillStyle = k === 'A/P' ? '#ff9fe8' : '#9fb3c8'; g.fillText(k, x, y + i * lh);
      g.fillStyle = '#fff'; g.fillText(v, x + (compact ? 44 : 50), y + i * lh);
    });
    // Wind arrow relative to the nose.
    if (windSpd >= 0.5) {
      const ax = x + (compact ? 125 : 150), ay = y + rows.findIndex((r) => r[0] === 'WIND') * lh + lh / 2;
      const rel = Math.atan2(wind.x, -wind.z) - ac.heading; // direction the wind blows towards, relative to nose
      g.save();
      g.translate(ax, ay);
      g.rotate(rel);
      g.strokeStyle = '#7cf'; g.fillStyle = '#7cf'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, 8); g.lineTo(0, -6); g.stroke();
      g.beginPath(); g.moveTo(0, -10); g.lineTo(-4, -4); g.lineTo(4, -4); g.closePath(); g.fill();
      g.restore();
    }
  }

  // ---------- Maps ----------
  function drawMinimap(ac, rings, cx, cy, r) {
    if (!mapImage) mapImage = buildMapImage();
    const range = 7000; // metres across
    const S = mapImage.width;
    const mpp = MAP_RANGE / S;
    g.save();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = '#1e4a66'; g.fill();
    g.clip();
    const scale = (2 * r) / range; // px per metre
    const sx = (ac.pos.x + MAP_RANGE / 2) / mpp, sz = (ac.pos.z + MAP_RANGE / 2) / mpp;
    const srcSize = range / mpp;
    g.drawImage(mapImage, sx - srcSize / 2, sz - srcSize / 2, srcSize, srcSize, cx - r, cy - r, 2 * r, 2 * r);
    if (rings?.active) drawRingsOnMap(rings, (wx, wz) => [cx + (wx - ac.pos.x) * scale, cy + (wz - ac.pos.z) * scale], 3);
    if (curTanker && ac.type?.kind === 'jet') {
      const tx = cx + (curTanker.pos.x - ac.pos.x) * scale, ty = cy + (curTanker.pos.z - ac.pos.z) * scale;
      g.fillStyle = '#7cf'; g.beginPath(); g.arc(tx, ty, 4, 0, 7); g.fill();
    }
    g.restore();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#fff'; g.font = `bold 12px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', cx, cy - r + 10);
    planeIcon(cx, cy, ac.heading, 9);
  }

  function drawRingsOnMap(rings, toScreen, size) {
    rings.points.forEach((p, i) => {
      if (i < rings.index) return;
      const [x, y] = toScreen(p.x, p.z);
      g.beginPath(); g.arc(x, y, i === rings.index ? size + 2 : size, 0, Math.PI * 2);
      g.strokeStyle = i === rings.index ? '#3dff7a' : '#ffb21a'; g.lineWidth = 2; g.stroke();
    });
  }

  function planeIcon(x, y, hdg, s) {
    g.save();
    g.translate(x, y); g.rotate(hdg);
    g.fillStyle = '#ffd23a'; g.strokeStyle = '#000'; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -s); g.lineTo(s * 0.25, -s * 0.2); g.lineTo(s, s * 0.1); g.lineTo(s, s * 0.35); g.lineTo(s * 0.2, s * 0.2);
    g.lineTo(s * 0.15, s * 0.7); g.lineTo(s * 0.45, s * 0.95); g.lineTo(-s * 0.45, s * 0.95); g.lineTo(-s * 0.15, s * 0.7);
    g.lineTo(-s * 0.2, s * 0.2); g.lineTo(-s, s * 0.35); g.lineTo(-s, s * 0.1); g.lineTo(-s * 0.25, -s * 0.2);
    g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  function drawFullMap(ac, rings) {
    if (!mapImage) mapImage = buildMapImage();
    const size = Math.min(W, H) * 0.86;
    const x0 = (W - size) / 2, y0 = (H - size) / 2;
    g.fillStyle = 'rgba(5,10,18,0.75)';
    g.fillRect(0, 0, W, H);
    g.drawImage(mapImage, x0, y0, size, size);
    g.strokeStyle = '#9fb3c8'; g.lineWidth = 2; g.strokeRect(x0, y0, size, size);
    const toScreen = (wx, wz) => [x0 + (wx / MAP_RANGE + 0.5) * size, y0 + (wz / MAP_RANGE + 0.5) * size];
    g.font = `bold 14px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `12px ${FONT}`;
    for (const v of VILLAGES) {
      const [x, y] = toScreen(v.x, v.z);
      g.fillStyle = '#ffe9b0'; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#000'; g.fillText(v.name, x + 7, y + 1);
      g.fillStyle = '#ffe9b0'; g.fillText(v.name, x + 6, y);
    }
    if (mapTarget) {
      const [x, y] = toScreen(mapTarget.x, mapTarget.z);
      g.strokeStyle = '#ffb21a'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.stroke();
    }
    g.font = `bold 14px ${FONT}`;
    for (const f of AIRFIELDS) {
      const [x, y] = toScreen(f.x, f.z);
      g.fillStyle = '#000'; g.fillText(`${f.name} ${f.numbers.join('/')} · ${Math.round(f.elevation * M_TO_FT)} ft`, x + 13, y + 1);
      g.fillStyle = '#fff'; g.fillText(`${f.name} ${f.numbers.join('/')} · ${Math.round(f.elevation * M_TO_FT)} ft`, x + 12, y);
    }
    if (rings?.active) {
      g.strokeStyle = 'rgba(255,178,26,0.6)'; g.lineWidth = 1.5; g.setLineDash([6, 5]);
      g.beginPath();
      rings.points.forEach((p, i) => { const [x, y] = toScreen(p.x, p.z); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke(); g.setLineDash([]);
      drawRingsOnMap(rings, toScreen, 5);
    }
    if (curTanker) {
      const [tx, ty] = toScreen(curTanker.pos.x, curTanker.pos.z);
      g.fillStyle = '#7cf'; g.beginPath(); g.arc(tx, ty, 5, 0, 7); g.fill();
      g.font = `12px ${FONT}`; g.textAlign = 'left'; g.fillText('TANKER FL200', tx + 8, ty);
    }
    const [px, py] = toScreen(ac.pos.x, ac.pos.z);
    planeIcon(px, py, ac.heading, 12);
    // Scale bar (2 km) and north arrow.
    const bar = 2000 / MAP_RANGE * size;
    g.fillStyle = '#fff'; g.fillRect(x0 + 20, y0 + size - 24, bar, 4);
    g.font = `12px ${FONT}`; g.textAlign = 'left';
    g.fillText('2 km', x0 + 24 + bar, y0 + size - 22);
    g.textAlign = 'center';
    g.fillText('N ▲', x0 + size - 30, y0 + 22);
    g.fillText('N: close map', W / 2, y0 + size + 18 > H - 10 ? H - 14 : y0 + size + 18);
  }

  // Arrow at the screen edge (or marker on screen) pointing to the next ring.
  function guide(ac, camera, target, color) {
    if (!target) return;
    const s = project(camera, target);
    const dist = ac.pos.distanceTo(target);
    const onScreen = !s.behind && s.x > 40 && s.x < W - 40 && s.y > 40 && s.y < H - 40;
    g.save();
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2;
    g.font = `bold 13px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (onScreen) {
      g.beginPath(); g.arc(s.x, s.y, 14, 0, Math.PI * 2); g.stroke();
      g.fillText(`${(dist / 1000).toFixed(1)} km`, s.x, s.y + 26);
    } else {
      let dx = s.x - W / 2, dy = s.y - H / 2;
      if (s.behind) { dx = -dx; dy = -dy; }
      const a = Math.atan2(dy, dx);
      const rx = W / 2 - 60, ry = H / 2 - 60;
      const k = Math.min(rx / Math.abs(Math.cos(a) || 1e-6), ry / Math.abs(Math.sin(a) || 1e-6));
      const ex = W / 2 + Math.cos(a) * k, ey = H / 2 + Math.sin(a) * k;
      g.save(); g.translate(ex, ey); g.rotate(a);
      g.beginPath(); g.moveTo(16, 0); g.lineTo(-8, -10); g.lineTo(-8, 10); g.closePath(); g.fill();
      g.restore();
      g.fillText(`${(dist / 1000).toFixed(1)} km`, ex - Math.cos(a) * 26, ey - Math.sin(a) * 26);
    }
    g.restore();
  }

  function ringStatus(rings) {
    const t = rings.time;
    const fmt = (v) => `${Math.floor(v / 60)}:${(v % 60).toFixed(1).padStart(4, '0')}`;
    const text = rings.finished
      ? `FINISHED ${fmt(t)}${rings.best ? `  ·  best ${fmt(rings.best)}` : ''}`
      : `RING ${rings.index + 1}/${rings.points.length}  ·  ${fmt(t)}${rings.best ? `  ·  best ${fmt(rings.best)}` : ''}`;
    g.font = `bold 16px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(text).width;
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(W / 2 - tw / 2 - 12, 58, tw + 24, 28);
    g.fillStyle = '#3dff7a';
    g.fillText(text, W / 2, 72);
  }

  function landingCard(dt) {
    if (!landing) return;
    landing.t -= dt;
    if (landing.t <= 0) { landing = null; return; }
    const e = landing.e;
    const lines = [
      [`LANDING · ${e.field}`, '#fff'],
      [`Score ${e.score}/100`, e.score >= 80 ? '#9f6' : e.score >= 50 ? '#fc6' : '#f86'],
      [`Sink rate ${Math.round(e.fpm)} ft/min`, '#dde'],
      [`Touchdown ${Math.round(e.fromThreshold)} m past threshold (aim ${landing.aim} m)`, '#dde'],
      [`Off centreline ${Math.abs(e.centreline).toFixed(1)} m · crab ${Math.abs(e.crab).toFixed(0)}°`, '#dde'],
    ];
    g.font = `14px ${FONT}`;
    const w = Math.max(...lines.map(([t]) => g.measureText(t).width)) + 28;
    const h = lines.length * 20 + 16;
    const x = W - w - 16, y = compact ? 16 : Math.max(340, H * 0.42);
    g.globalAlpha = Math.min(1, landing.t);
    g.fillStyle = 'rgba(10,14,20,0.7)';
    g.fillRect(x, y, w, h);
    g.textAlign = 'left'; g.textBaseline = 'top';
    lines.forEach(([t, c], i) => { g.fillStyle = c; g.fillText(t, x + 14, y + 10 + i * 20); });
    g.globalAlpha = 1;
  }

  // Wraps text to a maximum width; returns the lines.
  function wrap(text, maxW) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }

  function objectivesPanel(m) {
    const mission = m.mission;
    const fs = compact ? 12 : 13;
    const w = compact ? Math.min(330, W * 0.42) : m.time < 14 ? 330 : 260;
    const x = compact ? W / 2 - w / 2 : 8, y = compact ? 8 : 230;
    g.font = `${fs}px ${FONT}`;
    // Show the briefing for the first few seconds of the mission.
    const brief = m.time < 14 && m.state === 'active' ? wrap(mission.brief, w - 24) : [];
    // After the briefing, collapse to the current objective to keep the view clear.
    const collapsed = !brief.length && m.state === 'active';
    const items = mission.objectives.filter((o, i) => !collapsed || i === m.index).flatMap((o) => {
      const i = mission.objectives.indexOf(o);
      const done = i < m.index || m.state === 'complete';
      const mark = done ? '✓' : i === m.index ? '▸' : '·';
      const col = done ? '#8fd18f' : i === m.index ? '#ffcf6a' : '#9aa8b8';
      return wrap(`${mark} ${o.text}`, w - 24).map((t, k) => [k ? `  ${t}` : t, col]);
    });
    const lh = fs + 5;
    const h = 30 + (brief.length ? brief.length * lh + 8 : 0) + items.length * lh;
    g.fillStyle = 'rgba(10,14,20,0.6)';
    g.fillRect(x, y, w, h);
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = '#fff'; g.font = `bold ${fs + 1}px ${FONT}`;
    g.fillText(mission.title.toUpperCase(), x + 12, y + 8);
    g.font = `${fs}px ${FONT}`;
    let yy = y + 28;
    g.fillStyle = '#cfe8ff';
    for (const t of brief) { g.fillText(t, x + 12, yy); yy += lh; }
    if (brief.length) yy += 8;
    for (const [t, c] of items) { g.fillStyle = c; g.fillText(t, x + 12, yy); yy += lh; }
  }

  function replayBanner(rp) {
    const fmt = (v) => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
    const text = `▶ REPLAY  ${fmt(Math.min(rp.t, rp.duration))} / ${fmt(rp.duration)}   ·   C: camera   ·   V or Esc: exit`;
    g.font = `bold 16px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const tw = g.measureText(text).width;
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(W / 2 - tw / 2 - 16, 14, tw + 32, 34);
    g.fillStyle = '#ff5a5a';
    g.fillText(text, W / 2, 31, W - 40);
    // Progress bar.
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(W * 0.2, H - 14, W * 0.6, 4);
    g.fillStyle = '#ff5a5a'; g.fillRect(W * 0.2, H - 14, W * 0.6 * Math.min(1, rp.t / Math.max(rp.duration, 0.1)), 4);
  }

  let mapTarget = null;

  // Air-to-air refuelling status and the boom operator's director cues.
  function refuelPanel(tk) {
    if (!tk || !tk.cues) return;
    const c = tk.cues;
    const contact = tk.state === 'contact';
    const w = 300, h = 96, x = W / 2 - w / 2, y = H - (compact ? 120 : 200);
    g.fillStyle = 'rgba(8,12,18,0.7)';
    g.fillRect(x, y, w, h);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `bold 16px ${FONT}`;
    g.fillStyle = contact ? '#3dff6e' : '#ffcf6a';
    g.fillText(contact ? 'CONTACT' : 'PRE-CONTACT', x + w / 2, y + 16);
    g.font = `bold 20px ${FONT}`;
    const cue = (txt, cx) => { g.fillStyle = txt ? '#ffffff' : '#56606b'; g.fillText(txt || '—', cx, y + 48); };
    cue(c.vertical, x + w * 0.2); cue(c.fore, x + w * 0.5); cue(c.lateral, x + w * 0.8);
    g.font = `12px ${FONT}`; g.fillStyle = '#9aa8b8';
    const geo = tk.geometry;
    g.fillText(geo ? `elev ${geo.elev.toFixed(0)}°  az ${geo.az.toFixed(0)}°  boom ${geo.r.toFixed(1)} m  closure ${geo.relSpeed.toFixed(1)} m/s` : '', x + w / 2, y + 72);
    if (tk.totalTransferred > 0) g.fillText(`received ${Math.round(tk.totalTransferred * 2.20462)} lb`, x + w / 2, y + 88);
  }


  // ================= F-16 style HUD =================
  const HUDC = '#56ff86';
  const kgToLb = 2.20462;
  // Turbine inlet temperature estimate for the engine gauges.
  const ftit = (ac) => Math.round(ac.engineFailed || ac.fuel <= 0 ? 200 + ac.n2 * 300 : 420 + Math.pow(Math.max(0, ac.n2 - 0.68) / 0.32, 1.4) * 450 + (ac.abLit ? 40 : 0));

  // glass: the HUD combiner's outline on screen in the 3D cockpit ({ poly, cx, cy, w, h, top }):
  // the symbology is then laid out on it and clipped to it, like the real HUD.
  function jetHud(ac, camera, conformal, warnings, glass = null) {
    g.save();
    g.strokeStyle = HUDC; g.fillStyle = HUDC; g.lineWidth = 1.6;
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 3;
    let cx = W / 2, cy = conformal ? H * 0.4 : H * 0.42;
    // Layout scale for the tapes and readouts.
    let k = Math.max(0.55, Math.min(1, W / 1100, H / 620));
    if (glass) {
      cx = glass.cx; cy = glass.cy;
      k = Math.max(0.45, Math.min(1.2, glass.w / 480));
      g.beginPath();
      glass.poly.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.clip();
    }
    const pxPerRad = H / (2 * Math.tan((camera.fov * Math.PI / 180) / 2));
    // ---- Flight path marker and boresight ----
    let fx, fy;
    if (conformal) {
      _d.copy(ac.vel).normalize().multiplyScalar(1000).add(camera.position);
      const s = project(camera, _d);
      fx = s.x; fy = s.y;
      _d.set(0, 0, -1000).applyQuaternion(ac.quat).add(camera.position);
      const b = project(camera, _d);
      if (!b.behind) { g.beginPath(); g.moveTo(b.x - 9, b.y); g.lineTo(b.x + 9, b.y); g.moveTo(b.x, b.y - 9); g.lineTo(b.x, b.y + 9); g.stroke(); }
    } else {
      fx = cx - ac.beta * pxPerRad * 0.6;
      fy = cy + ac.alpha * pxPerRad * 0.6;
      g.beginPath(); g.moveTo(cx - 9, cy); g.lineTo(cx + 9, cy); g.moveTo(cx, cy - 9); g.lineTo(cx, cy + 9); g.stroke();
    }
    if (ac.speed > 10 && fx > 0 && fy > 0 && fx < W && fy < H) {
      g.beginPath(); g.arc(fx, fy, 7, 0, Math.PI * 2);
      g.moveTo(fx - 20, fy); g.lineTo(fx - 7, fy); g.moveTo(fx + 7, fy); g.lineTo(fx + 20, fy);
      g.moveTo(fx, fy - 7); g.lineTo(fx, fy - 15);
      g.stroke();
      // Landing AoA bracket (gear down): FPM centred in the bracket = 13° on-speed AoA.
      if (ac.gearDown > 0.5 && !ac.onGround) {
        const by = fy + (13 - ac.alpha * DEG) * 5;
        g.beginPath();
        g.moveTo(fx - 28, by - 12); g.lineTo(fx - 34, by - 12); g.lineTo(fx - 34, by + 12); g.lineTo(fx - 28, by + 12);
        g.stroke();
      }
    }
    // ---- ILS steering: localizer and glideslope bars relative to the flight path marker ----
    if (curNav && (ac.gearDown > 0.5 || curNav.dme < 12)) {
      const k = 55;
      g.save();
      g.lineWidth = 2;
      const lx = fx + curNav.loc * k;
      g.beginPath(); g.moveTo(lx, fy - k); g.lineTo(lx, fy + k);
      if (curNav.gsValid) { const gy = fy - curNav.gs * k; g.moveTo(fx - k, gy); g.lineTo(fx + k, gy); }
      g.stroke();
      g.restore();
    }
    // ---- Pitch ladder (conformal only) ----
    if (conformal) {
      g.save();
      if (!glass) { g.beginPath(); g.rect(cx - 260, 50, 520, H * 0.62); g.clip(); }
      g.font = `12px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const h = ac.heading;
      for (let p = -85; p <= 85; p += 5) {
        const pr = p / DEG;
        _d.set(Math.sin(h) * Math.cos(pr), Math.sin(pr), -Math.cos(h) * Math.cos(pr)).multiplyScalar(1000).add(camera.position);
        const s = project(camera, _d);
        if (s.behind) continue;
        g.save();
        g.translate(s.x, s.y);
        g.rotate(-ac.roll);
        if (glass) g.scale(k, k);
        g.beginPath();
        if (p === 0) {
          g.moveTo(-200, 0); g.lineTo(-30, 0); g.moveTo(30, 0); g.lineTo(200, 0);
        } else {
          const tip = p > 0 ? 8 : -8;
          if (p < 0) g.setLineDash([7, 5]);
          // Lines bend towards the horizon more steeply the further from it.
          const bend = p * 0.25;
          g.moveTo(-70, tip + bend * 0); g.lineTo(-70, 0); g.lineTo(-28, -bend * 0.5);
          g.moveTo(28, -bend * 0.5); g.lineTo(70, 0); g.lineTo(70, tip);
        }
        g.stroke();
        g.setLineDash([]);
        if (p) { g.fillText(String(Math.abs(p)), -86, 0); g.fillText(String(Math.abs(p)), 86, 0); }
        g.restore();
      }
      g.restore();
    }
    // ---- Tapes, readouts and warnings: scaled down on small screens so they don't crowd the view ----
    g.save();
    g.translate(cx, cy); g.scale(k, k); g.translate(-cx, -cy);
    g.lineWidth = 1.6 / k;
    // ---- Heading tape ----
    g.font = `13px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const deg = ac.heading * DEG;
    const ty = glass ? cy + (glass.top + 10 - cy) / k : Math.max(conformal ? 62 : 70, cy - (cy - 62) / k + 8);
    for (let d = Math.ceil((deg - 25) / 5) * 5; d <= deg + 25; d += 5) {
      const xx = cx + (d - deg) * 7;
      g.beginPath(); g.moveTo(xx, ty); g.lineTo(xx, ty + (d % 10 === 0 ? 9 : 5)); g.stroke();
      if (d % 10 === 0) g.fillText(String(((Math.round(d / 10) % 36) + 36) % 36).padStart(2, '0'), xx, ty + 20);
    }
    g.beginPath(); g.moveTo(cx, ty - 2); g.lineTo(cx - 5, ty - 9); g.lineTo(cx + 5, ty - 9); g.closePath(); g.fill();
    // ---- Airspeed tape (KCAS) ----
    const kcas = ac.ias * MS_TO_KT;
    const tapeX = glass ? 125 : 230; // on the combiner the tapes sit closer in, as on the real HUD
    const ax = cx - tapeX;
    g.save();
    g.beginPath(); g.rect(ax - 60, cy - 110, 80, 220); g.clip();
    for (let v = Math.floor((kcas - 40) / 10) * 10; v <= kcas + 40; v += 10) {
      if (v < 0) continue;
      const yy = cy + (kcas - v) * 2.6;
      g.beginPath(); g.moveTo(ax + 8, yy); g.lineTo(ax + (v % 50 === 0 ? -4 : 2), yy); g.stroke();
      if (v % 50 === 0) { g.textAlign = 'right'; g.fillText(String(v), ax - 8, yy); }
    }
    g.restore();
    g.clearRect(ax - 62, cy - 12, 58, 24);
    g.strokeRect(ax - 62, cy - 12, 58, 24);
    g.textAlign = 'right'; g.font = `bold 15px ${FONT}`;
    g.fillText(String(Math.round(kcas)), ax - 8, cy + 1);
    g.font = `14px ${FONT}`; g.textAlign = 'left';
    g.fillText(`${ac.gLoad.toFixed(1)}`, ax - 62, cy - 132);
    g.fillText(`M ${ac.mach.toFixed(2)}`, ax - 62, cy + 128);
    g.fillText(`α ${(ac.alpha * DEG).toFixed(1)}`, ax - 62, cy + 148);
    g.fillText(ac.fcsMode === 'TO/L' ? 'T/O-L' : 'NAV', ax - 62, cy + 168);
    if (ac.abLit) g.fillText('AB', ax - 62, cy + 188);
    // ---- Altitude tape ----
    const alt = ac.altitude * M_TO_FT;
    const bx = cx + tapeX;
    g.save();
    g.beginPath(); g.rect(bx - 20, cy - 110, 110, 220); g.clip();
    g.font = `13px ${FONT}`;
    for (let v = Math.floor((alt - 450) / 100) * 100; v <= alt + 450; v += 100) {
      const yy = cy + (alt - v) * 0.24;
      g.beginPath(); g.moveTo(bx - 8, yy); g.lineTo(bx + (v % 500 === 0 ? 4 : -2), yy); g.stroke();
      if (v % 500 === 0) { g.textAlign = 'left'; g.fillText(String(v), bx + 8, yy); }
    }
    g.restore();
    g.clearRect(bx + 4, cy - 12, 74, 24);
    g.strokeRect(bx + 4, cy - 12, 74, 24);
    g.textAlign = 'left'; g.font = `bold 15px ${FONT}`;
    g.fillText(String(Math.round(alt / 10) * 10), bx + 9, cy + 1);
    g.font = `14px ${FONT}`;
    if (ac.agl * M_TO_FT < 5000) g.fillText(`R ${String(Math.max(0, Math.round(ac.agl * M_TO_FT / 10) * 10)).padStart(4, '0')}`, bx + 4, cy + 128);
    g.fillText(`${Math.round(ac.vel.y * 196.85 / 100) * 100}`, bx + 4, cy - 128);
    if (curNav) { g.textAlign = 'left'; g.font = `14px ${FONT}`; g.fillText(`${curNav.name}  ${curNav.dme.toFixed(1)}`, bx + 4, cy + 148); }
    // ---- Warnings ----
    const flash = Math.floor(performance.now() / 300) % 2 === 0;
    g.font = `bold 20px ${FONT}`; g.textAlign = 'center';
    warnings.forEach((w, i) => { if (flash || w.steady) g.fillText(w.text, cx, cy + 92 + i * 26); });
    g.restore();
    g.restore();
  }

  function jetWarnings(ac) {
    const out = [];
    if (ac.gcas) out.push({ text: 'PULL UP' });
    if (ac.stalling) out.push({ text: 'AOA' });
    if (ac.overspeed) out.push({ text: 'OVERSPEED' });
    else if (ac.limitWarning) out.push({ text: 'OVER G' });
    if (ac.fuel <= 0 || ac.engineFailed) out.push({ text: 'ENGINE', steady: true });
    else if (ac.fuel < 700) out.push({ text: 'BINGO', steady: true });
    if (!ac.onGround && ac.gearDown > 0 && ac.ias > 150) out.push({ text: 'GEAR SPEED' });
    return out;
  }

  // Engine and systems strip shown at the bottom in the external views.
  function jetStrip(ac) {
    const w = Math.min(W - 20, 760), h = 74;
    const x0 = (W - w) / 2, y0 = H - h - 12;
    g.fillStyle = 'rgba(14,16,20,0.82)';
    g.beginPath(); g.roundRect(x0, y0, w, h, 10); g.fill();
    const cell = (i, label, value, color = '#e8eef5', frac = null) => {
      const cw = w / 8, x = x0 + cw * i + cw / 2;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#8fa3b8'; g.font = `11px ${FONT}`; g.fillText(label, x, y0 + 16);
      g.fillStyle = color; g.font = `bold 18px ${FONT}`; g.fillText(value, x, y0 + 40);
      if (frac !== null) {
        g.fillStyle = '#333a42'; g.fillRect(x - cw * 0.35, y0 + 56, cw * 0.7, 5);
        g.fillStyle = color; g.fillRect(x - cw * 0.35, y0 + 56, cw * 0.7 * Math.max(0, Math.min(1, frac)), 5);
      }
    };
    const thr = ac.controls.throttle;
    cell(0, 'THROTTLE', thr > 0.8 ? `AB ${Math.round((thr - 0.8) / 0.2 * 100)}%` : thr > 0.79 ? 'MIL' : `${Math.round(thr / 0.8 * 100)}%`, thr > 0.8 ? '#ffb347' : '#e8eef5', thr);
    cell(1, 'RPM %', `${Math.round(ac.n2 * 100)}`, ac.n2 > 1.0 ? '#ffb347' : '#e8eef5', (ac.n2 - 0.6) / 0.45);
    cell(2, 'NOZ %', `${Math.round(ac.nozzle * 100)}`, '#e8eef5', ac.nozzle);
    cell(3, 'FTIT °C', `${ftit(ac)}`, ftit(ac) > 900 ? '#ffb347' : '#e8eef5', (ftit(ac) - 300) / 700);
    cell(4, 'FUEL FLOW', `${Math.round(ac.fuelFlow / 100) * 100}`, '#e8eef5', ac.fuelFlow / 60000);
    const fuelLb = ac.fuel * kgToLb;
    cell(5, 'FUEL LB', `${Math.round(fuelLb / 10) * 10}`, fuelLb < 1500 ? '#ff6a4d' : '#e8eef5', fuelLb / 7000);
    // Gear: three greens when down and locked, red while moving.
    const gx = x0 + (w / 8) * 6.5, gy = y0 + 40;
    g.fillStyle = '#8fa3b8'; g.font = `11px ${FONT}`; g.fillText('GEAR', gx, y0 + 16);
    const gc = ac.gearDown >= 0.999 ? '#3dff6e' : ac.gearDown > 0 ? '#ff4040' : '#2a2f36';
    for (const [dx, dy] of [[0, -6], [-12, 8], [12, 8]]) { g.fillStyle = gc; g.beginPath(); g.arc(gx + dx, gy + dy, 5, 0, 7); g.fill(); }
    const sbx = x0 + (w / 8) * 7.5;
    g.fillStyle = '#8fa3b8'; g.fillText('SPD BRK', sbx, y0 + 16);
    g.fillStyle = ac.speedbrake > 0.02 ? '#ffd23a' : '#2a2f36';
    g.font = `bold 15px ${FONT}`; g.fillText(ac.speedbrake > 0.02 ? `${Math.round(ac.speedbrake * 60)}°` : 'IN', sbx, y0 + 40);
  }

  // One MFD page drawn to fill a canvas (used on the FlightGear cockpit's screens).
  function drawMfdPage(cv, ac, page) {
    const prev = g;
    g = cv.getContext('2d');
    const S = cv.width;
    g.fillStyle = '#020604'; g.fillRect(0, 0, S, S);
    g.strokeStyle = '#1d3a26'; g.lineWidth = 2; g.strokeRect(6, 6, S - 12, S - 12);
    g.fillStyle = '#56ff86'; g.font = `bold ${S * 0.055}px ${FONT}`; g.textBaseline = 'top'; g.textAlign = 'center';
    // Option labels round the edge, like the real OSB legends.
    const labels = page === 'engine' ? ['ENG', 'FUEL', 'SMS', 'HSD', 'SWAP'] : ['ADI', 'HSI', 'ILS', 'NAV', 'SWAP'];
    labels.forEach((l, i) => g.fillText(l, S * (0.1 + i * 0.2), S * 0.03));
    if (page === 'engine') {
      g.textAlign = 'left'; g.font = `bold ${S * 0.075}px ${FONT}`;
      const rows = [
        ['RPM', `${Math.round(ac.n2 * 100)} %`], ['NOZ', `${Math.round(ac.nozzle * 100)} %`], ['FTIT', `${ftit(ac)} C`],
        ['FF', `${Math.round(ac.fuelFlow / 100) * 100}`], ['FUEL', `${Math.round(ac.fuel * kgToLb / 10) * 10}`],
        ['THR', ac.abLit ? `AB ${Math.round(ac.ab * 100)}` : `${Math.round(Math.min(1, ac.controls.throttle / 0.8) * 100)} %`],
        ['GEAR', ac.gearDown >= 0.999 ? 'DOWN' : ac.gearDown > 0 ? 'TRANSIT' : 'UP'],
      ];
      rows.forEach(([k, v], i) => {
        g.fillStyle = '#7fe0a0'; g.fillText(k, S * 0.1, S * (0.16 + i * 0.11));
        g.fillStyle = '#ffffff'; g.fillText(v, S * 0.42, S * (0.16 + i * 0.11));
      });
    } else {
      attitude(S / 2, S * 0.36, S * 0.22, ac.pitch, ac.roll);
      headingIndicator(S / 2, S * 0.78, S * 0.16, ac.heading, null);
    }
    g = prev;
  }

  // Cockpit instrument panel for the F-16: engine MFD, attitude/heading MFD and annunciators.
  function drawJetPanelTexture(cv, ac) {
    const prev = g;
    g = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    g.fillStyle = '#25282c'; g.fillRect(0, 0, w, h);
    const mfd = (x, y, s) => {
      g.fillStyle = '#3a3e44'; g.fillRect(x - 14, y - 14, s + 28, s + 28);
      g.fillStyle = '#05080a'; g.fillRect(x, y, s, s);
      g.fillStyle = '#6b7178';
      for (let i = 0; i < 5; i++) { g.fillRect(x + s * (0.1 + i * 0.2) - 9, y - 12, 18, 8); g.fillRect(x + s * (0.1 + i * 0.2) - 9, y + s + 4, 18, 8); }
    };
    const S = 300, ly = 70;
    mfd(70, ly, S);
    mfd(w - 70 - S, ly, S);
    // Left MFD: engine page.
    g.fillStyle = '#56ff86'; g.font = `bold 26px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'top';
    const rows = [
      ['RPM', `${Math.round(ac.n2 * 100)} %`], ['NOZ', `${Math.round(ac.nozzle * 100)} %`], ['FTIT', `${ftit(ac)} C`],
      ['FF', `${Math.round(ac.fuelFlow / 100) * 100}`], ['FUEL', `${Math.round(ac.fuel * kgToLb / 10) * 10}`],
      ['THR', ac.abLit ? `AB ${Math.round(ac.ab * 100)}` : `${Math.round(Math.min(1, ac.controls.throttle / 0.8) * 100)} %`],
    ];
    rows.forEach(([k, v], i) => { g.fillStyle = '#7fe0a0'; g.fillText(k, 88, ly + 18 + i * 44); g.fillStyle = '#ffffff'; g.fillText(v, 200, ly + 18 + i * 44); });
    // Right MFD: attitude and heading.
    attitude(w - 70 - S / 2, ly + S * 0.32, S * 0.26, ac.pitch, ac.roll);
    headingIndicator(w - 70 - S / 2, ly + S * 0.76, S * 0.2, ac.heading, null);
    // Centre: annunciators and gear lights.
    const cxp = w / 2;
    const lamp = (y, text, on, color) => {
      g.fillStyle = on ? color : '#191c20'; g.fillRect(cxp - 70, y, 140, 34);
      g.fillStyle = on ? '#000' : '#4a5058'; g.font = `bold 18px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, cxp, y + 17);
    };
    const flash = Math.floor(performance.now() / 300) % 2 === 0;
    lamp(70, 'MASTER CAUTION', (ac.fuel < 700 || ac.engineFailed || ac.limitWarning) && flash, '#ffb21a');
    lamp(112, 'AOA', ac.stalling, '#ff3b30');
    lamp(154, 'AB', ac.abLit, '#ffb347');
    lamp(196, 'SPD BRK', ac.speedbrake > 0.02, '#ffd23a');
    lamp(238, ac.fcsMode === 'TO/L' ? 'T/O-L GAINS' : 'CRUISE GAINS', true, '#7fe0a0');
    const gc = ac.gearDown >= 0.999 ? '#3dff6e' : ac.gearDown > 0 ? '#ff4040' : '#191c20';
    for (const [dx, dy] of [[0, 300], [-30, 330], [30, 330]]) { g.fillStyle = gc; g.beginPath(); g.arc(cxp + dx, dy, 13, 0, 7); g.fill(); }
    g = prev;
  }

  const errors = [];
  function draw(ac, camera, cameraMode, dt, { wind, ap, rings, mission, replay, nav, tanker, hudGlass }) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    curNav = nav ?? null;
    curTanker = tanker ?? null;
    if (replay) { replayBanner(replay); return; }

    const jet = ac.type?.kind === 'jet';
    // The jet's HUD is part of the aircraft and is always shown; H only hides the panels and readouts.
    // Each part is guarded: a failure in one (reported on screen by the caller) mustn't blank the rest.
    try {
      if (jet) jetHud(ac, camera, cameraMode === 'cockpit', jetWarnings(ac), cameraMode === 'cockpit' ? hudGlass : null);
      else if (cameraMode === 'cockpit' && showPanel) cockpitHud(ac, camera);
    } catch (e) {
      for (let i = 0; i < 8; i++) g.restore();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      errors.push(e);
    }
    if (rings?.active) { guide(ac, camera, rings.next, '#3dff7a'); ringStatus(rings); }
    mapTarget = mission?.active ? mission.target : null;
    if (mapTarget) guide(ac, camera, mapTarget, '#ffb21a');
    if (mission?.mission) objectivesPanel(mission);
    if (showPanel) readouts(ac, 16, 16, wind, ap);
    if (showPanel && !compact) drawMinimap(ac, rings, W - 100, 100, 84);

    if (jet && showPanel && panelBar && cameraMode !== 'cockpit') jetStrip(ac);
    else if (!jet && showPanel && panelBar && cameraMode !== 'cockpit') {
      const R = Math.max(30, Math.min(72, W / 18, H / 9.5));
      const used = sixPack(0, 0, R, ac, ap, true);
      const px = Math.max(10, (W - used) / 2);
      const cy = H - R - 16;
      g.fillStyle = 'rgba(20,22,26,0.82)';
      g.beginPath();
      g.roundRect(px - 10, cy - R - 10, used + 20, R * 2 + 20, 12);
      g.fill();
      sixPack(px, cy, R, ac, ap);
    }

    if (ac.type?.kind === 'jet') refuelPanel(tanker);
    landingCard(dt);

    for (let i = messages.length - 1; i >= 0; i--) {
      messages[i].t -= dt;
      if (messages[i].t <= 0) messages.splice(i, 1);
    }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `bold ${compact ? 16 : 20}px ${FONT}`;
    const my = compact ? H * 0.42 : Math.max(H * 0.2, 230);
    messages.forEach((m, i) => {
      g.globalAlpha = Math.min(1, m.t / 0.6);
      g.fillStyle = 'rgba(0,0,0,0.45)';
      const tw = Math.min(W - 20, 760, g.measureText(m.text).width);
      g.fillRect(W / 2 - tw / 2 - 14, my + i * 38 - 16, tw + 28, 32);
      g.fillStyle = m.color;
      g.fillText(m.text, W / 2, my + i * 38, Math.min(W - 30, 750));
    });
    g.globalAlpha = 1;

    if (showMap) drawFullMap(ac, rings);
  }

  return {
    draw,
    // Errors caught while drawing since the last call (for the on-screen error report).
    takeErrors() { return errors.splice(0); },
    message,
    drawMfdPage,
    drawPanelTexture(cv, ac, ap) { if (ac.type?.kind === 'jet') drawJetPanelTexture(cv, ac); else drawPanelTexture(cv, ac, ap); },
    showLanding(e, aim) { landing = { e, aim, t: 7 }; },
    togglePanel() { showPanel = !showPanel; },
    set panelBar(v) { panelBar = v; },
    toggleMap() { showMap = !showMap; return showMap; },
    set compact(v) { compact = v; },
    clearMessages() { messages.length = 0; landing = null; },
  };
}
