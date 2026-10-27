import { istParts } from '../market/marketHours.js';
import { istDay } from './context.js';
import { evaluateStock, MIN_SCORE } from './evaluate.js';
import { roundToTick } from '../utils/money.js';

const STEP = 5; // look for ideas every 5 minutes, like a person glancing at the screen
const MIN_BARS = 60;
const TTL_BARS = 120;
const SQUARE_OFF_MIN = 15 * 60 + 15;

/** The tick the scanner would have seen at bar `i`, rebuilt from candles (no order book). */
function tickAt(c1, i, dayStart, prevClose, niftyChangePct) {
  const today = c1.slice(dayStart, i + 1);
  const ltp = c1[i].close;
  return {
    ltp,
    open: today[0].open,
    high: Math.max(...today.map((b) => b.high)),
    low: Math.min(...today.map((b) => b.low)),
    prevClose,
    changePct: prevClose ? ((ltp - prevClose) / prevClose) * 100 : null,
    totalBuyQty: 0,
    totalSellQty: 0,
    niftyChangePct,
  };
}

/** Walk forward from the bar after the idea: first of target 1, stop, or expiry. A bar that touches both counts as the stop. */
function follow(c1, from, idea) {
  const long = idea.side === 'BUY';
  const end = Math.min(c1.length - 1, from + TTL_BARS);
  for (let j = from + 1; j <= end; j++) {
    const b = c1[j];
    if (long ? b.low <= idea.stopLoss : b.high >= idea.stopLoss) return { status: 'STOPPED', exitPrice: idea.stopLoss };
    if (long ? b.high >= idea.target1 : b.low <= idea.target1) return { status: 'TARGET_HIT', exitPrice: idea.target1 };
    if (istParts(new Date(b.time * 1000)).minutes >= SQUARE_OFF_MIN) return { status: 'EXPIRED', exitPrice: b.close };
  }
  return { status: 'EXPIRED', exitPrice: c1[end].close };
}

// What the live auto trader does after it buys, as multiples of the money risked (see AutoTrader):
// +1R keeps 0.5R, +2.5R keeps 2R, +5R keeps 4R, then the stop follows (rung - kept) behind the best profit;
// past target 1 or 2 the stop jumps to 80% of the way to it; the sale is at target 3; a trade that has
// sat for 45 minutes without reaching 0.5R and is not in profit is closed; everything is closed at 15:15.
export const LADDER = [[1, 0.5], [2.5, 2], [5, 4]];
const STEP_KEEP = 0.8;
const STALL_MIN = 45;
const STALL_R = 0.5;

/**
 * Walk the same bars with the live exit rules. A bar that touches both the stop and the sale counts as the stop,
 * and a stop raised on a bar only counts from the next bar. Also reports `runR`: how far the idea ran in its favour
 * before price touched its original stop (or the day ended), whatever the exit rules did, so any target can be judged.
 */
export function followLive(c1, from, idea, ladder = LADDER) {
  const d = idea.side === 'BUY' ? 1 : -1;
  const entry = idea.entry;
  const risk = Math.abs(entry - idea.stopLoss);
  const day = istDay(c1[from].time);
  const r = (price) => (d * (price - entry)) / risk;
  let stop = idea.stopLoss;
  let bestR = 0;
  let out = null;
  let runR = 0;
  let stillRunning = true;
  for (let j = from + 1; j < c1.length && istDay(c1[j].time) === day; j++) {
    const b = c1[j];
    const fav = d > 0 ? b.high : b.low;
    const adv = d > 0 ? b.low : b.high;
    if (stillRunning) {
      if (d * (adv - idea.stopLoss) <= 0) stillRunning = false;
      else runR = Math.max(runR, r(fav));
    }
    if (!out) {
      const minutes = istParts(new Date(b.time * 1000)).minutes;
      if (d * (adv - stop) <= 0) out = { status: d * (stop - entry) > 0 ? 'LOCKED' : 'STOPPED', exit: d * (stop - entry) > 0 ? 'LOCK' : 'STOP', exitPrice: stop };
      else if (idea.target3 != null && d * (fav - idea.target3) >= 0) out = { status: 'TARGET_HIT', exit: 'TARGET', exitPrice: idea.target3 };
      else if (minutes >= SQUARE_OFF_MIN) out = { status: 'EXPIRED', exit: 'SQUARE_OFF', exitPrice: b.close };
      else if ((b.time - c1[from].time) / 60 >= STALL_MIN && bestR < STALL_R && r(b.close) <= 0) out = { status: 'EXPIRED', exit: 'TIME', exitPrice: b.close };
      else {
        bestR = Math.max(bestR, r(fav));
        const rung = [...ladder].reverse().find(([at]) => bestR >= at);
        if (rung) stop = d > 0 ? Math.max(stop, entry + risk * Math.max(rung[1], bestR - (rung[0] - rung[1]))) : Math.min(stop, entry - risk * Math.max(rung[1], bestR - (rung[0] - rung[1])));
        for (const t of [idea.target1, idea.target2]) {
          if (t != null && d * (fav - t) > 0) stop = d > 0 ? Math.max(stop, entry + STEP_KEEP * (t - entry)) : Math.min(stop, entry + STEP_KEEP * (t - entry));
        }
      }
    }
    if (out && !stillRunning) break;
  }
  if (!out) {
    const last = c1.findLast((b) => istDay(b.time) === day);
    out = { status: 'EXPIRED', exit: 'SQUARE_OFF', exitPrice: last.close };
  }
  return { ...out, bestR: Math.round(bestR * 100) / 100, runR: Math.round(runR * 100) / 100 };
}

/**
 * Replay the scanner over past 1-minute candles of one stock and report what it would have
 * raised and how each idea ended. Uses the same rules as the live scanner, with two differences:
 * there is no order book, and Nifty 50 strength is used only when `nifty` candles are given.
 * `days` limits the replay to N sessions, ending `skipDays` sessions before the latest, so the same
 * data can be cut into an older tuning period and a newer unseen one. Only candles up to each
 * bar are given to the scanner, so it never sees the future. Older sessions still feed the indicators.
 * `legacy` scores with the rules from before ADX, EMA 50 and sector strength were added.
 */
export function replayStock({ symbol, c1, nifty = null, days = 3, legacy = false, skipDays = 0, exits = 'target1', stopScale = 1, ladder = LADDER }) {
  const dayOf = (b) => istDay(b.time);
  const sessions = [...new Set(c1.map(dayOf))];
  const replayDays = new Set(sessions.slice(Math.max(0, sessions.length - days - skipDays), sessions.length - skipDays));
  const raised = new Set();
  const ideas = [];

  for (let i = MIN_BARS; i < c1.length; i += STEP) {
    const day = dayOf(c1[i]);
    if (!replayDays.has(day)) continue;
    const dayStart = c1.findIndex((b) => dayOf(b) === day);
    const prevBar = dayStart > 0 ? c1[dayStart - 1] : null;
    if (!prevBar) continue;
    let niftyChangePct = null;
    if (nifty?.length) {
      const nBars = nifty.filter((b) => b.time <= c1[i].time);
      const nPrev = nBars.filter((b) => dayOf(b) < day).at(-1);
      if (nBars.length && nPrev) niftyChangePct = ((nBars.at(-1).close - nPrev.close) / nPrev.close) * 100;
    }
    const tick = tickAt(c1, i, dayStart, prevBar.close, niftyChangePct);
    const now = new Date(c1[i].time * 1000);
    const { candidates } = evaluateStock({ symbol, tick, c1: c1.slice(0, i + 1), niftyChangePct }, { now, enforceWindows: true, legacy });
    const top = candidates.find((c) => c.score >= MIN_SCORE);
    if (!top || top.status !== 'ENTRY') continue;
    const key = `${day}|${top.setup}|${top.side}`;
    if (raised.has(key)) continue;
    raised.add(key);
    // stopScale makes the stop tighter (under 1) or wider (over 1) than the scanner's own, to see what the chart-based stop is worth.
    const stopLoss = stopScale === 1 ? top.stopLoss : roundToTick(top.entry - (top.side === 'BUY' ? 1 : -1) * Math.abs(top.entry - top.stopLoss) * stopScale);
    const idea = { symbol, setup: top.setup, side: top.side, score: top.score, entry: top.entry, stopLoss, target1: top.target1, target2: top.target2, target3: top.target3, openedAt: now.toISOString() };
    ideas.push({ ...idea, ...(exits === 'live' ? followLive(c1, i, idea, ladder) : follow(c1, i, idea)) });
  }
  return ideas;
}

