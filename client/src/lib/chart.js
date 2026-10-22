// Helpers for TradingView Lightweight Charts. Times are shifted to IST because the
// library renders timestamps as UTC.
export const IST_OFFSET_SEC = 19800;
export const INTERVAL_SEC = { '1m': 60, '5m': 300, '15m': 900 };
export const toChartTime = (sec) => sec + IST_OFFSET_SEC;
const dayOf = (chartTime) => Math.floor(chartTime / 86400);

/** Session VWAP: cumulative typical price x volume / cumulative volume, reset every IST day. */
export function computeVwap(candles) {
  const out = [];
  let day = null;
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    const d = dayOf(c.time);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
    if (vol > 0) out.push({ time: c.time, value: Math.round((pv / vol) * 100) / 100 });
  }
  return out;
}

/**
 * Fold a live tick into the candle array (mutates and returns the updated/added bar).
 * `state.lastVolume` tracks the day's cumulative volume so we can add only the new shares.
 */
export function applyTick(candles, tick, intervalSec, state) {
  const t = toChartTime(Math.floor(tick.ts / 1000));
  const bucket = t - (t % intervalSec);
  const dv = state.lastVolume != null && tick.volume != null ? Math.max(0, tick.volume - state.lastVolume) : 0;
  if (tick.volume != null) state.lastVolume = tick.volume;
  const last = candles[candles.length - 1];
  if (last && bucket < last.time) return null; // late tick
  if (last && last.time === bucket) {
    last.high = Math.max(last.high, tick.ltp);
    last.low = Math.min(last.low, tick.ltp);
    last.close = tick.ltp;
    last.volume += dv;
    return last;
  }
  const bar = { time: bucket, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, volume: dv };
  candles.push(bar);
  return bar;
}
