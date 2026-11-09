import { netResult } from '../scanner/backtest.js';
import { WEIGHTS, PREV_WEIGHTS, PART_LABELS } from '../scanner/evaluate.js';

// The share score study: does a higher score really mean a better trade, and which parts of the score help?
// It reads every idea the scanner could have entered on the study days, whatever its score (scanner/replay.js `collect`), traded with the
// same exits and sizing as the rest of the study, and splits them by what each part of the score said. It reads history and changes nothing.

const FIXED = ['setup', 'book']; // every idea here has a fired setup (always full); the replay has no order book (always empty)
export const MIN_SIDE = 15; // a part needs at least this many ideas where it agreed and where it did not, or its effect is noise
export const BANDS = [[0, 50], [50, 60], [60, 70], [70, 80], [80, 90], [90, 101]];
const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const DAY = (iso) => iso.slice(0, 10);

/** Trades, win rate, average and total net of a list of { net }. */
export function statsOf(list) {
  const n = list.length;
  if (!n) return { trades: 0, winRate: null, avgNet: null, totalNet: 0 };
  const total = list.reduce((a, t) => a + t.net, 0);
  return { trades: n, winRate: Math.round((list.filter((t) => t.net > 0).length / n) * 100), avgNet: round(total / n), totalNet: round(total) };
}

/** An idea's score from what each part earned and a set of weights (penalties and news left out, so scorers compare like for like). */
export const scoreWith = (parts, weights) => Object.entries(weights).reduce((s, [id, w]) => s + (parts?.[id] ?? 0) * w, 0);

/** For each part: the ideas where it agreed (earned at least half its points) against those where it did not, and the difference. */
export function partTable(trades) {
  return Object.keys(WEIGHTS)
    .filter((id) => !FIXED.includes(id))
    .map((id) => {
      const on = trades.filter((t) => (t.parts?.[id] ?? 0) >= 0.5);
      const off = trades.filter((t) => (t.parts?.[id] ?? 0) < 0.5);
      const a = statsOf(on);
      const b = statsOf(off);
      const enough = on.length >= MIN_SIDE && off.length >= MIN_SIDE;
      const lift = a.avgNet != null && b.avgNet != null ? round(a.avgNet - b.avgNet) : null;
      return { id, label: PART_LABELS[id] ?? id, weight: WEIGHTS[id], on: a, off: b, lift, enough, verdict: !enough ? 'too few' : lift > 0 ? 'helps' : 'does not help' };
    })
    .sort((x, y) => (y.enough - x.enough) || (y.lift ?? -Infinity) - (x.lift ?? -Infinity));
}

const variance = (xs, mean) => (xs.length > 1 ? xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1) : 0);

/**
 * Weights from the data: each part is weighed by how clearly its "agreed" trades beat its "did not" trades (a t-like ratio: the difference in
 * average net over its uncertainty), parts that did not help get 0, and the rest share the points the setup and order book leave. null when no
 * part helped clearly enough. Fit on older days only, so the newer days can check it.
 */
export function suggestWeights(trades) {
  const raw = {};
  for (const id of Object.keys(WEIGHTS)) {
    if (FIXED.includes(id)) continue;
    const on = trades.filter((t) => (t.parts?.[id] ?? 0) >= 0.5).map((t) => t.net);
    const off = trades.filter((t) => (t.parts?.[id] ?? 0) < 0.5).map((t) => t.net);
    if (on.length < MIN_SIDE || off.length < MIN_SIDE) {
      raw[id] = 0;
      continue;
    }
    const ma = on.reduce((a, x) => a + x, 0) / on.length;
    const mb = off.reduce((a, x) => a + x, 0) / off.length;
    const se = Math.sqrt(variance(on, ma) / on.length + variance(off, mb) / off.length);
    raw[id] = se > 0 ? Math.max(0, (ma - mb) / se) : 0;
  }
  const sum = Object.values(raw).reduce((a, x) => a + x, 0);
  if (!(sum > 0.5)) return null;
  const free = 100 - FIXED.reduce((a, id) => a + WEIGHTS[id], 0);
  const out = Object.fromEntries(FIXED.map((id) => [id, WEIGHTS[id]]));
  const ids = Object.keys(raw);
  for (const id of ids) out[id] = Math.round((raw[id] / sum) * free);
  // rounding: put what is left over (or taken) on the strongest part so the total stays exactly 100
  const diff = 100 - Object.values(out).reduce((a, x) => a + x, 0);
  const top = ids.reduce((best, id) => (raw[id] > raw[best] ? id : best), ids[0]);
  out[top] += diff;
  return out;
}

/** Ideas in each score band, so it shows whether a higher score really did better. */
export function byBand(trades, scoreOf) {
  return BANDS.map(([lo, hi]) => ({ band: hi > 100 ? `${lo}+` : `${lo}-${hi - 1}`, ...statsOf(trades.filter((t) => scoreOf(t) >= lo && scoreOf(t) < hi)) }));
}

/** The best third of the ideas, ranked by a scorer: what a minimum score set to keep about a third of them would have paid. */
export function topThird(trades, weights) {
  const ranked = [...trades].sort((a, b) => scoreWith(b.parts, weights) - scoreWith(a.parts, weights));
  return statsOf(ranked.slice(0, Math.max(1, Math.round(ranked.length / 3))));
}

/**
 * @param all   ideas from replayStock({ collect }), each with `parts`, `score`, the exit fields and `openedAt`
 * @param opts  { riskAmount, slippagePct } as for netResult
 */
export function scoreStudy(all, opts) {
  const trades = all
    .map((i) => ({ ...i, net: netResult(i, opts)?.net }))
    .filter((t) => t.net != null)
    .map((t) => ({ ...t, prevScore: Math.round(t.score + scoreWith(t.parts, PREV_WEIGHTS) - scoreWith(t.parts, WEIGHTS)) }));
  if (!trades.length) return { ideas: 0, parts: [], bands: { now: [], before: [] }, suggested: null, check: null };
  const days = [...new Set(trades.map((t) => DAY(t.openedAt)))].sort();
  const cut = days[Math.floor((days.length * 2) / 3)];
  const split = days.length >= 6;
  const older = split ? trades.filter((t) => DAY(t.openedAt) < cut) : trades;
  const newer = split ? trades.filter((t) => DAY(t.openedAt) >= cut) : [];
  const suggested = suggestWeights(older);
  const check =
    split && newer.length >= 20
      ? {
          from: cut,
          ideas: newer.length,
          all: statsOf(newer),
          now: topThird(newer, WEIGHTS),
          before: topThird(newer, PREV_WEIGHTS),
          ...(suggested ? { suggested: topThird(newer, suggested) } : {}),
        }
      : null;
  return {
    ideas: trades.length,
    days: days.length,
    overall: statsOf(trades),
    parts: partTable(trades),
    bands: { now: byBand(trades, (t) => t.score), before: byBand(trades, (t) => t.prevScore) },
    bySetup: [...new Set(trades.map((t) => t.setup))].map((setup) => ({ key: setup, ...statsOf(trades.filter((t) => t.setup === setup)) })),
    weights: WEIGHTS,
    suggested,
    fitOn: split ? 'older days' : 'all days',
    check,
  };
}
