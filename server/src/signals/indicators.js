// Technical indicators computed from candles ({ time, open, high, low, close, volume }).
// The first five mirror client/src/lib/indicators.js so the chart and the signals agree.
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

/** Average true range with Wilder's smoothing; returns the latest value or null. */
export function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const tr = (i) => {
    const c = candles[i];
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  };
  let value = 0;
  for (let i = 1; i <= period; i++) value += tr(i);
  value /= period;
  for (let i = period + 1; i < candles.length; i++) value = (value * (period - 1) + tr(i)) / period;
  return value;
}

/** Average directional index (Wilder): how strongly price is trending, 0-100, direction-free. Null without enough bars. */
export function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  let tr = 0;
  let pdm = 0;
  let ndm = 0;
  const dxs = [];
  const dx = () => {
    const pdi = tr ? (100 * pdm) / tr : 0;
    const ndi = tr ? (100 * ndm) / tr : 0;
    return pdi + ndi > 1 ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0; // under 1% of the range moved directionally: no trend
  };
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    const t = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const eps = 1e-9 * c.close; // equal highs or lows differ only by float noise
    const pd = up > down && up > eps ? up : 0;
    const nd = down > up && down > eps ? down : 0;
    if (i <= period) {
      tr += t;
      pdm += pd;
      ndm += nd;
      if (i === period) dxs.push(dx());
    } else {
      tr = tr - tr / period + t;
      pdm = pdm - pdm / period + pd;
      ndm = ndm - ndm / period + nd;
      dxs.push(dx());
    }
  }
  if (dxs.length < period) return null;
  let value = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) value = (value * (period - 1) + dxs[i]) / period;
  return value;
}

const istDay = (t) => Math.floor((t + 19800) / 86400);

/** Today's session VWAP (IST day of the last candle), or null without volume. */
export function sessionVwap(candles) {
  if (!candles.length) return null;
  const day = istDay(candles.at(-1).time);
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    if (istDay(c.time) !== day) continue;
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : null;
}

/**
 * Swing highs and lows: a bar whose high (low) is the highest (lowest) of `span` bars on each side.
 * The still-forming last `span` bars cannot confirm a swing.
 */
export function swings(candles, span = 2) {
  const highs = [];
  const lows = [];
  for (let i = span; i < candles.length - span; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  return { highs, lows };
}

/**
 * Supertrend (ATR-based). Returns the direction of the latest bar, +1 up or -1 down, and the
 * trailing line, or null without enough bars. Default 10 bars and a multiplier of 3.
 */
export function supertrend(candles, period = 10, mult = 3) {
  if (candles.length < period + 2) return null;
  const tr = (i) => Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close));
  let atrV = 0;
  for (let i = 1; i <= period; i++) atrV += tr(i);
  atrV /= period;
  let upper = Infinity;
  let lower = -Infinity;
  let dir = 1;
  let line = null;
  for (let i = period; i < candles.length; i++) {
    if (i > period) atrV = (atrV * (period - 1) + tr(i)) / period;
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + mult * atrV;
    const basicLower = mid - mult * atrV;
    const prevClose = candles[i - 1].close;
    upper = basicUpper < upper || prevClose > upper ? basicUpper : upper;
    lower = basicLower > lower || prevClose < lower ? basicLower : lower;
    if (dir === 1 && candles[i].close < lower) dir = -1;
    else if (dir === -1 && candles[i].close > upper) dir = 1;
    line = dir === 1 ? lower : upper;
  }
  return { dir, line };
}

/** On-balance volume change over the last `bars` bars: positive when volume has flowed into rising bars. */
export function obvChange(candles, bars = 12) {
  if (candles.length < bars + 2) return null;
  let obv = 0;
  const series = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume;
    series.push(obv);
  }
  return series.at(-1) - series.at(-1 - bars);
}

/**
 * Has a Bollinger squeeze just released? True when the band width was in the quietest fifth of
 * the last 60 bars within the last 10 bars and is now widening. Returns { released, side } where
 * side is +1 / -1 for the close relative to the middle band, or null without enough bars.
 */
export function squeezeRelease(candles, period = 20) {
  const b = bollinger(candles, period, 2);
  const n = b.upper.length;
  if (n < 40) return null;
  const width = b.upper.map((u, i) => (u.value - b.lower[i].value) / (b.middle[i].value || 1));
  const recent = width.slice(-60);
  const sorted = [...recent].sort((a, b2) => a - b2);
  const quiet = sorted[Math.floor(sorted.length * 0.2)];
  const wasSqueezed = width.slice(-10, -1).some((w) => w <= quiet);
  const widening = width.at(-1) > width.at(-2);
  const close = candles.at(-1).close;
  const mid = b.middle.at(-1).value;
  return { released: wasSqueezed && widening, side: close > mid ? 1 : close < mid ? -1 : 0 };
}
