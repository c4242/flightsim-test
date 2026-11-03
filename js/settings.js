// Player settings, saved in the browser.

const KEY = 'skyhaven.settings';
const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export const DEFAULTS = {
  quality: isTouch ? 'low' : 'high',
  timeOfDay: 'noon',
  wind: 'light',
  invertPitch: false,
  volume: 0.5,
  lookSensitivity: 1,
};

export function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    Object.assign(s, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch { /* storage unavailable or corrupt: use defaults */ }
  const q = new URLSearchParams(location.search).get('quality');
  if (q === 'low' || q === 'high') s.quality = q;
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export { isTouch };
