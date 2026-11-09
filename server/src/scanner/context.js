import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { ema, rsi, atr, adx, macd, sessionVwap, supertrend, obvChange, squeezeRelease } from '../signals/indicators.js';
import { pivotsFrom, candleConfirms } from './pivots.js';
import { buildLevels } from './levels.js';
import { summarizeDaily } from './daily.js';
import { keltner, ultimate, dmi, aroon, mfi } from '../combos/series.js';

const IST = 19800;
export const istDay = (t) => Math.floor((t + IST) / 86400);
const slotOf = (t) => Math.floor(((t + IST) % 86400) / 300);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const last = (points) => points.at(-1)?.value ?? null;

/** Volume of the last `n` completed 5-minute bars against what is normal for that time of day. */
function relativeVolume(c5, n = 3) {
  const done = c5.slice(0, -1); // the last bar is still forming
  if (done.length < n + 6) return null;
  const recent = done.slice(-n);
  const day = istDay(done.at(-1).time);
  const slots = new Set(recent.map((b) => slotOf(b.time)));
  const sameSlotBefore = done.filter((b) => istDay(b.time) < day && slots.has(slotOf(b.time)));
  let base;
  if (sameSlotBefore.length >= n) base = mean(sameSlotBefore.map((b) => b.volume));
  else {
    // No earlier sessions loaded: compare with the rest of today instead.
    const earlier = done.filter((b) => istDay(b.time) === day).slice(0, -n);
    if (earlier.length < 6) return null;
    base = mean(earlier.map((b) => b.volume));
  }
  return base > 0 ? mean(recent.map((b) => b.volume)) / base : null;
}

/** Latest MACD histogram and the one before it, so we can tell if momentum is building or fading. */
function macdHistogram(c5) {
  const m = macd(c5);
  const h = m?.histogram ?? m?.hist;
  if (!h || h.length < 2) return null;
  return { now: h.at(-1).value ?? h.at(-1), prev: h.at(-2).value ?? h.at(-2) };
}

const KEEP_BARS = 160; // the extra indicators read only the last 160 closed 5-minute bars (about two sessions), enough for their 14 to 28-bar windows

/**
 * The extra indicators for the share score (added 9 Nov 2026 when the score leaned on the opening range alone), read on closed 5-minute bars.
 * Each is a direction (+1 for a buy, -1 for a sell, 0 neither) or a value the score turns into one. null when there are not enough bars.
 */
export function extraReads(done5) {
  const bars = done5.slice(-KEEP_BARS);
  if (bars.length < 30) return { keltner: null, ultimate: null, donchian: null, dmi: null, aroon: null, mfi: null };
  const lastOf = (arr) => arr.at(-1) ?? null;
  const close = bars.at(-1).close;
  const k = keltner(bars, 20, 1.5);
  const up = lastOf(k.upper);
  const lo = lastOf(k.lower);
  const prior = bars.slice(-21, -1);
  const hi20 = Math.max(...prior.map((b) => b.high));
  const lo20 = Math.min(...prior.map((b) => b.low));
  const dm = dmi(bars, 14);
  const adxNow = lastOf(dm.adx);
  const adxBefore = dm.adx.at(-4) ?? null;
  const ar = aroon(bars, 25);
  const m = mfi(bars, bars.map((b) => b.volume ?? 0), 14);
  return {
    keltner: up == null || lo == null ? null : close > up ? 1 : close < lo ? -1 : 0,
    ultimate: lastOf(ultimate(bars)),
    donchian: close > hi20 ? 1 : close < lo20 ? -1 : 0,
    dmi: adxNow == null || adxBefore == null || lastOf(dm.pdi) == null ? null : { dir: Math.sign(lastOf(dm.pdi) - lastOf(dm.ndi)), rising: adxNow > adxBefore, adx: adxNow },
    aroon: lastOf(ar.up) == null ? null : { up: lastOf(ar.up), down: lastOf(ar.down) },
    mfi: bars.some((b) => b.volume > 0) ? lastOf(m) : null,
  };
}

const trend = (fast, slow) => (fast == null || slow == null || Math.abs(fast - slow) / slow < 0.0005 ? 0 : Math.sign(fast - slow));

/**
 * Everything the setups need to know about one stock right now.
 * `c1` is 1-minute candles, oldest first; the last bar is still forming.
 */
export function buildContext({ symbol, tick, c1, niftyChangePct = null, sectorChangePct = null, daily = null, marketState = null, news = null }) {
  if (!tick || !c1 || c1.length < 40) return null;
  const c5 = aggregateCandles(c1, '5m');
  const c15 = aggregateCandles(c1, '15m');
  if (c5.length < 22) return null;

  const ltp = tick.ltp;
  const day = istDay(c1.at(-1).time);
  const today1 = c1.filter((b) => istDay(b.time) === day);
  const prior1 = c1.filter((b) => istDay(b.time) < day);
  const today5 = c5.filter((b) => istDay(b.time) === day);

  let pdh = null;
  let pdl = null;
  let pdc = null;
  if (prior1.length) {
    const pDay = istDay(prior1.at(-1).time);
    const prev = prior1.filter((b) => istDay(b.time) === pDay);
    pdh = Math.max(...prev.map((b) => b.high));
    pdl = Math.min(...prev.map((b) => b.low));
    pdc = prev.at(-1).close;
  }

  const month = summarizeDaily(daily, ltp, day);
  const pivots = pdh != null ? pivotsFrom({ high: pdh, low: pdl, close: pdc }) : null;
  const done5 = c5.slice(0, -1); // the last 5-minute bar is still forming
  const vwap = sessionVwap(c1);
  const atr5 = atr(c5, 14) || ltp * 0.003;
  const first15 = today1.slice(0, 15);
  const or = today1.length >= 16 ? { high: Math.max(...first15.map((b) => b.high)), low: Math.min(...first15.map((b) => b.low)) } : null;

  const e9 = last(ema(c5, 9));
  const e21 = last(ema(c5, 21));
  const e50 = c5.length >= 50 ? last(ema(c5, 50)) : null;
  // 9 above 21 above 50 is a clean uptrend, the reverse a clean downtrend, anything else is mixed.
  const emaStack = e50 == null ? null : e9 > e21 && e21 > e50 ? 1 : e9 < e21 && e21 < e50 ? -1 : 0;
  const h9 = last(ema(c15, 9));
  const h21 = last(ema(c15, 21));
  const buy = tick.totalBuyQty;
  const sell = tick.totalSellQty;

  return {
    symbol,
    tick,
    ltp,
    changePct: tick.changePct,
    c1,
    c5,
    c15,
    today5,
    vwap,
    atr5,
    or,
    pdh,
    pdl,
    levels: buildLevels({ c5, tick, vwap, pdh, pdl, month, pivots }),
    month,
    trend5: trend(e9, e21),
    trend15: trend(h9, h21),
    rsi: last(rsi(c5, 14)),
    macdHist: macdHistogram(c5),
    adx: adx(c5, 14),
    supertrend: supertrend(done5),
    obv: obvChange(done5),
    squeeze: squeezeRelease(done5),
    pivots,
    lastBar: done5.at(-1) ?? null,
    extra: extraReads(done5),
    candleOk: (d) => candleConfirms(done5.at(-1), d),
    marketState,
    emaStack,
    sectorChangePct,
    sectorStrength: sectorChangePct == null || tick.changePct == null ? null : sectorChangePct - (niftyChangePct ?? 0),
    vwapStretch: vwap ? (ltp - vwap) / atr5 : null,
    relVol: relativeVolume(c5),
    relStrength: niftyChangePct == null || tick.changePct == null ? null : tick.changePct - niftyChangePct,
    niftyChangePct,
    bookShare: buy && sell ? buy / (buy + sell) : null,
    gapPct: tick.prevClose ? ((tick.open - tick.prevClose) / tick.prevClose) * 100 : 0,
    prevClose: tick.prevClose,
    news,
  };
}
