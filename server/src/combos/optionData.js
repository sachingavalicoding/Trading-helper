// @ts-check
import { istParts } from '../market/marketHours.js';
import { atmStrike, chooseExpiry, yearsToExpiry, STRIKE_STEP } from '../options/symbols.js';
import { bsPrice, bsDelta, impliedVol } from '../options/pricing.js';

// What the option chain said at each 5-minute close of the index chart, read from the saved real premiums (study/priceBook.js) or, live,
// from the chain the trader reads during the day (options/liveChain.js). Only the strikes near the money are saved (about the day's range
// plus a few steps either side), so the PCR, the OI change and the max pain here are the near-the-money ones, not the whole chain.
// Nothing here looks at a minute after the bar's close: a bar reads the last minute candle inside it.

/**
 * @typedef {{ time: number, open: number, high: number, low: number, close: number, oi?: number }} Candle
 * @typedef {{ strike: number, type: string, candles: Map<number, Candle> }} ChainRow
 * @typedef {{ expiries: (day: string) => string[], chain: (day: string, expiry: string) => ChainRow[] }} ChainBook
 * @typedef {{ delta: (number|null)[], thetaPct: (number|null)[] }} Greeks
 * @typedef {{
 *   pcr: (number|null)[], callOi: (number|null)[], putOi: (number|null)[], callChg: (number|null)[], putChg: (number|null)[],
 *   maxPain: (number|null)[], atmIv: (number|null)[], ivPct: (number|null)[], greeks: { CE: Greeks, PE: Greeks }, days: number
 * }} OptionSeries
 */

const IV_DAYS = 20; // the IV percentile compares with the at-the-money IV of up to this many earlier days
const IV_MIN_VALUES = 100; // about 1.5 days of 5-minute values: fewer and the percentile is not given
const YEAR_DAY = 1 / 365;

/** @param {number} t */
const dayKeyOf = (t) => istParts(new Date(t * 1000)).dateKey;

/**
 * The last candle of a contract at or before the end of the 5-minute bar starting at `t` (the minute candles at t+240, t+180 ... back to
 * 15 minutes before the bar), or null. A thin strike may skip a minute; live, the chain read every few minutes may not have the newest one yet.
 */
function lastIn(/** @type {Map<number, Candle>} */ candles, /** @type {number} */ t) {
  for (let k = 240; k >= -900; k -= 60) {
    const c = candles.get(t + k);
    if (c) return c;
  }
  return null;
}

/**
 * The strike where option buyers as a whole would lose the most (the sellers' best expiry): the strike K with the smallest
 * sum of call OI x (K - s) above each strike s and put OI x (s - K) below it. Null with no open interest.
 * @param {{ strike: number, call: number, put: number }[]} rows
 */
export function maxPainOf(rows) {
  let best = null;
  let low = Infinity;
  if (!rows.some((r) => r.call > 0 || r.put > 0)) return null;
  for (const { strike: k } of rows) {
    let pain = 0;
    for (const r of rows) pain += r.call * Math.max(0, k - r.strike) + r.put * Math.max(0, r.strike - k);
    if (pain < low) {
      low = pain;
      best = k;
    }
  }
  return best;
}

/** Percent of `past` values below `x` (0 to 100), or null with too few values. */
export function percentileOf(/** @type {number[]} */ past, /** @type {number} */ x, min = IV_MIN_VALUES) {
  if (past.length < min || !Number.isFinite(x)) return null;
  let below = 0;
  for (const v of past) if (v < x) below += 1;
  return Math.round((below / past.length) * 100);
}

/**
 * Delta (0 to 1 for the side bought) and theta (how much of the premium one day of time costs, in %) of an option at `strike`.
 * @param {{ type: 'CE'|'PE', spot: number, strike: number, t: number, iv: number }} o
 */
export function greeksOf({ type, spot, strike, t, iv }) {
  const now = bsPrice({ type, spot, strike, t, iv });
  const later = bsPrice({ type, spot, strike, t: Math.max(t - YEAR_DAY, 1e-6), iv });
  return { delta: Math.abs(bsDelta({ type, spot, strike, t, iv })), thetaPct: now > 0.05 ? Math.max(0, ((now - later) / now) * 100) : null };
}

/**
 * The option-chain series for each 5-minute bar of the index chart. Bars on a day with nothing saved get null everywhere.
 * @param {{ time: number, close: number }[]} bars5
 * @param {ChainBook | null} book
 * @param {{ strikeStep?: number }} [opts]
 * @returns {OptionSeries | null}
 */
export function optionSeries(bars5, book, { strikeStep = STRIKE_STEP } = {}) {
  if (!book || !bars5.length) return null;
  const n = bars5.length;
  /** @returns {(number|null)[]} */
  const blank = () => new Array(n).fill(null);
  /** @type {OptionSeries} */
  const out = { pcr: blank(), callOi: blank(), putOi: blank(), callChg: blank(), putChg: blank(), maxPain: blank(), atmIv: blank(), ivPct: blank(), greeks: { CE: { delta: blank(), thetaPct: blank() }, PE: { delta: blank(), thetaPct: blank() } }, days: 0 };
  /** @type {Map<string, number[]>} */
  const byDay = new Map();
  bars5.forEach((b, i) => {
    const d = dayKeyOf(b.time);
    if (!byDay.has(d)) byDay.set(d, []);
    /** @type {number[]} */ (byDay.get(d)).push(i);
  });
  /** @type {{ day: string, values: number[] }[]} */
  const ivHistory = [];
  for (const [day, idx] of byDay) {
    const expiries = book.expiries(day);
    if (!expiries.length) continue;
    const near = expiries[0]; // the open interest of the nearest expiry, as traders read the PCR and max pain
    const bought = chooseExpiry(expiries, new Date(bars5[idx[0]].time * 1000), { minDays: 1 }); // the contract the trader would buy
    const nearChain = book.chain(day, near);
    const buyChain = bought === near ? nearChain : book.chain(day, bought ?? near);
    if (!nearChain.length) continue;
    out.days += 1;
    /** @type {number|null} */ let openCall = null;
    /** @type {number|null} */ let openPut = null;
    /** @type {number[]} */
    const todayIv = [];
    const past = ivHistory.slice(-IV_DAYS).flatMap((h) => h.values);
    for (const i of idx) {
      const t = bars5[i].time;
      const spot = bars5[i].close;
      /** @type {Map<number, { strike: number, call: number, put: number }>} */
      const rows = new Map();
      let call = 0;
      let put = 0;
      for (const r of nearChain) {
        const c = lastIn(r.candles, t);
        const oi = c?.oi ?? 0;
        if (!(oi > 0)) continue;
        const row = rows.get(r.strike) ?? { strike: r.strike, call: 0, put: 0 };
        if (r.type === 'CE') {
          row.call = oi;
          call += oi;
        } else {
          row.put = oi;
          put += oi;
        }
        rows.set(r.strike, row);
      }
      if (call > 0 && put > 0) {
        if (openCall == null) {
          openCall = call;
          openPut = put;
        }
        out.callOi[i] = call;
        out.putOi[i] = put;
        out.pcr[i] = put / call;
        out.callChg[i] = call - openCall;
        out.putChg[i] = put - /** @type {number} */ (openPut);
        out.maxPain[i] = maxPainOf([...rows.values()].sort((a, b) => a.strike - b.strike));
      }
      // the at-the-money IV of the contract the trader would buy, from its real call and put premiums
      const strike = atmStrike(spot, strikeStep);
      const years = yearsToExpiry(bought ?? near, new Date((t + 300) * 1000));
      const ivs = [];
      for (const type of /** @type {const} */ (['CE', 'PE'])) {
        const row = buyChain.find((r) => r.strike === strike && r.type === type);
        const c = row ? lastIn(row.candles, t) : null;
        const iv = c && c.close > 0 ? impliedVol({ type, spot, strike, t: years, premium: c.close }) : null;
        if (iv != null && iv > 0.02 && iv < 2) ivs.push(iv);
      }
      if (!ivs.length) continue;
      const iv = ivs.reduce((s, x) => s + x, 0) / ivs.length;
      out.atmIv[i] = iv;
      out.ivPct[i] = percentileOf(past, iv);
      todayIv.push(iv);
      for (const type of /** @type {const} */ (['CE', 'PE'])) {
        const g = greeksOf({ type, spot, strike, t: years, iv });
        out.greeks[type].delta[i] = g.delta;
        out.greeks[type].thetaPct[i] = g.thetaPct;
      }
    }
    if (todayIv.length) ivHistory.push({ day, values: todayIv });
  }
  return out.days ? out : null;
}

/**
 * The series as one side sees it, so every check can be written once for a call: for a put the PCR is turned round (1 / PCR),
 * the OI change is read from the other side, max pain is mirrored like the prices, and the greeks are the put's.
 * @param {OptionSeries} s
 * @param {1|-1} d
 */
export function optionView(s, d) {
  const inv = (/** @type {number|null} */ x) => (x != null && x > 0 ? 1 / x : null);
  const edge = (/** @type {number} */ i) => {
    const c = s.callChg[i];
    const p = s.putChg[i];
    return c == null || p == null ? null : d * (p - c);
  };
  return {
    pcr: d > 0 ? s.pcr : s.pcr.map(inv),
    // OI added since the open on the side that supports this trade (puts written for a call) minus the other side; above 0 = writers back it
    oiEdge: s.pcr.map((_, i) => edge(i)),
    // the same over the last 3 bars only: fresh writing
    oiEdge3: s.pcr.map((_, i) => {
      const now = edge(i);
      const before = i >= 3 && s.callChg[i - 3] != null && s.putChg[i - 3] != null ? d * (/** @type {number} */ (s.putChg[i - 3]) - /** @type {number} */ (s.callChg[i - 3])) : null;
      return now == null || before == null ? null : now - before;
    }),
    maxPain: s.maxPain.map((x) => (x == null ? null : d * x)),
    atmIv: s.atmIv,
    ivPct: s.ivPct,
    delta: s.greeks[d > 0 ? 'CE' : 'PE'].delta,
    thetaPct: s.greeks[d > 0 ? 'CE' : 'PE'].thetaPct,
  };
}
