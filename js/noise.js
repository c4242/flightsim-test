// Seeded 2D value noise with fractal (fBm) and ridged variants.

export function createNoise(seed = 1) {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rand() * 2 - 1;

  function value(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const v00 = vals[perm[X + perm[Y]]];
    const v10 = vals[perm[X + 1 + perm[Y]]];
    const v01 = vals[perm[X + perm[Y + 1]]];
    const v11 = vals[perm[X + 1 + perm[Y + 1]]];
    const u = xf * xf * (3 - 2 * xf);
    const w = yf * yf * (3 - 2 * yf);
    const a = v00 + (v10 - v00) * u;
    const b = v01 + (v11 - v01) * u;
    return a + (b - a) * w;
  }

  // Fractal sum, roughly in [-1, 1].
  function fbm(x, y, octaves = 5) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * value(x * freq + i * 17.3, y * freq - i * 9.1);
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;
  }

  // Ridged fractal in [0, 1]: sharp crests, good for mountain ranges.
  function ridged(x, y, octaves = 5) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0, prev = 1;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(value(x * freq + i * 31.7, y * freq + i * 11.3));
      n *= n;
      sum += n * amp * prev;
      prev = n;
      norm += amp;
      amp *= 0.5;
      freq *= 2.1;
    }
    return sum / norm;
  }

  return { value, fbm, ridged };
}

export const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
