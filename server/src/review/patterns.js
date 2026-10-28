import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { TECHNIQUES, prepare, findSignals } from '../study/patterns.js';
import { fitStop } from '../study/optionsStudy.js';
import { simulateTrade, EXIT_MIN } from '../study/simulate.js';
import { round2 } from '../utils/money.js';

// One day of the Nifty chart, with every pattern that formed on it and what a one-lot option buy at that moment would have done.
// It is a look back at history: nothing here places an order. Premiums are estimated (Black-Scholes), the index moves are real.

export const TARGET_PER_LOT = 1000; // the "book it at" exit shown beside the profit-lock exit
const WATCH_MIN = 60; // how long after the entry the index path is followed

const dayOf = (t) => istParts(new Date(t * 1000)).dateKey;

/** The patterns that can be drawn on the Nifty chart alone (breadth needs the 50 stocks, so it is left out). */
export const CHART_PATTERNS = TECHNIQUES.filter((t) => t.key !== 'breadth');

const outcome = (t) =>
  t && !t.skipped
    ? { lots: t.lots, reason: t.reason, exitTime: t.exitTime, exitSpot: t.exitSpot, minutes: t.minutes, gross: t.gross, charges: t.charges, net: t.net }
    : null;

/** How the index moved after the entry, in points in the trade's favour: the best, the worst, and where it stood an hour later. */
function pathAfter(c1, startIdx, long) {
  const entry = c1[startIdx].open;
  const day = dayOf(c1[startIdx].time);
  let best = { pts: 0, minutes: 0 };
  let worst = { pts: 0, minutes: 0 };
  let last = 0;
  for (let j = startIdx; j < c1.length; j++) {
    const bar = c1[j];
    const minutes = Math.round((bar.time - c1[startIdx].time) / 60);
    const at = istParts(new Date(bar.time * 1000));
    if (at.dateKey !== day || at.minutes >= EXIT_MIN || minutes > WATCH_MIN) break;
    const fav = long ? bar.high - entry : entry - bar.low;
    const adv = long ? bar.low - entry : entry - bar.high;
    if (fav > best.pts) best = { pts: fav, minutes };
    if (adv < worst.pts) worst = { pts: adv, minutes };
    last = long ? bar.close - entry : entry - bar.close;
  }
  return { best: { pts: round2(best.pts), minutes: best.minutes }, worst: { pts: round2(worst.pts), minutes: worst.minutes }, after: round2(last) };
}

/**
 * @param c1      Nifty 1-minute bars, several sessions, oldest first (the earlier sessions give the indicators their context)
 * @param day     'YYYY-MM-DD' (IST)
 * @param params  as `simulateTrade`: { iv, lockStart, lockGap, lotSize, holidays, expiryWeekday, lossLimit, maxLots }
 */
export function reviewPatterns({ c1, day, params }) {
  let bars5 = aggregateCandles(c1, '5m');
  if (bars5.length && bars5.at(-1).time + 300 > c1.at(-1).time + 60) bars5 = bars5.slice(0, -1); // the last bucket is still forming
  const candles = bars5.filter((b) => dayOf(b.time) === day);
  if (!candles.length) return { day, candles: [], signals: [], patterns: CHART_PATTERNS.map(({ key, label, text }) => ({ key, label, text })) };

  const byTime = new Map(c1.map((b, i) => [b.time, i]));
  const found = findSignals(prepare(bars5)).filter((s) => dayOf(s.time - 300) === day && s.technique !== 'doubleBottomMid');
  const signals = [];
  for (const s of found.sort((a, b) => a.time - b.time || a.technique.localeCompare(b.technique))) {
    const startIdx = byTime.get(s.time);
    if (startIdx == null) continue; // the bar after it has not been traded yet
    const long = s.side === 'CE';
    const entry = c1[startIdx].open;
    const { stop, wide } = fitStop(s, entry);
    const base = {
      id: `${s.technique}-${s.side}-${s.time}`,
      technique: s.technique,
      side: s.side,
      note: s.note,
      time: s.time,
      entry: round2(entry),
      stop: round2(stop),
      stopPts: round2(Math.abs(entry - stop)),
      ...pathAfter(c1, startIdx, long),
    };
    if (wide) {
      signals.push({ ...base, skipped: 'far' });
      continue;
    }
    const signal = { ...s, stop };
    const lock = simulateTrade({ c1, byTime, signal, params: { ...params, target: 0 } });
    if (lock?.skipped) {
      signals.push({ ...base, skipped: 'limit' });
      continue;
    }
    if (!lock) {
      signals.push({ ...base, skipped: 'price' });
      continue;
    }
    const target = simulateTrade({ c1, byTime, signal, params: { ...params, target: TARGET_PER_LOT } });
    signals.push({ ...base, strike: lock.strike, expiry: lock.expiry, premium: lock.entryPremium, lock: outcome(lock), target: outcome(target) });
  }
  return {
    day,
    candles,
    open: candles[0].open,
    patterns: CHART_PATTERNS.map(({ key, label, text }) => ({ key, label, text })),
    signals,
    exits: { lockStart: params.lockStart, lockGap: params.lockGap, lossLimit: params.lossLimit, target: TARGET_PER_LOT },
  };
}
