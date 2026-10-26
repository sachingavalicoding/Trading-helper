// Black-Scholes for European index options, used for two things only: making premiums for the simulated feed, and
// turning "the Nifty stop is at 24350" into "the option premium will then be about ₹X". Indian rates are held flat.
import { parseOptionSymbol, yearsToExpiry } from './symbols.js';

export const RATE = 0.065;

// Abramowitz-Stegun normal CDF, accurate to about 1e-7.
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Premium of a call (`type` 'CE') or put ('PE'). `t` in years, `iv` as a fraction (0.14 = 14%). */
export function bsPrice({ type, spot, strike, t, iv, rate = RATE }) {
  const intrinsic = Math.max(type === 'CE' ? spot - strike : strike - spot, 0);
  if (t <= 0 || iv <= 0) return intrinsic;
  const sd = iv * Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * t) / sd;
  const d2 = d1 - sd;
  const disc = Math.exp(-rate * t);
  return type === 'CE' ? spot * cdf(d1) - strike * disc * cdf(d2) : strike * disc * cdf(-d2) - spot * cdf(-d1);
}

/** Change in premium for a ₹1 move in the index (0..1 for a call, -1..0 for a put). */
export function bsDelta({ type, spot, strike, t, iv, rate = RATE }) {
  if (t <= 0 || iv <= 0) return type === 'CE' ? (spot > strike ? 1 : 0) : spot < strike ? -1 : 0;
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
  return type === 'CE' ? cdf(d1) : cdf(d1) - 1;
}

/** The volatility that makes the model match a live premium, by bisection; null when the premium is not explainable (below intrinsic). */
export function impliedVol({ type, spot, strike, t, premium, rate = RATE }) {
  let lo = 0.01;
  let hi = 3;
  if (premium < bsPrice({ type, spot, strike, t, iv: lo, rate }) || premium > bsPrice({ type, spot, strike, t, iv: hi, rate })) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice({ type, spot, strike, t, iv: mid, rate }) < premium) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Fair premium of a contract symbol at a given index level and time. */
export function premiumFor(symbol, spot, { iv = 0.14, now = new Date() } = {}) {
  const o = parseOptionSymbol(symbol);
  if (!o) return null;
  return bsPrice({ type: o.type, spot, strike: o.strike, t: yearsToExpiry(o.expiry, now), iv });
}
