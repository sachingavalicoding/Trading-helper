import { istParts } from '../market/marketHours.js';
import { istDay } from './context.js';
import { evaluateStock, MIN_SCORE } from './evaluate.js';

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

/**
 * Replay the scanner over past 1-minute candles of one stock and report what it would have
 * raised and how each idea ended. Uses the same rules as the live scanner, with two differences:
 * there is no order book, and Nifty 50 strength is used only when `nifty` candles are given.
 * `days` limits the replay to N sessions, ending `skipDays` sessions before the latest, so the same
 * data can be cut into an older tuning period and a newer unseen one. Only candles up to each
 * bar are given to the scanner, so it never sees the future. Older sessions still feed the indicators.
 * `legacy` scores with the rules from before ADX, EMA 50 and sector strength were added.
 */
export function replayStock({ symbol, c1, nifty = null, days = 3, legacy = false, skipDays = 0 }) {
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
    ideas.push({ symbol, setup: top.setup, side: top.side, score: top.score, entry: top.entry, stopLoss: top.stopLoss, target1: top.target1, openedAt: now.toISOString(), ...follow(c1, i, top) });
  }
  return ideas;
}

