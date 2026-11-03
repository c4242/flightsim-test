// International Standard Atmosphere (troposphere and lower stratosphere) and airspeed conversions.

const R = 287.053;      // J/(kg K)
const GAMMA = 1.4;
const P0 = 101325, T0 = 288.15, RHO0 = 1.225, A0 = 340.294;

export function atmosphere(h, out = {}) {
  const hh = Math.max(-500, h);
  let T, p;
  if (hh < 11000) {
    T = T0 - 0.0065 * hh;
    p = P0 * Math.pow(T / T0, 5.25588);
  } else {
    T = 216.65;
    p = 22632.1 * Math.exp(-(hh - 11000) / 6341.62);
  }
  out.T = T;
  out.p = p;
  out.rho = p / (R * T);
  out.a = Math.sqrt(GAMMA * R * T);
  out.sigma = out.rho / RHO0;
  out.delta = p / P0;
  return out;
}

// Calibrated airspeed (what the airspeed indicator shows), from true airspeed.
// Uses the isentropic pitot relation below Mach 1 and the Rayleigh pitot formula above it.
export function calibratedAirspeed(tas, atm) {
  const M = tas / atm.a;
  let qc;
  if (M < 1) qc = atm.p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  else qc = atm.p * ((166.9216 * Math.pow(M, 7)) / Math.pow(7 * M * M - 1, 2.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

export { RHO0 };
