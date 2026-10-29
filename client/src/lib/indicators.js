// Technical indicators computed from candles ({ time, open, high, low, close, volume }).
// Each returns points ({ time, value }) aligned to candle times, skipping the warm-up period.

const r2 = (n) => Math.round(n * 100) / 100;

export function sma(candles, period, src = (c) => c.close) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += src(candles[i]);
    if (i >= period) sum -= src(candles[i - period]);
    if (i >= period - 1) out.push({ time: candles[i].time, value: r2(sum / period) });
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values. */
export function emaValues(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(candles, period) {
  const vals = emaValues(candles.map((c) => c.close), period);
  return candles.flatMap((c, i) => (vals[i] == null ? [] : [{ time: c.time, value: r2(vals[i]) }]));
}

/** Bollinger Bands: SMA ± mult × population standard deviation. */
export function bollinger(candles, period = 20, mult = 2) {
  const upper = [];
  const middle = [];
  const lower = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (candles[j].close - mean) ** 2;
    const sd = Math.sqrt(sq / period);
    const time = candles[i].time;
    upper.push({ time, value: r2(mean + mult * sd) });
    middle.push({ time, value: r2(mean) });
    lower.push({ time, value: r2(mean - mult * sd) });
  }
  return { upper, middle, lower };
}

/** RSI with Wilder's smoothing. */
export function rsi(candles, period = 14) {
  const out = [];
  if (candles.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? 100 : r2(100 - 100 / (1 + gain / loss)));
  out.push({ time: candles[period].time, value: value() });
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out.push({ time: candles[i].time, value: value() });
  }
  return out;
}

/** MACD line (fast EMA - slow EMA), signal (EMA of MACD) and histogram. */
export function macd(candles, fast = 12, slow = 26, signalPeriod = 9) {
  const closes = candles.map((c) => c.close);
  const f = emaValues(closes, fast);
  const s = emaValues(closes, slow);
  const macdIdx = [];
  const macdVals = [];
  for (let i = 0; i < candles.length; i++) {
    if (f[i] != null && s[i] != null) {
      macdIdx.push(i);
      macdVals.push(f[i] - s[i]);
    }
  }
  const sig = emaValues(macdVals, signalPeriod);
  const line = [];
  const signal = [];
  const histogram = [];
  macdVals.forEach((m, k) => {
    const time = candles[macdIdx[k]].time;
    line.push({ time, value: r2(m) });
    if (sig[k] != null) {
      signal.push({ time, value: r2(sig[k]) });
      histogram.push({ time, value: r2(m - sig[k]) });
    }
  });
  return { line, signal, histogram };
}

/** Wilder's average true range, aligned to the candles (null while warming up). */
export function atrValues(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function atr(candles, period = 14) {
  const v = atrValues(candles, period);
  return candles.flatMap((c, i) => (v[i] == null ? [] : [{ time: c.time, value: r2(v[i]) }]));
}

/** Keltner channel: EMA of the close ± mult × ATR. */
export function keltner(candles, period = 20, mult = 2) {
  const mid = emaValues(candles.map((c) => c.close), period);
  const a = atrValues(candles, 10);
  const upper = [];
  const middle = [];
  const lower = [];
  candles.forEach((c, i) => {
    if (mid[i] == null || a[i] == null) return;
    upper.push({ time: c.time, value: r2(mid[i] + mult * a[i]) });
    middle.push({ time: c.time, value: r2(mid[i]) });
    lower.push({ time: c.time, value: r2(mid[i] - mult * a[i]) });
  });
  return { upper, middle, lower };
}

/** Supertrend: a line under the price in an up-trend and over it in a down-trend. Points carry `up` so the caller can colour them. */
export function supertrend(candles, period = 10, mult = 3) {
  const a = atrValues(candles, period);
  const out = [];
  let upper = null;
  let lower = null;
  let up = true;
  for (let i = 0; i < candles.length; i++) {
    if (a[i] == null) continue;
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    const basicUpper = mid + mult * a[i];
    const basicLower = mid - mult * a[i];
    const prevClose = candles[i - 1].close;
    upper = upper == null || basicUpper < upper || prevClose > upper ? basicUpper : upper;
    lower = lower == null || basicLower > lower || prevClose < lower ? basicLower : lower;
    if (up && c.close < lower) up = false;
    else if (!up && c.close > upper) up = true;
    out.push({ time: c.time, value: r2(up ? lower : upper), up });
  }
  return out;
}

/** Commodity channel index (typical price against its mean deviation). */
export function cci(candles, period = 20) {
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const out = [];
  for (let i = period - 1; i < candles.length; i++) {
    const win = tp.slice(i - period + 1, i + 1);
    const mean = win.reduce((a, b) => a + b, 0) / period;
    const dev = win.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    out.push({ time: candles[i].time, value: dev === 0 ? 0 : r2((tp[i] - mean) / (0.015 * dev)) });
  }
  return out;
}

/** Candles of a finer interval folded into `factor`-times longer ones (5-minute bars into 15-minute bars), aligned to the clock. */
export function foldCandles(candles, seconds) {
  const out = [];
  for (const c of candles) {
    const t = c.time - (c.time % seconds);
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume = (last.volume || 0) + (c.volume || 0);
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
  }
  return out;
}
