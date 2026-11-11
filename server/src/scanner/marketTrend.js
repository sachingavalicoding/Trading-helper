import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { ema, sessionVwap } from '../signals/indicators.js';
import { istDay } from './context.js';

// Nifty 50's own direction for the share scanner: up when the price is above the day's average price and EMA 9 is above EMA 21 on
// 5-minute bars, down for the reverse, 0 (sideways) otherwise. An index has no traded volume, so its VWAP is usually empty: then the
// day's plain average price (every minute counted the same) stands in. Before 11 Nov 2026 a missing VWAP made this always 0.

/** The day's average price of the last session in `c1`: the VWAP when there is volume, else the plain average of typical prices. */
export function dayAverage(c1) {
  const v = sessionVwap(c1);
  if (v != null) return v;
  if (!c1.length) return null;
  const day = istDay(c1.at(-1).time);
  let sum = 0;
  let n = 0;
  for (let i = c1.length - 1; i >= 0 && istDay(c1[i].time) === day; i--) {
    sum += (c1[i].high + c1[i].low + c1[i].close) / 3;
    n++;
  }
  return n ? sum / n : null;
}

/** -1, 0 or 1 from Nifty's 1-minute candles (the last one may be forming); null with too little history. */
export function niftyTrendOf(c1, ltp = c1.at(-1)?.close) {
  if (!c1 || c1.length < 40 || ltp == null) return null;
  const c5 = aggregateCandles(c1, '5m');
  if (c5.length < 22) return null;
  const avg = dayAverage(c1);
  const e9 = ema(c5, 9).at(-1)?.value;
  const e21 = ema(c5, 21).at(-1)?.value;
  if (avg == null || e9 == null || e21 == null) return null;
  return ltp > avg && e9 > e21 ? 1 : ltp < avg && e9 < e21 ? -1 : 0;
}

/**
 * The same reading for every minute of past Nifty candles, worked out in one pass, for the study.
 * Returns a function: unix time (seconds) of a stock's 1-minute bar -> { niftyTrend, breadthUp: null } or null.
 */
export function niftyTrendTimeline(nifty1) {
  const at = new Map();
  if (!nifty1?.length) return () => null;
  const k9 = 2 / 10;
  const k21 = 2 / 22;
  const seed = []; // the first closed 5-minute bars' closes, to seed the EMAs
  let closed = 0;
  let e9 = null;
  let e21 = null;
  let slot = null;
  let formingClose = null;
  let day = null;
  let sum = 0;
  let n = 0;
  let pv = 0;
  let vol = 0;
  const closeSlot = (close) => {
    closed += 1;
    if (closed <= 21) seed.push(close);
    if (closed === 9) e9 = seed.reduce((a, b) => a + b, 0) / 9;
    else if (closed > 9) e9 = close * k9 + e9 * (1 - k9);
    if (closed === 21) e21 = seed.reduce((a, b) => a + b, 0) / 21;
    else if (closed > 21) e21 = close * k21 + e21 * (1 - k21);
  };
  let count = 0; // 5-minute bars seen, closed ones plus the forming one
  for (let i = 0; i < nifty1.length; i++) {
    const b = nifty1[i];
    const s = Math.floor(b.time / 300);
    if (s !== slot) {
      if (slot != null) closeSlot(formingClose);
      slot = s;
      count += 1;
    }
    formingClose = b.close;
    const d = istDay(b.time);
    if (d !== day) {
      day = d;
      sum = n = pv = vol = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    sum += tp;
    n += 1;
    pv += tp * (b.volume || 0);
    vol += b.volume || 0;
    if (i + 1 < 40 || count < 22 || e21 == null) continue;
    // the EMAs as the live reading sees them: the closed bars, then one step for the forming bar
    const f9 = formingClose * k9 + e9 * (1 - k9);
    const f21 = formingClose * k21 + e21 * (1 - k21);
    const avg = vol > 0 ? pv / vol : sum / n;
    const ltp = b.close;
    at.set(b.time, ltp > avg && f9 > f21 ? 1 : ltp < avg && f9 < f21 ? -1 : 0);
  }
  return (t) => {
    // a stock bar at time t: the Nifty bar of the same minute, or the latest one before it
    let v = at.get(t);
    for (let back = 60; v === undefined && back <= 300; back += 60) v = at.get(t - back);
    return v === undefined ? null : { niftyTrend: v, breadthUp: null };
  };
}
