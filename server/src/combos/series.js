// Indicator series for the combination builder. Every function takes arrays and returns an array of the same length, with null
// where the value is not defined yet (the warm-up). Nothing here looks at a later bar than the one it is computed for.

const nul = (n) => new Array(n).fill(null);
const ok = (x) => x != null && Number.isFinite(x);

export const closesOf = (bars) => bars.map((b) => b.close);
export const highsOf = (bars) => bars.map((b) => b.high);
export const lowsOf = (bars) => bars.map((b) => b.low);

export function sma(v, n) {
  const out = nul(v.length);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < v.length; i++) {
    if (ok(v[i])) {
      sum += v[i];
      count += 1;
    } else {
      sum = 0;
      count = 0;
    }
    if (count > n) {
      sum -= v[i - n];
      count -= 1;
    }
    if (count === n) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first `n` defined values (leading nulls are skipped). */
export function ema(v, n) {
  const out = nul(v.length);
  const k = 2 / (n + 1);
  let prev = null;
  let run = 0;
  let seed = 0;
  for (let i = 0; i < v.length; i++) {
    if (!ok(v[i])) continue;
    if (prev == null) {
      run += 1;
      seed += v[i];
      if (run === n) {
        prev = seed / n;
        out[i] = prev;
      }
    } else {
      prev = v[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

export function wma(v, n) {
  const out = nul(v.length);
  const w = (n * (n + 1)) / 2;
  for (let i = n - 1; i < v.length; i++) {
    let s = 0;
    let good = true;
    for (let k = 0; k < n; k++) {
      const x = v[i - n + 1 + k];
      if (!ok(x)) {
        good = false;
        break;
      }
      s += x * (k + 1);
    }
    if (good) out[i] = s / w;
  }
  return out;
}

/** Hull moving average: fast and smooth, with little lag. */
export function hma(v, n) {
  const half = wma(v, Math.max(2, Math.round(n / 2)));
  const full = wma(v, n);
  const diff = v.map((_, i) => (ok(half[i]) && ok(full[i]) ? 2 * half[i] - full[i] : null));
  return wma(diff, Math.max(2, Math.round(Math.sqrt(n))));
}

export function stdev(v, n) {
  const m = sma(v, n);
  return v.map((_, i) => {
    if (!ok(m[i])) return null;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += (v[k] - m[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

/** Highest of the last n values including this one. */
export function highest(v, n) {
  return v.map((_, i) => {
    if (i < n - 1) return null;
    let m = -Infinity;
    for (let k = i - n + 1; k <= i; k++) m = Math.max(m, v[k]);
    return m;
  });
}

export function lowest(v, n) {
  return v.map((_, i) => {
    if (i < n - 1) return null;
    let m = Infinity;
    for (let k = i - n + 1; k <= i; k++) m = Math.min(m, v[k]);
    return m;
  });
}

export function trueRange(bars) {
  return bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
}

/** Wilder's smoothing, seeded with the plain average of the first n values. */
export function wilder(v, n) {
  const out = nul(v.length);
  let prev = null;
  let run = 0;
  let seed = 0;
  for (let i = 0; i < v.length; i++) {
    if (!ok(v[i])) continue;
    if (prev == null) {
      run += 1;
      seed += v[i];
      if (run === n) {
        prev = seed / n;
        out[i] = prev;
      }
    } else {
      prev = (prev * (n - 1) + v[i]) / n;
      out[i] = prev;
    }
  }
  return out;
}

export const atr = (bars, n = 14) => wilder(trueRange(bars).map((x, i) => (i === 0 ? null : x)), n);

export function rsi(v, n = 14) {
  const gain = v.map((x, i) => (i === 0 ? null : Math.max(0, x - v[i - 1])));
  const loss = v.map((x, i) => (i === 0 ? null : Math.max(0, v[i - 1] - x)));
  const ag = wilder(gain, n);
  const al = wilder(loss, n);
  return v.map((_, i) => (ok(ag[i]) && ok(al[i]) ? (al[i] === 0 ? (ag[i] === 0 ? 50 : 100) : 100 - 100 / (1 + ag[i] / al[i])) : null));
}

export function macd(v, fast = 12, slow = 26, signal = 9) {
  const f = ema(v, fast);
  const s = ema(v, slow);
  const line = v.map((_, i) => (ok(f[i]) && ok(s[i]) ? f[i] - s[i] : null));
  const sig = ema(line, signal);
  return { line, signal: sig, hist: line.map((x, i) => (ok(x) && ok(sig[i]) ? x - sig[i] : null)) };
}

export function stochastic(bars, k = 14, smooth = 3, dPeriod = 3) {
  const hh = highest(highsOf(bars), k);
  const ll = lowest(lowsOf(bars), k);
  const raw = bars.map((b, i) => (ok(hh[i]) ? (hh[i] > ll[i] ? (100 * (b.close - ll[i])) / (hh[i] - ll[i]) : 50) : null));
  const kLine = sma(raw, smooth);
  return { k: kLine, d: sma(kLine, dPeriod) };
}

export function cci(bars, n = 20) {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const m = sma(tp, n);
  return tp.map((x, i) => {
    if (!ok(m[i])) return null;
    let dev = 0;
    for (let k = i - n + 1; k <= i; k++) dev += Math.abs(tp[k] - m[i]);
    dev /= n;
    return dev > 0 ? (x - m[i]) / (0.015 * dev) : 0;
  });
}

export function mfi(bars, vol, n = 14) {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const pos = tp.map((x, i) => (i === 0 ? null : x > tp[i - 1] ? Math.abs(x) * vol[i] : 0));
  const neg = tp.map((x, i) => (i === 0 ? null : x < tp[i - 1] ? Math.abs(x) * vol[i] : 0));
  const ps = sma(pos, n);
  const ns = sma(neg, n);
  return tp.map((_, i) => (ok(ps[i]) && ok(ns[i]) ? (ns[i] === 0 ? (ps[i] === 0 ? 50 : 100) : 100 - 100 / (1 + ps[i] / ns[i])) : null));
}

export function williamsR(bars, n = 14) {
  const hh = highest(highsOf(bars), n);
  const ll = lowest(lowsOf(bars), n);
  return bars.map((b, i) => (ok(hh[i]) ? (hh[i] > ll[i] ? (-100 * (hh[i] - b.close)) / (hh[i] - ll[i]) : -50) : null));
}

export function bollinger(v, n = 20, mult = 2) {
  const mid = sma(v, n);
  const sd = stdev(v, n);
  return { mid, upper: v.map((_, i) => (ok(mid[i]) ? mid[i] + mult * sd[i] : null)), lower: v.map((_, i) => (ok(mid[i]) ? mid[i] - mult * sd[i] : null)) };
}

export function keltner(bars, n = 20, mult = 1.5) {
  const mid = ema(closesOf(bars), n);
  const a = atr(bars, n);
  return { mid, upper: mid.map((m, i) => (ok(m) && ok(a[i]) ? m + mult * a[i] : null)), lower: mid.map((m, i) => (ok(m) && ok(a[i]) ? m - mult * a[i] : null)) };
}

export function aroon(bars, n = 25) {
  const up = nul(bars.length);
  const down = nul(bars.length);
  for (let i = n; i < bars.length; i++) {
    let hi = i - n;
    let lo = i - n;
    for (let k = i - n; k <= i; k++) {
      if (bars[k].high >= bars[hi].high) hi = k;
      if (bars[k].low <= bars[lo].low) lo = k;
    }
    up[i] = (100 * (n - (i - hi))) / n;
    down[i] = (100 * (n - (i - lo))) / n;
  }
  return { up, down };
}

/** Parabolic SAR: the dot that trails price; `dir` is +1 while price is above it. */
export function psar(bars, step = 0.02, max = 0.2) {
  const n = bars.length;
  const value = nul(n);
  const dir = nul(n);
  if (n < 3) return { value, dir };
  let up = bars[1].close >= bars[0].close;
  let sar = up ? bars[0].low : bars[0].high;
  let ep = up ? bars[1].high : bars[1].low;
  let af = step;
  value[1] = sar;
  dir[1] = up ? 1 : -1;
  for (let i = 2; i < n; i++) {
    sar += af * (ep - sar);
    if (up) {
      sar = Math.min(sar, bars[i - 1].low, bars[i - 2].low);
      if (bars[i].low < sar) {
        up = false;
        sar = ep;
        ep = bars[i].low;
        af = step;
      } else if (bars[i].high > ep) {
        ep = bars[i].high;
        af = Math.min(max, af + step);
      }
    } else {
      sar = Math.max(sar, bars[i - 1].high, bars[i - 2].high);
      if (bars[i].high > sar) {
        up = true;
        sar = ep;
        ep = bars[i].high;
        af = step;
      } else if (bars[i].low < ep) {
        ep = bars[i].low;
        af = Math.min(max, af + step);
      }
    }
    value[i] = sar;
    dir[i] = up ? 1 : -1;
  }
  return { value, dir };
}

/** Supertrend as arrays: `dir` +1/-1 and the trailing `line`. */
export function supertrend(bars, period = 10, mult = 3) {
  const n = bars.length;
  const dir = nul(n);
  const line = nul(n);
  const a = atr(bars, period);
  let upper = Infinity;
  let lower = -Infinity;
  let d = 1;
  for (let i = 0; i < n; i++) {
    if (!ok(a[i])) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    const bu = mid + mult * a[i];
    const bl = mid - mult * a[i];
    const pc = i > 0 ? bars[i - 1].close : bars[i].close;
    upper = bu < upper || pc > upper ? bu : upper;
    lower = bl > lower || pc < lower ? bl : lower;
    if (d === 1 && bars[i].close < lower) d = -1;
    else if (d === -1 && bars[i].close > upper) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { dir, line };
}

/** Directional movement: +DI, -DI and ADX (Wilder). */
export function dmi(bars, n = 14) {
  const len = bars.length;
  const pdm = nul(len);
  const ndm = nul(len);
  for (let i = 1; i < len; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    pdm[i] = up > down && up > 0 ? up : 0;
    ndm[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(bars).map((x, i) => (i === 0 ? null : x));
  const str = wilder(tr, n);
  const sp = wilder(pdm, n);
  const sn = wilder(ndm, n);
  const pdi = str.map((t, i) => (ok(t) && ok(sp[i]) ? (t ? (100 * sp[i]) / t : 0) : null));
  const ndi = str.map((t, i) => (ok(t) && ok(sn[i]) ? (t ? (100 * sn[i]) / t : 0) : null));
  const dx = pdi.map((p, i) => (ok(p) && ok(ndi[i]) ? (p + ndi[i] > 1 ? (100 * Math.abs(p - ndi[i])) / (p + ndi[i]) : 0) : null));
  return { pdi, ndi, adx: wilder(dx, n) };
}

export function vortex(bars, n = 14) {
  const len = bars.length;
  const vp = nul(len);
  const vm = nul(len);
  const tr = nul(len);
  for (let i = 1; i < len; i++) {
    vp[i] = Math.abs(bars[i].high - bars[i - 1].low);
    vm[i] = Math.abs(bars[i].low - bars[i - 1].high);
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  }
  const sp = sma(vp, n);
  const sm = sma(vm, n);
  const st = sma(tr, n);
  return { pos: st.map((t, i) => (ok(t) && t > 0 && ok(sp[i]) ? sp[i] / t : null)), neg: st.map((t, i) => (ok(t) && t > 0 && ok(sm[i]) ? sm[i] / t : null)) };
}

/** Ichimoku with the cloud shifted forward, so the cloud at bar i was drawn from bars before i - shift + 1 (no peeking). */
export function ichimoku(bars, conv = 9, base = 26, spanB = 52, shift = 26) {
  const mid = (n) => {
    const hh = highest(highsOf(bars), n);
    const ll = lowest(lowsOf(bars), n);
    return hh.map((h, i) => (ok(h) ? (h + ll[i]) / 2 : null));
  };
  const tenkan = mid(conv);
  const kijun = mid(base);
  const b52 = mid(spanB);
  const a = tenkan.map((t, i) => (ok(t) && ok(kijun[i]) ? (t + kijun[i]) / 2 : null));
  const at = (arr, i) => (i - shift >= 0 ? arr[i - shift] : null);
  return { tenkan, kijun, spanA: bars.map((_, i) => at(a, i)), spanB: bars.map((_, i) => at(b52, i)) };
}

export function obv(bars, vol) {
  let acc = 0;
  return bars.map((b, i) => {
    if (i > 0) acc += b.close > bars[i - 1].close ? vol[i] : b.close < bars[i - 1].close ? -vol[i] : 0;
    return acc;
  });
}

/** Chaikin money flow: how much of the volume closed near the high (positive) or near the low (negative). */
export function cmf(bars, vol, n = 20) {
  const mfv = bars.map((b, i) => (b.high > b.low ? (((b.close - b.low) - (b.high - b.close)) / (b.high - b.low)) * vol[i] : 0));
  const num = sma(mfv, n);
  const den = sma(vol, n);
  return num.map((x, i) => (ok(x) && ok(den[i]) && den[i] > 0 ? x / den[i] : null));
}

export function force(bars, vol, n = 13) {
  return ema(bars.map((b, i) => (i === 0 ? null : (b.close - bars[i - 1].close) * vol[i])), n);
}

export function trix(v, n = 15) {
  const e3 = ema(ema(ema(v, n), n), n);
  return e3.map((x, i) => (ok(x) && i > 0 && ok(e3[i - 1]) && e3[i - 1] !== 0 ? (100 * (x - e3[i - 1])) / Math.abs(e3[i - 1]) : null));
}

export function awesome(bars) {
  const hl = bars.map((b) => (b.high + b.low) / 2);
  const s5 = sma(hl, 5);
  const s34 = sma(hl, 34);
  return hl.map((_, i) => (ok(s5[i]) && ok(s34[i]) ? s5[i] - s34[i] : null));
}

export function ultimate(bars) {
  const bp = bars.map((b, i) => (i === 0 ? null : b.close - Math.min(b.low, bars[i - 1].close)));
  const tr = bars.map((b, i) => (i === 0 ? null : Math.max(b.high, bars[i - 1].close) - Math.min(b.low, bars[i - 1].close)));
  const ratio = (n) => {
    const a = sma(bp, n);
    const t = sma(tr, n);
    return a.map((x, i) => (ok(x) && ok(t[i]) && t[i] > 0 ? x / t[i] : null));
  };
  const r7 = ratio(7);
  const r14 = ratio(14);
  const r28 = ratio(28);
  return r28.map((x, i) => (ok(x) && ok(r14[i]) && ok(r7[i]) ? (100 * (4 * r7[i] + 2 * r14[i] + x)) / 7 : null));
}

/** Least-squares line through the last n values: its slope per bar and how well it fits (r squared, 0 to 1). */
export function linreg(v, n = 20) {
  const slope = nul(v.length);
  const r2 = nul(v.length);
  const sx = (n * (n - 1)) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  for (let i = n - 1; i < v.length; i++) {
    let sy = 0;
    let sxy = 0;
    let syy = 0;
    let good = true;
    for (let k = 0; k < n; k++) {
      const y = v[i - n + 1 + k];
      if (!ok(y)) {
        good = false;
        break;
      }
      sy += y;
      sxy += k * y;
      syy += y * y;
    }
    if (!good) continue;
    const denom = n * sxx - sx * sx;
    const num = n * sxy - sx * sy;
    slope[i] = num / denom;
    const varY = n * syy - sy * sy;
    r2[i] = varY > 0 ? (num * num) / (denom * varY) : 0;
  }
  return { slope, r2 };
}

/** Day-reset volume-weighted average price of the typical price. `weight` is volume (stocks) or traded value (the index). */
export function vwap(bars, weight, dayOf) {
  let w = 0;
  let pv = 0;
  return bars.map((b, i) => {
    if (i === 0 || dayOf[i] !== dayOf[i - 1]) {
      w = 0;
      pv = 0;
    }
    if (ok(weight[i]) && weight[i] > 0) {
      w += weight[i];
      pv += ((b.high + b.low + b.close) / 3) * weight[i];
    }
    return w > 0 ? pv / w : null;
  });
}
