// Sun lens flare drawn on its own canvas between the 3D view and the HUD: a starburst and halo
// at the sun, and coloured ghosts along the line through the screen centre, as a camera lens
// produces. It fades out when the sun is low, behind terrain, behind or inside cloud, or off-screen.

import * as THREE from 'three';
import { terrainHeight } from './terrain.js';

// [position along the sun-centre line (0 = sun, 1 = centre, 2 = mirrored), radius, rgb, alpha]
const GHOSTS = [
  [0.45, 0.035, [255, 200, 140], 0.10], [0.75, 0.018, [160, 220, 255], 0.14], [1.15, 0.05, [200, 255, 210], 0.07],
  [1.35, 0.024, [255, 180, 120], 0.12], [1.6, 0.09, [140, 170, 255], 0.05], [1.9, 0.04, [255, 230, 160], 0.08],
];

export function createFlare(canvas) {
  const g = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
  }
  resize();
  addEventListener('resize', resize);

  const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _q = new THREE.Vector3();
  let vis = 0, occlTimer = 0, occluded = false;

  // Is the line of sight to the sun blocked by terrain? (Checked a few times a second.)
  function terrainBlocks(from, dir) {
    for (let d = 60; d < 30000; d *= 1.25) {
      _q.copy(from).addScaledVector(dir, d);
      if (_q.y < terrainHeight(_q.x, _q.z)) return true;
      if (_q.y > 2000) break;
    }
    return false;
  }

  return {
    draw(camera, sunDir, { haze = 0, night = false, dt = 0.016, blockedByCockpit = false } = {}) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      occlTimer -= dt;
      if (occlTimer <= 0) { occluded = terrainBlocks(camera.position, sunDir); occlTimer = 0.2; }
      _p.copy(camera.position).addScaledVector(sunDir, 10000).project(camera);
      camera.getWorldDirection(_f);
      const facing = _f.dot(sunDir);
      const onScreen = _p.z < 1 && Math.abs(_p.x) < 1.15 && Math.abs(_p.y) < 1.15;
      let target = 0;
      if (!night && sunDir.y > -0.02 && onScreen && facing > 0 && !occluded && !blockedByCockpit) {
        target = Math.min(1, (sunDir.y + 0.02) * 6) * (1 - haze) * Math.pow(facing, 3);
      }
      vis += (target - vis) * Math.min(1, dt * 8);
      if (vis < 0.01) return;
      const sx = (_p.x * 0.5 + 0.5) * W, sy = (-_p.y * 0.5 + 0.5) * H;
      const cx = W / 2, cy = H / 2;
      const S = Math.min(W, H);
      g.globalCompositeOperation = 'lighter';
      // Halo and starburst at the sun.
      const halo = g.createRadialGradient(sx, sy, 0, sx, sy, S * 0.35);
      halo.addColorStop(0, `rgba(255,248,230,${0.55 * vis})`);
      halo.addColorStop(0.08, `rgba(255,235,200,${0.25 * vis})`);
      halo.addColorStop(1, 'rgba(255,220,180,0)');
      g.fillStyle = halo;
      g.fillRect(sx - S * 0.35, sy - S * 0.35, S * 0.7, S * 0.7);
      g.save();
      g.translate(sx, sy);
      for (let i = 0; i < 6; i++) {
        g.rotate(Math.PI / 6 + (i === 0 ? 0.2 : 0));
        const len = S * (i % 2 ? 0.16 : 0.28);
        const grd = g.createLinearGradient(-len, 0, len, 0);
        grd.addColorStop(0, 'rgba(255,240,220,0)');
        grd.addColorStop(0.5, `rgba(255,245,230,${0.35 * vis})`);
        grd.addColorStop(1, 'rgba(255,240,220,0)');
        g.fillStyle = grd;
        g.fillRect(-len, -1.2, len * 2, 2.4);
      }
      g.restore();
      // Ghosts along the line from the sun through the centre of the screen.
      for (const [t, r, c, a] of GHOSTS) {
        const gx = sx + (cx - sx) * t, gy = sy + (cy - sy) * t;
        const rad = r * S;
        const grad = g.createRadialGradient(gx, gy, rad * 0.6, gx, gy, rad);
        grad.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a * vis})`);
        grad.addColorStop(0.85, `rgba(${c[0]},${c[1]},${c[2]},${a * 1.6 * vis})`);
        grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        g.fillStyle = grad;
        g.beginPath(); g.arc(gx, gy, rad, 0, Math.PI * 2); g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    },
  };
}
