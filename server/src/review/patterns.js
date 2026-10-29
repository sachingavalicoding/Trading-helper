import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { TECHNIQUES, available, prepare, findSignals, turnoverSeries, ruleStop } from '../study/patterns.js';
import { fitStop, breadthSeries } from '../study/optionsStudy.js';
import { buildChart } from '../combos/conditions.js';
import { comboSignals, describeCombo, heldConditions, missingData } from '../combos/combos.js';
import { simulateTrade, EXIT_MIN } from '../study/simulate.js';
import { round2 } from '../utils/money.js';

// One day of the Nifty chart, with every pattern that formed on it and what a one-lot option buy at that moment would have done.
// It is a look back at history: nothing here places an order. Premiums are estimated (Black-Scholes), the index moves are real.

export const TARGET_PER_LOT = 1000; // the "book it at" exit shown beside the profit-lock exit
const WATCH_MIN = 60; // how long after the entry the index path is followed
const MIN_MOVE_PTS = 30; // a run smaller than this is not worth tracing

const dayOf = (t) => istParts(new Date(t * 1000)).dateKey;

/** The patterns that can be drawn on the Nifty chart alone (breadth needs the 50 stocks, so it is left out). The volume and VWAP ones join when `flow` is known. */
export const chartPatterns = (flow = false) => TECHNIQUES.filter((t) => available(t, { breadth: false, flow }));
export const CHART_PATTERNS = chartPatterns(false);
export const FLOW_NOTE = 'Volume and VWAP patterns need the 50 stocks saved. Download them in Account > Studies > Data and they appear here.';

const outcome = (t) =>
  t && !t.skipped
    ? { lots: t.lots, reason: t.reason, exitTime: t.exitTime, exitSpot: t.exitSpot, minutes: t.minutes, gross: t.gross, charges: t.charges, net: t.net }
    : null;

/** How the index moved after the entry, in points in the trade's favour: the best, the worst, and where it stood an hour later. */
function pathAfter(c1, startIdx, long, exitMin) {
  const entry = c1[startIdx].open;
  const day = dayOf(c1[startIdx].time);
  let best = { pts: 0, minutes: 0 };
  let worst = { pts: 0, minutes: 0 };
  let last = 0;
  for (let j = startIdx; j < c1.length; j++) {
    const bar = c1[j];
    const minutes = Math.round((bar.time - c1[startIdx].time) / 60);
    const at = istParts(new Date(bar.time * 1000));
    if (at.dateKey !== day || at.minutes >= exitMin || minutes > WATCH_MIN) break;
    const fav = long ? bar.high - entry : entry - bar.low;
    const adv = long ? bar.low - entry : entry - bar.high;
    if (fav > best.pts) best = { pts: fav, minutes };
    if (adv < worst.pts) worst = { pts: adv, minutes };
    last = long ? bar.close - entry : entry - bar.close;
  }
  return { best: { pts: round2(best.pts), minutes: best.minutes }, worst: { pts: round2(worst.pts), minutes: worst.minutes }, after: round2(last) };
}

const WHAT_IF = [
  { key: 'chart', label: 'Chart level' },
  { key: 'atr10', label: '1 ATR', rule: { mode: 'atr', k: 1 } },
  { key: 'atr15', label: '1.5 ATR', rule: { mode: 'atr', k: 1.5 } },
  { key: 'atr20', label: '2 ATR', rule: { mode: 'atr', k: 2 } },
  ...[20, 30, 40].map((points) => ({ key: `fix${points}`, label: `${points} pts`, rule: { mode: 'fixed', points } })),
];

/**
 * What each way of placing the stop would have done to this entry, on the index alone: how far it is, and whether the index went that far
 * against the entry within the hour (and when). It shows how much room a trade needed to survive, which is what the stop setting trades off.
 */
export function stopWhatIf(c1, startIdx, signal, entry, exitMin) {
  const long = signal.side === 'CE';
  const day = dayOf(c1[startIdx].time);
  return WHAT_IF.map(({ key, label, rule }) => {
    const stop = ruleStop(signal, entry, rule ?? { mode: 'chart' });
    const pts = Math.max(round2(Math.abs(entry - stop)), 0);
    let hitAfter = null;
    for (let j = startIdx; j < c1.length; j++) {
      const bar = c1[j];
      const minutes = Math.round((bar.time - c1[startIdx].time) / 60);
      const at = istParts(new Date(bar.time * 1000));
      if (at.dateKey !== day || at.minutes >= exitMin || minutes > WATCH_MIN) break;
      if ((long ? entry - bar.low : bar.high - entry) >= pts) {
        hitAfter = minutes;
        break;
      }
    }
    return { key, label, pts, hitAfter };
  });
}

/**
 * The biggest run up and the biggest run down of the session in hindsight (a low followed by a later high, and the reverse), and which signals
 * formed near the start of it, so a missed move can be traced to the signal that was skipped, or to no signal at all.
 */
export function biggestMoves(c1, day, signals, exitMin) {
  const bars = c1.filter((b) => dayOf(b.time) === day && istParts(new Date(b.time * 1000)).minutes < exitMin);
  const out = [];
  for (const up of [true, false]) {
    let anchor = null;
    let best = null;
    for (const b of bars) {
      if (up) {
        if (!anchor || b.low < anchor.price) anchor = { price: b.low, time: b.time };
        const pts = b.high - anchor.price;
        if (!best || pts > best.pts) best = { pts, from: anchor.time, to: b.time };
      } else {
        if (!anchor || b.high > anchor.price) anchor = { price: b.high, time: b.time };
        const pts = anchor.price - b.low;
        if (!best || pts > best.pts) best = { pts, from: anchor.time, to: b.time };
      }
    }
    if (!best || best.pts < MIN_MOVE_PTS) continue;
    const side = up ? 'CE' : 'PE';
    const near = signals
      .filter((s) => s.side === side && s.time >= best.from - 900 && s.time < best.to)
      .map((s) => ({ id: s.id, technique: s.technique, time: s.time, skipped: s.skipped ?? null, net: s.lock?.net ?? null }));
    out.push({ side, pts: round2(best.pts), from: best.from, to: best.to, signals: near });
  }
  return out;
}

const WARM_BARS = 150; // earlier 5-minute bars sent with a day, so the chart's indicators have context from its first candle

/** The 5-minute bars before `day`, newest last, for indicator warm-up. */
export const warmBars = (bars5, day, n = WARM_BARS) => bars5.filter((b) => dayOf(b.time) < day).slice(-n);

/**
 * The shape of a day in a few lines: its open, high, low and close, and the legs it moved in. A leg is a run in one direction that
 * is not undone by a pull-back of `swing` (three average 5-minute ranges, at least `minSwing`); what lies between legs was a range.
 * @param bars5 the day's 5-minute bars, oldest first
 */
export function dayStory(bars5, { minSwing = 0 } = {}) {
  if (bars5.length < 6) return null;
  const tr = bars5.map((b, i) => Math.max(b.high - b.low, i ? Math.abs(b.high - bars5[i - 1].close) : 0, i ? Math.abs(b.low - bars5[i - 1].close) : 0));
  const atr = tr.reduce((a, b) => a + b, 0) / tr.length;
  const swing = Math.max(3 * atr, minSwing);
  let hi = bars5[0];
  let lo = bars5[0];
  for (const b of bars5) {
    if (b.high > hi.high) hi = b;
    if (b.low < lo.low) lo = b;
  }
  // zigzag on highs and lows: a leg ends when price pulls back `swing` from its extreme
  const legs = [];
  let dir = 0;
  let from = { price: bars5[0].open, time: bars5[0].time };
  let ext = { price: bars5[0].open, time: bars5[0].time };
  for (const b of bars5) {
    if (dir === 0) {
      if (b.high - from.price >= swing) {
        dir = 1;
        ext = { price: b.high, time: b.time };
      } else if (from.price - b.low >= swing) {
        dir = -1;
        ext = { price: b.low, time: b.time };
      }
    } else if (dir === 1) {
      if (b.high > ext.price) ext = { price: b.high, time: b.time };
      else if (ext.price - b.low >= swing) {
        legs.push({ dir: 1, from, to: ext });
        from = ext;
        dir = -1;
        ext = { price: b.low, time: b.time };
      }
    } else if (b.low < ext.price) ext = { price: b.low, time: b.time };
    else if (b.high - ext.price >= swing) {
      legs.push({ dir: -1, from, to: ext });
      from = ext;
      dir = 1;
      ext = { price: b.high, time: b.time };
    }
  }
  if (dir !== 0) legs.push({ dir, from, to: ext });
  const last = bars5.at(-1);
  return {
    open: round2(bars5[0].open),
    high: { price: round2(hi.high), time: hi.time },
    low: { price: round2(lo.low), time: lo.time },
    close: round2(last.close),
    changePts: round2(last.close - bars5[0].open),
    rangePts: round2(hi.high - lo.low),
    atr5: round2(atr),
    swing: round2(swing),
    legs: legs
      .filter((l) => Math.abs(l.to.price - l.from.price) >= swing)
      .map((l) => ({ dir: l.dir > 0 ? 'up' : 'down', from: l.from.time, to: l.to.time + 300, fromPrice: round2(l.from.price), toPrice: round2(l.to.price), pts: round2(Math.abs(l.to.price - l.from.price)) })),
  };
}

/**
 * @param c1      Nifty 1-minute bars, several sessions, oldest first (the earlier sessions give the indicators their context)
 * @param day     'YYYY-MM-DD' (IST)
 * @param params  as `simulateTrade`: { iv, lockStart, lockGap, lotSize, holidays, expiryWeekday, lossLimit, maxLots, exitMin }
 * @param stocks5 { SYMBOL: 5-minute candles } of the 50 stocks when saved, which unlocks the volume and VWAP patterns
 * @param combos  the user's own combinations (normalized), traded like patterns
 * @param stopRule the user's stop rule (see ruleStop), applied to every signal; the chart level when null
 */
export function reviewPatterns({ c1, day, params, stocks5 = null, combos = [], stopRule = null }) {
  const exitMin = params.exitMin ?? EXIT_MIN;
  let bars5 = aggregateCandles(c1, '5m');
  if (bars5.length && bars5.at(-1).time + 300 > c1.at(-1).time + 60) bars5 = bars5.slice(0, -1); // the last bucket is still forming
  const candles = bars5.filter((b) => dayOf(b.time) === day);
  const flow = turnoverSeries(bars5, stocks5);
  const patterns = chartPatterns(Boolean(flow)).map(({ key, label, text }) => ({ key, label, text }));
  if (!candles.length) return { day, candles: [], signals: [], patterns };
  const minutes = c1.filter((b) => dayOf(b.time) === day).map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));

  const byTime = new Map(c1.map((b, i) => [b.time, i]));
  const breadth = breadthSeries(bars5, stocks5);
  const found = findSignals(prepare(bars5, null, flow)).filter((s) => dayOf(s.time - 300) === day && s.technique !== 'doubleBottomMid');
  // The user's own combinations, drawn and traded like patterns; `why` says which of their checks held.
  const chart = combos.length ? buildChart(bars5, { breadth, flow }) : null;
  const combosSkipped = [];
  const comboInfo = new Map();
  for (const combo of combos.filter((c) => c.on !== false)) {
    const missing = missingData(combo, chart.have);
    if (missing.length) {
      combosSkipped.push({ id: combo.id, name: combo.name, reason: `needs ${[...new Set(missing)].map((m) => (m === 'flow' ? 'volume of the 50 stocks' : m === 'breadth' ? 'the 50-stock breadth' : m)).join(' and ')}, which are not saved` });
      continue;
    }
    const key = `combo:${combo.id}`;
    patterns.push({ key, label: `Mine: ${combo.name}`, text: describeCombo(combo), combo: true });
    comboInfo.set(key, combo);
    for (const s of comboSignals(chart, combo, { label: key }).filter((x) => dayOf(x.time - 300) === day)) {
      found.push({ ...s, why: heldConditions(chart, combo, s.side === 'CE' ? 1 : -1, s.i) });
    }
  }
  const signals = [];
  for (const s of found.sort((a, b) => a.time - b.time || a.technique.localeCompare(b.technique))) {
    const startIdx = byTime.get(s.time);
    if (startIdx == null) continue; // the bar after it has not been traded yet
    const long = s.side === 'CE';
    const entry = c1[startIdx].open;
    const { stop, wide } = fitStop(s, entry, stopRule);
    const base = {
      id: `${s.technique}-${s.side}-${s.time}`,
      technique: s.technique,
      side: s.side,
      note: s.note,
      time: s.time,
      entry: round2(entry),
      stop: round2(stop),
      stopPts: round2(Math.abs(entry - stop)),
      ...(s.why ? { why: s.why } : {}),
      ...pathAfter(c1, startIdx, long, exitMin),
      whatIf: stopWhatIf(c1, startIdx, s, entry, exitMin),
    };
    if (wide) {
      signals.push({ ...base, skipped: 'far' });
      continue;
    }
    if (istParts(new Date(s.time * 1000)).minutes >= exitMin) {
      signals.push({ ...base, skipped: 'late' });
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
    warm: warmBars(bars5, day),
    minutes,
    story: dayStory(candles, { minSwing: 25 }),
    open: candles[0].open,
    patterns,
    note: flow ? null : FLOW_NOTE,
    signals,
    moves: biggestMoves(c1, day, signals, exitMin),
    combosSkipped,
    stopRule: stopRule ?? { mode: 'chart' },
    exits: { lockStart: params.lockStart, lockGap: params.lockGap, steps: params.steps ?? [{ at: params.lockStart, keep: params.lockStart - params.lockGap }], lossLimit: params.lossLimit, target: TARGET_PER_LOT, exitMin },
  };
}
