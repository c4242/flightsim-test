// Tower radio: spoken clearances (Web Speech API) with subtitles. The tower clears you for
// takeoff when you line up, to land when you're established on final, and welcomes you after
// landing. Wind is read from the live weather.

import { AIRFIELDS, fieldLocal } from './terrain.js';

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const spellDigits = (s) => String(s).split('').map((c) => DIGITS[+c] ?? c).join(' ');

export class Atc {
  constructor(hud) {
    this.hud = hud;
    this.enabled = true;
    this.voice = null;
    this.reset();
    const pick = () => {
      const vs = window.speechSynthesis?.getVoices() ?? [];
      this.voice = vs.find((v) => /en-(GB|US)/.test(v.lang) && /male|daniel|david|george|alex/i.test(v.name))
        ?? vs.find((v) => v.lang?.startsWith('en')) ?? null;
    };
    if (window.speechSynthesis) { pick(); speechSynthesis.onvoiceschanged = pick; }
  }

  reset() {
    this.cleared = new Set();   // which clearances have been given on this flight
    this.timer = 2;
  }

  say(text) {
    this.hud.message(`TOWER: ${text}`, '#8fe3ff', 6);
    if (!this.enabled || !window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.12; u.pitch = 0.9; u.volume = 0.9;
    speechSynthesis.speak(u);
  }

  windCall(weather) {
    const w = weather.surfaceWind, kt = Math.round(w.length() * 1.944);
    if (kt < 3) return 'wind calm';
    // surfaceWind is where the air goes; report where it comes from, to the nearest 10 degrees.
    let from = Math.round(((Math.atan2(-w.x, w.z) * 180 / Math.PI + 360) % 360) / 10) * 10;
    if (from === 0) from = 360;
    return `wind ${spellDigits(String(from).padStart(3, '0'))} at ${kt} knots`;
  }

  // Call once a frame (not in replays). jet: true for the F-16.
  update(dt, ac, weather, jet) {
    if (ac.crashed) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    const call = jet ? 'Viper one one' : 'Skylark two four';
    for (const f of AIRFIELDS) {
      const { along, across } = fieldLocal(f, ac.pos.x, ac.pos.z);
      // Which end: landing towards the runway heading uses numbers[0], the other way numbers[1].
      const rel = ((ac.heading ?? 0) - f.heading + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      const fwd = Math.abs(rel) < Math.PI / 2;
      const num = fwd ? f.numbers[0] : f.numbers[1];
      const aligned = Math.abs(fwd ? rel : (rel > 0 ? rel - Math.PI : rel + Math.PI)) < 0.3;
      const rwy = `runway ${spellDigits(num)}`;
      const key = (k) => `${k}:${f.id}:${num}`;
      // Lined up on the runway, stopped or slow: cleared for takeoff.
      if (ac.onGround && aligned && Math.abs(across) < f.width / 2 && Math.abs(along) < f.length / 2 && ac.speed < 15
          && !this.cleared.has(key('to'))) {
        this.cleared.add(key('to'));
        this.say(`${call}, ${f.name} tower, ${this.windCall(weather)}, ${rwy}, cleared for takeoff.`);
        return;
      }
      // On final: in front of the threshold, within 10 km, close to the centreline, below 3,000 ft above the field.
      const toGo = fwd ? -along - f.length / 2 : along - f.length / 2;
      const agl = ac.pos.y - f.elevation;
      if (!ac.onGround && aligned && toGo > 800 && toGo < 10000 && Math.abs(across) < Math.max(250, toGo * 0.1)
          && agl < 900 && !this.cleared.has(key('land'))) {
        this.cleared.add(key('land'));
        this.cleared.delete(key('vacate'));
        this.say(`${call}, ${f.name} tower, ${this.windCall(weather)}, ${rwy}, cleared to land.`);
        return;
      }
      // Rolled out after landing.
      if (ac.onGround && this.cleared.has(key('land')) && !this.cleared.has(key('vacate')) && ac.speed < 25
          && Math.abs(along) < f.length / 2 + 50) {
        this.cleared.add(key('vacate'));
        this.cleared.delete(key('land'));
        this.cleared.add(key('to')); // no takeoff call straight after landing
        this.say(`${call}, welcome to ${f.name}. Vacate the runway when able.`);
        return;
      }
      // Climbing away: allow a fresh landing clearance on the next approach.
      if (!ac.onGround && agl > 1200) { this.cleared.delete(key('land')); this.cleared.delete(key('to')); }
    }
  }
}
