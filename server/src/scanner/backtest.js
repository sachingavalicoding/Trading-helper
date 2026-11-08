import { calculateCharges } from '../services/charges.js';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Net rupee result of one replayed idea: sized to risk `riskAmount` at its stop, filled
 * `slippagePct` worse than planned on entry and on a stop or time exit (a target fills at its
 * price), minus brokerage and statutory charges on both legs.
 */
export function netResult(idea, opts = {}) {
  const { riskAmount = 1000, slippagePct = 0.05 } = opts;
  const long = idea.side === 'BUY';
  const dir = long ? 1 : -1;
  const slip = slippagePct / 100;
  const entry = idea.entry * (1 + dir * slip);
  const qty = idea.sizedQty ?? sizeOf(idea, opts); // a replay that already sized the trade (its own risk or money cap) keeps that size
  if (!qty) return null;
  const exit = idea.status === 'TARGET_HIT' ? idea.exitPrice : idea.exitPrice * (1 - dir * slip);
  const gross = dir * (exit - entry) * qty;
  const charges = calculateCharges({ side: long ? 'BUY' : 'SELL', qty, price: entry }).total + calculateCharges({ side: long ? 'SELL' : 'BUY', qty, price: exit }).total;
  return { qty, gross: round(gross), charges: round(charges), net: round(gross - charges) };
}

/**
 * Shares bought so the loss at the idea's stop is `riskAmount`, from the entry filled `slippagePct` worse than planned; 0 when not even one share fits.
 * `maxAmount` (rupees put in one trade) and `maxShares` cap it like the live auto trader; 0 or unset = no cap.
 */
export function sizeOf(idea, { riskAmount = 1000, slippagePct = 0.05, maxAmount = 0, maxShares = 0 } = {}) {
  const dir = idea.side === 'BUY' ? 1 : -1;
  const perShare = Math.abs(idea.entry * (1 + (dir * slippagePct) / 100) - idea.stopLoss);
  if (!perShare) return 0;
  let qty = Math.floor(riskAmount / perShare);
  if (maxAmount > 0 && idea.entry > 0) qty = Math.min(qty, Math.floor(maxAmount / idea.entry));
  if (maxShares > 0) qty = Math.min(qty, maxShares);
  return Math.max(0, qty);
}

/** Performance of a list of replayed ideas, in rupees after charges and slippage, in the order they were raised. */
export function evaluate(ideas, opts) {
  const trades = ideas
    .map((i) => ({ idea: i, r: netResult(i, opts) }))
    .filter((t) => t.r)
    .sort((a, b) => new Date(a.idea.openedAt) - new Date(b.idea.openedAt));
  const nets = trades.map((t) => t.r.net);
  const wins = nets.filter((n) => n > 0);
  const losses = nets.filter((n) => n <= 0);
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  let peak = 0;
  let equity = 0;
  let maxDrawdown = 0;
  for (const n of nets) {
    equity += n;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return {
    trades: trades.length,
    winRate: trades.length ? round((wins.length / trades.length) * 100, 0) : null,
    avgWin: wins.length ? round(sum(wins) / wins.length) : null,
    avgLoss: losses.length ? round(sum(losses) / losses.length) : null,
    expectancy: trades.length ? round(sum(nets) / trades.length) : null,
    profitFactor: losses.length && sum(losses) ? round(sum(wins) / Math.abs(sum(losses))) : null,
    totalNet: round(sum(nets)),
    totalCharges: round(sum(trades.map((t) => t.r.charges))),
    maxDrawdown: round(maxDrawdown),
  };
}

/** Same numbers split by a key such as the setup or the hour, so one weak group can be spotted. */
export function evaluateBy(ideas, keyOf, opts) {
  const groups = new Map();
  for (const i of ideas) groups.set(keyOf(i), [...(groups.get(keyOf(i)) || []), i]);
  return [...groups].map(([key, list]) => ({ key, ...evaluate(list, opts) })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/**
 * Which first target would have paid best? For each multiple of the risk, the share of ideas that ran that far before
 * touching their stop, and the average result in risk units if every idea were sold there or stopped
 * (before charges and slippage, which only make the lower multiples look better than they are).
 */
export function targetTable(ideas, multiples = [0.5, 0.75, 1, 1.5, 2, 3]) {
  const rated = ideas.filter((i) => i.runR != null);
  return multiples.map((k) => {
    const hit = rated.filter((i) => i.runR >= k).length;
    const rate = rated.length ? hit / rated.length : null;
    return { target: k, ideas: rated.length, hitRate: rate == null ? null : round(rate * 100, 0), expectancyR: rate == null ? null : round(rate * k - (1 - rate), 2) };
  });
}
