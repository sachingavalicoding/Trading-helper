const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * What the last month of daily candles says about a stock: where it trades in its monthly range,
 * which way it has been trending, and how far it normally moves in a day. `daily` is oldest
 * first and may include today's partial candle, which is left out so only finished sessions count.
 * Returns null with fewer than 20 finished sessions (nothing is guessed).
 */
export function summarizeDaily(daily, ltp, today) {
  const done = (daily || []).filter((c) => Math.floor((c.time + 19800) / 86400) < today);
  if (done.length < 20) return null;
  const month = done.slice(-22);
  const closes = month.map((c) => c.close);
  const sma20 = mean(closes.slice(-20));
  const sma10 = mean(closes.slice(-10));
  const last = closes.at(-1);
  const high = Math.max(...month.map((c) => c.high));
  const low = Math.min(...month.map((c) => c.low));
  const trend = last > sma20 && sma10 > sma20 ? 1 : last < sma20 && sma10 < sma20 ? -1 : 0;
  return {
    sessions: month.length,
    high,
    low,
    rangePos: high > low ? (ltp - low) / (high - low) : null, // 0 = at the month's low, 1 = at its high
    trend,
    avgRangePct: mean(month.map((c) => ((c.high - c.low) / c.close) * 100)),
    prevHigh: done.at(-1).high,
    prevLow: done.at(-1).low,
  };
}
