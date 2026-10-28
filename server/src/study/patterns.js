import { supertrend, emaValues, atr } from '../signals/indicators.js';
import { istParts } from '../market/marketHours.js';

// Each way of reading the Nifty chart that the study tests, written as "does this 5-minute bar, which has just closed, complete the
// pattern for a call?". A put is the same pattern on the mirrored chart (prices negated), so every detector is written once, for a call.
// A detector sees only bars up to and including `i`, never later ones.

export const BUFFER_ATR = 0.15; // the stop sits this far beyond the level that proves the idea wrong
export const MIN_STOP_ATR = 0.8; // a closer stop is hit by ordinary noise (same floor as the live options trader)
export const MAX_STOP_ATR = 2.5; // a pattern whose stop is further than this is skipped: its loss would not fit the loss limit

export const TECHNIQUES = [
  { key: 'doubleBottom', label: 'Double bottom / top', text: 'Price makes the same low twice, with a bounce of at least 1.5 ATR between them, then closes above the bounce high. Stop under the two lows.' },
  { key: 'doubleBottomMid', label: 'Double bottom / top, tighter stop', text: 'The same double bottom, but the stop sits half way between the lows and the neckline, so it fits the loss limit. It gives up the room under the lows.' },
  { key: 'reversal', label: 'Sharp fall, then turn', text: 'A fall of 4 ATR or more, then price turns off the low: a higher low and a bar that closes above the previous bar high, within 2 ATR of the low. Stop under the low.' },
  { key: 'breakout', label: 'Breakout of the last hour', text: 'A 5-minute bar closes above the highest high of the last hour (12 bars). Stop under the lowest low of the last 6 bars.' },
  { key: 'orb', label: 'Opening range breakout', text: 'The first close beyond the 09:15-09:30 range after 09:30. Stop at the other end of that range.' },
  { key: 'pullback', label: 'Pullback in a trend', text: 'The 9, 21 and 50 EMAs are lined up, price dips to the 21 EMA and then closes above the previous bar high. Stop under the dip.' },
  { key: 'engulfing', label: 'Engulfing candle at a low / high', text: 'After a few falling bars near the 20-bar low, a bullish candle whose body covers the previous bearish one. Stop under both.' },
  { key: 'pinBar', label: 'Hammer / shooting star', text: 'A candle near the 20-bar low with a long lower wick (twice its body, over half the range) that closes in its top third. Stop under the wick.' },
  { key: 'insideBar', label: 'Inside bar breakout', text: 'A big bar (1.2 ATR or more), a small bar inside it, then a close beyond the big bar. Stop at the big bar other end.' },
  { key: 'supertrend', label: 'Supertrend flip', text: 'The supertrend (10, 3) turns from down to up. Stop at the supertrend line.' },
  { key: 'emaCross', label: 'EMA 9 / 21 cross', text: 'The 9 EMA crosses above the 21 EMA with price above both. Stop under the last 6 bars.' },
  { key: 'breadth', label: 'Nifty 50 breadth', text: 'At least 70% of the 50 stocks are above (call) or below (put) yesterday close and the index is on the same side of its day average. Stop under the last 6 bars.' },
];

const mirror = (b) => ({ ...b, open: -b.open, high: -b.low, low: -b.high, close: -b.close });

/** The chart seen as a call (d = 1) or mirrored as a put (d = -1), with its indicators, ready for the detectors. */
export function prepare(bars, breadth = null) {
  const out = {};
  for (const d of [1, -1]) {
    const view = d > 0 ? bars : bars.map(mirror);
    const closes = view.map((b) => b.close);
    out[d] = {
      d,
      bars: view,
      e9: emaValues(closes, 9),
      e21: emaValues(closes, 21),
      e50: emaValues(closes, 50),
      breadth: breadth ? breadth.map((v) => (v == null ? null : d > 0 ? v : 1 - v)) : null,
    };
  }
  const dayOf = bars.map((b) => Math.floor((b.time + 19800) / 86400));
  const dayStart = [];
  let start = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0 && dayOf[i] !== dayOf[i - 1]) start = i;
    dayStart.push(start);
  }
  const atrAt = bars.map((_, i) => (i >= 15 ? atr(bars.slice(Math.max(0, i - 40), i + 1), 14) : null));
  return { bars, views: out, dayStart, atrAt };
}

const tradeable = (time) => {
  const { minutes } = istParts(new Date((time + 300) * 1000)); // the bar has closed: the trade is made at its end
  return minutes >= 9 * 60 + 45 && minutes < 14 * 60;
};

const lowest = (bars, from, to) => Math.min(...bars.slice(from, to + 1).map((b) => b.low));
const highest = (bars, from, to) => Math.max(...bars.slice(from, to + 1).map((b) => b.high));

function doubleBottom(v, i, ds, a, tight = false) {
  const b = v.bars;
  if (i - ds < 14) return null;
  const sw = [];
  for (let k = ds + 2; k <= i - 3; k++) {
    if ([-2, -1, 1, 2].every((o) => b[k + o].low >= b[k].low) && !(sw.length && k - sw.at(-1) <= 2)) sw.push(k); // equal lows next to each other count once
  }
  if (sw.length < 2) return null;
  const k2 = sw.at(-1);
  const k1 = sw.at(-2);
  if (k2 - k1 < 6 || i - k2 > 20) return null;
  if (Math.abs(b[k1].low - b[k2].low) > 0.6 * a) return null;
  const neck = highest(b, k1, k2);
  const floor = Math.min(b[k1].low, b[k2].low);
  if (neck - floor < 1.5 * a) return null;
  if (!(b[i].close > neck && b[i - 1].close <= neck && b[i].close < neck + a)) return null;
  return { stop: tight ? (floor + neck) / 2 : floor - BUFFER_ATR * a, note: 'neckline of a double bottom or top broken' };
}

function reversal(v, i, ds, a) {
  const b = v.bars;
  const from = Math.max(ds, i - 23);
  const bars = b.slice(from, i + 1);
  if (bars.length < 12) return null;
  const at = bars.reduce((best, x, k) => (x.low < bars[best].low ? k : best), 0);
  if (at === 0 || at > bars.length - 3) return null;
  const extreme = bars[at].low;
  const move = Math.max(...bars.slice(0, at).map((x) => x.high)) - extreme;
  const bounce = b[i].close - extreme;
  if (move < 4 * a || bounce < 1.2 * a || bounce > 2 * a || bounce > 0.6 * move) return null;
  if (!(b[i].close > b[i - 1].high && b[i].low > extreme)) return null;
  return { stop: extreme - BUFFER_ATR * a, note: 'turned off the extreme of a sharp move' };
}

function breakout(v, i, ds, a) {
  const b = v.bars;
  if (i - ds < 12) return null;
  const level = highest(b, i - 12, i - 1);
  if (!(b[i].close > level && b[i - 1].close <= level && b[i].close < level + a)) return null;
  return { stop: lowest(b, i - 5, i) - BUFFER_ATR * a, note: 'closed beyond the last hour range' };
}

function orb(v, i, ds, a) {
  const b = v.bars;
  if (i - ds < 3) return null;
  const hi = highest(b, ds, ds + 2);
  const lo = lowest(b, ds, ds + 2);
  if (!(b[i].close > hi)) return null;
  for (let k = ds + 3; k < i; k++) if (b[k].close > hi) return null; // only the first break of the day
  return { stop: lo - BUFFER_ATR * a, note: 'closed beyond the opening range' };
}

function pullback(v, i, ds, a) {
  const b = v.bars;
  const { e9, e21, e50 } = v;
  if (e50[i] == null || i - ds < 6) return null;
  if (!(e9[i] > e21[i] && e21[i] > e50[i] && b[i].close > e9[i])) return null;
  if (!(lowest(b, i - 3, i) <= e21[i] + 0.25 * a && b[i].close > b[i - 1].high)) return null;
  return { stop: lowest(b, i - 3, i) - BUFFER_ATR * a, note: 'pulled back to the 21 EMA and resumed' };
}

function engulfing(v, i, ds, a) {
  const b = v.bars;
  if (i - ds < 8) return null;
  const cur = b[i];
  const prev = b[i - 1];
  if (!(prev.close < prev.open && cur.close > cur.open && cur.close > prev.open && cur.open <= prev.close && cur.close - cur.open >= 0.5 * a)) return null;
  if (!(prev.close < b[i - 4].close)) return null;
  if (!(prev.low <= lowest(b, Math.max(ds, i - 20), i - 1) + 0.5 * a)) return null;
  return { stop: Math.min(cur.low, prev.low) - BUFFER_ATR * a, note: 'engulfing candle at a low or high' };
}

function pinBar(v, i, ds, a) {
  const b = v.bars;
  if (i - ds < 8) return null;
  const c = b[i];
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const wick = Math.min(c.open, c.close) - c.low;
  if (range < 0.8 * a || wick < 2 * body || wick < 0.55 * range || c.close < c.low + (2 / 3) * range) return null;
  if (!(c.low <= lowest(b, Math.max(ds, i - 20), i - 1) + 0.5 * a)) return null;
  return { stop: c.low - BUFFER_ATR * a, note: 'long-wick candle at a low or high' };
}

function insideBar(v, i, ds, a) {
  const b = v.bars;
  if (i - ds < 4) return null;
  const mother = b[i - 2];
  const inside = b[i - 1];
  if (!(mother.high - mother.low >= 1.2 * a && inside.high < mother.high && inside.low > mother.low && b[i].close > mother.high)) return null;
  return { stop: mother.low - BUFFER_ATR * a, note: 'broke out of an inside bar' };
}

function supertrendFlip(v, i, ds, a) {
  const b = v.bars;
  if (i - ds < 8) return null;
  const now = supertrend(b.slice(Math.max(0, i - 80), i + 1));
  const before = supertrend(b.slice(Math.max(0, i - 81), i));
  if (!now || !before || !(now.dir === 1 && before.dir === -1)) return null;
  return { stop: now.line, note: 'supertrend flipped' };
}

function emaCross(v, i, ds, a) {
  const b = v.bars;
  const { e9, e21 } = v;
  if (e21[i - 1] == null || i - ds < 6) return null;
  if (!(e9[i - 1] <= e21[i - 1] && e9[i] > e21[i] && b[i].close > e9[i])) return null;
  return { stop: lowest(b, i - 5, i) - BUFFER_ATR * a, note: '9 EMA crossed the 21 EMA' };
}

function breadthLed(v, i, ds, a) {
  const b = v.bars;
  const br = v.breadth;
  if (!br || br[i] == null || i - ds < 6) return null;
  const day = b.slice(ds, i + 1);
  const mean = day.reduce((s, x) => s + x.close, 0) / day.length;
  const ok = (k) => br[k] != null && br[k] >= 0.7;
  if (!(ok(i) && !ok(i - 1) && b[i].close > mean)) return null;
  return { stop: lowest(b, i - 5, i) - BUFFER_ATR * a, note: `${Math.round(br[i] * 100)}% of the 50 stocks on one side` };
}

const DETECTORS = { doubleBottom, doubleBottomMid: (v, i, ds, a) => doubleBottom(v, i, ds, a, true), reversal, breakout, orb, pullback, engulfing, pinBar, insideBar, supertrend: supertrendFlip, emaCross, breadth: breadthLed };

/**
 * Every signal the techniques give over the prepared bars: { technique, side, i, time, close, stop, note, atr }.
 * `time` is when the bar closed. Only bars that close between 09:45 and 14:00 count, like the live trader (`windows: false` lifts that).
 * `from` is the first bar index to look at, so the live trader can look at the newest bar only.
 */
export function findSignals(prep, { only = null, from = 15, windows = true } = {}) {
  const out = [];
  for (let i = Math.max(15, from); i < prep.bars.length; i++) {
    const a = prep.atrAt[i];
    if (!a || (windows && !tradeable(prep.bars[i].time))) continue;
    const ds = prep.dayStart[i];
    for (const d of [1, -1]) {
      const v = prep.views[d];
      for (const [key, detect] of Object.entries(DETECTORS)) {
        if (only && !only.includes(key)) continue;
        if (key === 'breadth' && !v.breadth) continue;
        const hit = detect(v, i, ds, a);
        if (!hit) continue;
        out.push({
          technique: key,
          side: d > 0 ? 'CE' : 'PE',
          i,
          time: prep.bars[i].time + 300,
          close: prep.bars[i].close,
          stop: d > 0 ? hit.stop : -hit.stop,
          note: hit.note,
          atr: a,
        });
      }
    }
  }
  return out;
}
