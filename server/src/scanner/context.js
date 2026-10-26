import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { ema, rsi, atr, adx, macd, sessionVwap } from '../signals/indicators.js';
import { buildLevels } from './levels.js';

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

const trend = (fast, slow) => (fast == null || slow == null || Math.abs(fast - slow) / slow < 0.0005 ? 0 : Math.sign(fast - slow));

/**
 * Everything the setups need to know about one stock right now.
 * `c1` is 1-minute candles, oldest first; the last bar is still forming.
 */
export function buildContext({ symbol, tick, c1, niftyChangePct = null, sectorChangePct = null, news = null }) {
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
  if (prior1.length) {
    const pDay = istDay(prior1.at(-1).time);
    const prev = prior1.filter((b) => istDay(b.time) === pDay);
    pdh = Math.max(...prev.map((b) => b.high));
    pdl = Math.min(...prev.map((b) => b.low));
  }

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
    levels: buildLevels({ c5, tick, vwap, pdh, pdl }),
    trend5: trend(e9, e21),
    trend15: trend(h9, h21),
    rsi: last(rsi(c5, 14)),
    macdHist: macdHistogram(c5),
    adx: adx(c5, 14),
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
