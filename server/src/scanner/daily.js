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

const sessionDay = (c) => Math.floor((c.time + 19800) / 86400);

/**
 * Yesterday-based setups read from finished daily candles (oldest first, today's partial candle ignored):
 *  - nr4 / nr7: yesterday's high-to-low range was the narrowest of the last 4 / 7 sessions, so the stock is coiled
 *    and a breakout of yesterday's high or low is more likely to run (Crabel's narrow range days)
 *  - insideBar: yesterday traded entirely inside the day before it
 * Every field is false when there is too little data (it needs 8 finished sessions); nothing is guessed.
 */
export function dailyPatterns(daily, today) {
  const done = (daily || []).filter((c) => sessionDay(c) < today);
  const out = { sessions: done.length, nr4: false, nr7: false, insideBar: false };
  if (done.length < 8) return out;
  const range = (c) => c.high - c.low;
  const last = done.at(-1);
  const narrowest = (n) => range(last) > 0 && done.slice(-n, -1).every((c) => range(last) < range(c)); // strictly narrower than each of the other n-1
  out.nr4 = narrowest(4);
  out.nr7 = narrowest(7);
  const prev = done.at(-2);
  out.insideBar = last.high <= prev.high && last.low >= prev.low && (last.high < prev.high || last.low > prev.low);
  return out;
}
