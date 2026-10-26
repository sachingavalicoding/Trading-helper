/**
 * Central pivot range and classic pivots from yesterday's high, low and close.
 * A narrow range (under 0.3% of the pivot) often goes with a trending day, a wide one with a range day.
 */
export function pivotsFrom({ high, low, close }) {
  if (![high, low, close].every(Number.isFinite)) return null;
  const p = (high + low + close) / 3;
  const bc = (high + low) / 2;
  const tc = 2 * p - bc;
  return {
    pivot: p,
    tc: Math.max(tc, bc),
    bc: Math.min(tc, bc),
    r1: 2 * p - low,
    s1: 2 * p - high,
    widthPct: (Math.abs(tc - bc) / p) * 100,
  };
}

/**
 * The last completed bar's quality as a confirmation for `d` (+1 buy, -1 sell): it closed in the
 * trade's direction, with a body of at least half its range and a close in the outer 30% of the bar,
 * or it is a rejection bar (long wick against the direction, close back with the direction).
 */
export function candleConfirms(bar, d) {
  if (!bar) return null;
  const range = bar.high - bar.low;
  if (!(range > 0)) return false;
  const body = d * (bar.close - bar.open);
  const closePos = d > 0 ? (bar.close - bar.low) / range : (bar.high - bar.close) / range; // 1 = closed at the favourable extreme
  const strong = body >= 0.5 * range && closePos >= 0.7;
  const wick = d > 0 ? Math.min(bar.open, bar.close) - bar.low : bar.high - Math.max(bar.open, bar.close);
  const rejection = body > 0 && wick >= 2 * Math.abs(bar.close - bar.open) && closePos >= 0.6;
  return strong || rejection;
}
