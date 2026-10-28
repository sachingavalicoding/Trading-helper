import { round2 } from '../utils/money.js';

export const MIN_TRADES = 15; // fewer trades than this say nothing either way

/** Net result of the trades in the older half of the study and in the newer half, so a result that came from one stretch of weeks shows. */
export function halvesOf(trades, midTime) {
  const sum = (xs) => round2(xs.reduce((s, t) => s + t.net, 0));
  return [sum(trades.filter((t) => t.entryTime < midTime)), sum(trades.filter((t) => t.entryTime >= midTime))];
}

/**
 * Keep: made money overall and in both halves. Unsteady: made money overall but lost in one half, so it may only suit one kind of market.
 * Drop: lost money overall (Drop, always negative when it lost in both halves). Too few: under MIN_TRADES trades, no verdict.
 */
export function verdictOf({ trades, net, halves }) {
  if (trades < MIN_TRADES) return 'Too few';
  if (net > 0) return halves[0] > 0 && halves[1] > 0 ? 'Keep' : 'Unsteady';
  return 'Drop';
}
