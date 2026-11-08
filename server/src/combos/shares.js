import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { roundToTick } from '../utils/money.js';
import { buildChart } from './conditions.js';
import { comboSignals } from './combos.js';
import { breadthSeries } from '../study/optionsStudy.js';

// The combination builder for the Nifty 50 shares. A share is read like the index: its own 5-minute bars, with its own traded value as the
// volume (so VWAP and volume checks are the share's own) and the 50-stock breadth. "CE" is a buy and "PE" a short sale. The study and the
// live auto trader both turn a combination's signals into ideas through this file, so they trade the same way.

export const SHARE_FIRST_MIN = 9 * 60 + 30; // like the scanner: nothing before the opening range is in
const STOP_MIN_ATR = 1.0; // a stop closer than one 5-minute ATR is hit by ordinary noise
const STOP_MIN_PCT = 0.5; // the auto trader's own floor (MIN_STOP_PCT)
const STOP_MAX_ATR = 3;
const STOP_MAX_PCT = 0.8; // but a calm share is allowed this much
const TARGET_R = [1.5, 2.5, 4];

const bucket = (c) => Math.floor((c.time + 19800) / 86400);

/** 5-minute bars of a share from its 1-minute candles, dropping the one still forming. */
export function bars5Of(c1, now = null) {
  const bars = aggregateCandles(c1, '5m');
  const cut = now ?? c1.at(-1)?.time + 60;
  return bars.length && bars.at(-1).time + 300 > cut ? bars.slice(0, -1) : bars;
}

/** Traded value of each 5-minute bar of a share (price times shares), null where the bar had no volume. */
export const flowOfShare = (bars5) => (bars5.some((b) => b.volume > 0) ? bars5.map((b) => (b.volume > 0 ? b.close * b.volume : null)) : null);

/**
 * The 50-stock breadth as a map from a 5-minute bar time to the share of stocks above yesterday close, worked out once on `timeline`
 * (any list of 5-minute bars) and then read by every share.
 */
export function breadthByTime(timeline, stocks5) {
  const series = breadthSeries(timeline, stocks5);
  if (!series) return null;
  return new Map(timeline.map((b, i) => [b.time, series[i]]));
}

/** A news reading for the newest bar only (the past headlines are not kept): 1 for a headline that favours a buy, -1 for a short sale, else 0. */
export function newsDirection(n) {
  if (!n || n.reaction === 'FADING') return 0;
  return n.label === 'BULLISH' ? 1 : n.label === 'BEARISH' ? -1 : 0;
}

/** The share's chart for the combination builder. `breadth` is a Map from bar time (see breadthByTime); `news` is a function from bar index to 1, -1 or 0. */
export function shareChart(bars5, { breadth = null, news = null, from = 15 } = {}) {
  const series = breadth ? bars5.map((b) => breadth.get(b.time) ?? null) : null;
  return buildChart(bars5, { breadth: series && series.some((x) => x != null) ? series : null, flow: flowOfShare(bars5), news, from });
}

/**
 * The stop an idea is traded with, or null when it is too far to risk: never closer than one ATR or 0.5% of the entry.
 * With `stopPct` (a combination's own order setting) the stop is simply that % from the entry.
 */
export function shareStop(signal, entry, stopPct = 0) {
  const d = signal.side === 'CE' ? 1 : -1;
  if (stopPct > 0) return roundToTick(entry - (d * entry * stopPct) / 100);
  const floor = Math.max(STOP_MIN_ATR * signal.atr, (STOP_MIN_PCT / 100) * entry);
  const cap = Math.max(STOP_MAX_ATR * signal.atr, (STOP_MAX_PCT / 100) * entry);
  let dist = d * (entry - signal.stop);
  if (dist < floor) dist = floor;
  if (dist > cap) return null;
  return roundToTick(entry - d * dist);
}

/**
 * Ideas the combination gives on this share: one per side per day at most (like the scanner's "raised" key), between 09:30 and `exitMin`.
 * Each is { symbol, setup, side: 'BUY'|'SELL', score, entry, stopLoss, target1..3, openedAt, combo: true, time }.
 */
export function shareIdeas(chart, combo, { symbol, from = 15, exitMin: accountExit = 15 * 60 + 15, label = null, days = null }) {
  const exitMin = combo.order?.exitMin > 0 && accountExit < 24 * 60 ? combo.order.exitMin : accountExit; // a combination's own exit time also ends its entries
  const when = (time) => {
    const { minutes } = istParts(new Date((time + 300) * 1000));
    return minutes >= SHARE_FIRST_MIN && minutes < exitMin;
  };
  const signals = comboSignals(chart, combo, { from, windows: false, when });
  const raised = new Set();
  const ideas = [];
  for (const s of signals) {
    if (days && !days.has(bucket(s))) continue;
    const key = `${bucket(s)}|${s.side}`;
    if (raised.has(key)) continue;
    const entry = roundToTick(s.close);
    const stopLoss = shareStop(s, entry, combo.order?.stopPct ?? 0);
    if (stopLoss == null) continue;
    raised.add(key);
    const d = s.side === 'CE' ? 1 : -1;
    const risk = Math.abs(entry - stopLoss);
    ideas.push({
      symbol,
      setup: label || `Combo: ${combo.name}`,
      side: d > 0 ? 'BUY' : 'SELL',
      score: 100,
      entry,
      stopLoss,
      target1: roundToTick(entry + d * TARGET_R[0] * risk),
      target2: roundToTick(entry + d * TARGET_R[1] * risk),
      target3: roundToTick(entry + d * TARGET_R[2] * risk),
      openedAt: new Date(s.time * 1000).toISOString(),
      combo: true,
      comboId: combo.id,
      time: s.time,
      i: s.i,
    });
  }
  return ideas;
}

/**
 * The money rules one combination's trades use: its own order settings and profit ladder where it has them, else `money` (the Account ones).
 * `money` is { riskAmount, slippagePct, steps, target, exitMin, maxAmount }. Its own target wins over any ladder; its own ladder wins over the Account target.
 */
export function comboMoney(combo, money) {
  const o = combo?.order || {};
  const ownSteps = combo?.exits && Array.isArray(combo.exits.steps);
  return {
    ...money,
    riskAmount: o.risk > 0 ? o.risk : money.riskAmount,
    maxAmount: o.maxAmount > 0 ? o.maxAmount : money.maxAmount || 0,
    steps: ownSteps ? combo.exits.steps : money.steps ?? [],
    target: o.target > 0 ? o.target : ownSteps ? 0 : money.target || 0,
    exitMin: o.exitMin > 0 ? o.exitMin : money.exitMin,
  };
}
