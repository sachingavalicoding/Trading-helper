import { istParts, istTimeOn, OPEN_MIN } from '../market/marketHours.js';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (from, to) => (from ? round(((to - from) / from) * 100) : null);

/** A day that ends within this % of its open counts as flat: neither a hit nor a miss. */
export const FLAT_PCT = 0.15;

// A daily candle belongs to the IST session day that its timestamp falls on (the mock feed stamps it with the first bar).
const sessionOf = (c) => Math.floor((c.time + 19800) / 86400);
export const dayNumber = (dateKey) => Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86400000);

/** The finished or running daily candle of one IST date, or null (holiday, or older than the history). */
export const candleOn = (daily, dateKey) => (daily || []).find((c) => sessionOf(c) === dayNumber(dateKey)) ?? null;

/** Close of the session before `dateKey`. */
export function prevCloseBefore(daily, dateKey) {
  const n = dayNumber(dateKey);
  return (daily || []).filter((c) => sessionOf(c) < n).at(-1)?.close ?? null;
}

/** How one session went, all in % so stocks of any price compare. `dip` is the worst point against a buyer. */
export function moveOf(candle, prevClose) {
  if (!candle || !candle.open) return null;
  const { open, high, low, close } = candle;
  return {
    open,
    high,
    low,
    close,
    prevClose,
    gapPct: prevClose ? pct(prevClose, open) : null,
    dayPct: prevClose ? pct(prevClose, close) : null,
    openToClosePct: pct(open, close),
    openToHighPct: pct(open, high),
    openToLowPct: pct(open, low),
    rangePct: pct(low, high),
  };
}

/**
 * Was a call right? `dir` is +1 (expects up) or -1 (expects down), judged from the open to the close,
 * with the best and worst point along the way: what a perfect exit and the deepest dip would have been.
 */
export function judge(dir, move) {
  if (!dir || !move) return null;
  const edgePct = round(dir * move.openToClosePct);
  const flat = Math.abs(move.openToClosePct) < FLAT_PCT;
  const best = dir > 0 ? move.openToHighPct : -move.openToLowPct;
  const worst = dir > 0 ? move.openToLowPct : -move.openToHighPct;
  return { verdict: flat ? 'FLAT' : edgePct > 0 ? 'HIT' : 'MISS', edgePct, bestPct: round(Math.max(0, best)), dipPct: round(Math.min(0, worst)) };
}

export const dirOf = (label) => (label === 'BULLISH' || label === 'BUY' ? 1 : label === 'BEARISH' || label === 'SELL' ? -1 : 0);

/** The 24 hours before the 09:15 open of `dateKey`: the news a trader could read in the morning. */
export function morningWindow(dateKey) {
  const open = istTimeOn(new Date(`${dateKey}T06:00:00Z`), OPEN_MIN);
  return { from: new Date(open.getTime() - 24 * 3600_000), to: open };
}

/** The first daily candle that opens after `publishedAt`: the session a headline could first be traded in. */
export function sessionAfter(publishedAt, daily) {
  const at = new Date(publishedAt).getTime() / 1000;
  return (daily || []).find((c) => sessionOf(c) * 86400 - 19800 + OPEN_MIN * 60 >= at) ?? null;
}

/** IST date (YYYY-MM-DD) of a daily candle. */
export const candleDay = (c) => istParts(new Date((sessionOf(c) * 86400 - 19800 + OPEN_MIN * 60) * 1000)).dateKey;

/** Group calls by `keyOf` and score each group: hit rate counts only decided calls, edge is the average % made in the call's direction. */
export function tally(rows, keyOf) {
  const map = new Map();
  for (const r of rows) map.set(keyOf(r), [...(map.get(keyOf(r)) || []), r]);
  return [...map]
    .map(([key, list]) => {
      const hits = list.filter((r) => r.result.verdict === 'HIT').length;
      const misses = list.filter((r) => r.result.verdict === 'MISS').length;
      const decided = hits + misses;
      return {
        key,
        calls: list.length,
        hits,
        misses,
        flat: list.length - decided,
        hitRate: decided ? round((hits / decided) * 100, 0) : null,
        avgEdgePct: round(list.reduce((s, r) => s + r.result.edgePct, 0) / list.length),
        avgBestPct: round(list.reduce((s, r) => s + r.result.bestPct, 0) / list.length),
        avgDipPct: round(list.reduce((s, r) => s + r.result.dipPct, 0) / list.length),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}
