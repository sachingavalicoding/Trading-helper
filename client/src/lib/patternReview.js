import { formatPnl } from './format.js';
import { EXIT_WORD } from './study.js';

const KEY = 'npt_watch_patterns';
export const DEFAULT_WATCH = ['breakout', 'engulfing']; // the two that paid in the 30-day study

/** The tag drawn on the chart beside a pattern's arrow. */
export const CODE = { doubleBottom: 'DB', reversal: 'REV', breakout: 'BO', orb: 'ORB', pullback: 'PB', engulfing: 'ENG', pinBar: 'PIN', insideBar: 'IB', supertrend: 'ST', emaCross: 'EMA', orb30: 'ORB30', pdBreak: 'PDH', momentumBar: 'MOM', vwapReclaim: 'VWR', vwapPullback: 'VWP', volumeBreakout: 'VBO', volumeClimax: 'VCL' };

export function loadWatch() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(v)) return v;
  } catch {
    /* nothing remembered */
  }
  return DEFAULT_WATCH;
}

export function saveWatch(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* the choice is simply not remembered */
  }
}

/** "Breakout of the last hour" -> "Breakout"; the long label is on the pattern's own text. */
export const shortLabel = (label) => String(label).split(/ (?:of|at|in|\/)|,/)[0];

export const sideWord = (side) => (side === 'CE' ? 'Call' : 'Put');

/** Signals of the watched patterns, in time order. */
export const watched = (signals, watch) => signals.filter((s) => watch.includes(s.technique));

/** Why a signal was not traded, in words. */
export function skipText(s, exits) {
  if (s.skipped === 'far') return 'Its stop is too far from the entry, so the bot skips it.';
  if (s.skipped === 'limit') return `Even one lot loses more than the ₹${exits?.lossLimit ?? ''} loss limit at its stop, so the bot skips it.`;
  if (s.skipped === 'price') return 'No option price could be worked out for that moment.';
  return '';
}

/** One exit in a line: "Profit lock at 11:42, +₹820 (2 lots, 34 min)". */
export function exitLine(o, clock) {
  if (!o) return '—';
  return `${EXIT_WORD[o.reason] || o.reason} at ${clock(o.exitTime)}: ${formatPnl(o.net)} (${o.lots} lot${o.lots > 1 ? 's' : ''}, ${o.minutes} min)`;
}

/** What the index did after the entry, in the trade's direction. */
export function afterText(s) {
  const pts = (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`;
  return `Within an hour the index went ${pts(s.best.pts)} points your way (after ${s.best.minutes} min) and ${Math.abs(Math.round(s.worst.pts))} points against you (after ${s.worst.minutes} min). An hour later it stood ${pts(s.after)}.`;
}

/** Total of the lock-exit and target-exit rupees over the traded signals, to see whether the watched patterns paid that day. */
export function dayTotals(signals) {
  const traded = signals.filter((s) => !s.skipped);
  const sum = (k) => traded.reduce((a, s) => a + (s[k]?.net ?? 0), 0);
  return { signals: signals.length, traded: traded.length, skipped: signals.length - traded.length, lock: sum('lock'), target: sum('target'), lockWins: traded.filter((s) => s.lock.net > 0).length, targetWins: traded.filter((s) => s.target.net > 0).length };
}
