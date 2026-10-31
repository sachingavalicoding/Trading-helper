import { formatPnl } from './format.js';
import { EXIT_WORD } from './study.js';
import { DEFAULT_EXIT_MIN, timeText } from './ladder.js';

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

const SEEN_KEY = 'npt_watch_combos_seen';

/** Your combinations the Review has already offered: a new one is switched on once, and after that the choice is yours. */
export function loadSeen() {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY));
    if (Array.isArray(v)) return v;
  } catch {
    /* nothing remembered */
  }
  return [];
}

export function saveSeen(list) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(list));
  } catch {
    /* the choice is simply not remembered */
  }
}

/** Switch on the combinations of `patterns` that have never been offered; returns the new watch list and seen list, or null when nothing is new. */
export function offerCombos(watch, seen, patterns) {
  const fresh = (patterns || []).filter((p) => p.combo && !p.off && !seen.includes(p.key)).map((p) => p.key);
  return fresh.length ? { watch: [...watch, ...fresh], seen: [...seen, ...fresh] } : null;
}

export function saveWatch(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* the choice is simply not remembered */
  }
}

/** "Breakout of the last hour" -> "Breakout"; the long label is on the pattern's own text. */
export const shortLabel = (label) => (String(label).startsWith('Mine: ') || String(label).startsWith('Check: ') || String(label).startsWith('Trial: ') ? String(label) : String(label).split(/ (?:of|at|in|\/)|,/)[0]);

/** The tag drawn beside an arrow: the pattern's own code, or MY for one of your combinations. */
export const codeOf = (technique) => CODE[technique] || (String(technique).startsWith('combo:') ? 'MY' : String(technique).startsWith('check:') ? 'IND' : String(technique).startsWith('trial:') ? 'NEW' : technique);

/** The indicator keys among the watched keys: they are asked for from the server, which draws only those. */
export const checksOf = (watch) => watch.filter((k) => String(k).startsWith('check:')).map((k) => k.slice(6));

export const sideWord = (side) => (side === 'CE' ? 'Call' : 'Put');

/** Signals of the watched patterns, in time order. */
export const watched = (signals, watch) => signals.filter((s) => watch.includes(s.technique));

/** Why a signal was not traded, in words. */
export function skipText(s, exits) {
  if (s.skipped === 'far') return 'Its stop is too far from the entry, so the bot skips it.';
  if (s.skipped === 'limit') return `Even one lot loses more than the ₹${exits?.lossLimit ?? ''} loss limit at its stop, so the bot skips it.`;
  if (s.skipped === 'late') return `It formed at or after the ${timeText(exits?.exitMin ?? DEFAULT_EXIT_MIN)} exit time, so no trade is taken.`;
  if (s.skipped === 'price') return 'No option price could be worked out for that moment (with real prices on, that contract was not saved).';
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

const HHMM = (clock, t) => clock(t);

/** The biggest moves of the day with what the signals near their start did, in one sentence each: this is how a missed move is traced. */
export function moveLines(moves, patterns, clock = HHMM.bind(null, (t) => t)) {
  const name = (key) => shortLabel(patterns.find((p) => p.key === key)?.label ?? key);
  return (moves || []).map((m) => {
    const head = `${m.side === 'CE' ? 'Up' : 'Down'} ${Math.round(m.pts)} points, ${clock(m.from)} to ${clock(m.to)} (a ${m.side === 'CE' ? 'call' : 'put'} bought at the low would have been on the right side).`;
    if (!m.signals.length) return `${head} No signal formed within 15 minutes before it or during it, so none of the patterns or combinations in this list would have caught it.`;
    const parts = m.signals.map((x) => `${name(x.technique)} at ${clock(x.time)} ${x.skipped ? `was skipped (${SKIP_SHORT[x.skipped] || x.skipped})` : `was traded: ${formatPnl(x.net)}`}`);
    return `${head} Signals near it: ${parts.join('; ')}.`;
  });
}

const SKIP_SHORT = { far: 'stop too far', limit: 'over the loss limit', late: 'after the exit time', price: 'no option price' };

/** How the checks of a combination stood when it fired: ✓ for a check that held, – for one that did not (a combination of "at least 2 of 3" can fire without all). */
export function whyText(why) {
  if (!why?.length) return '';
  return why.map((w) => (w.held ? `✓ ${w.label}` : `– ${w.label}`)).join('  ');
}

/** One tried check in words: "skips 2 entries (2 losers −₹4,100), keeps 4, adds 1 (+₹900)". */
export function improveLine(x) {
  const k = x.skipped;
  const parts = [k.trades ? `skips ${k.trades} ${k.trades === 1 ? 'entry' : 'entries'} (${k.losers} ${k.losers === 1 ? 'loser' : 'losers'} ${formatPnl(k.losersNet)}${k.winners ? `, ${k.winners} ${k.winners === 1 ? 'winner' : 'winners'} ${formatPnl(k.winnersNet)}` : ''})` : 'skips nothing'];
  parts.push(`keeps ${x.kept.trades}`);
  if (x.added.trades) parts.push(`adds ${x.added.trades} (${formatPnl(x.added.net)})`);
  return parts.join(', ');
}
