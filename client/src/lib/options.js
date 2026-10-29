// Small helpers for the options screens.
export const EXIT_LABEL = { STOP: 'Stopped', LOCK: 'Locked profit', TARGET: 'Target', MANUAL: 'Manual exit', SQUARE_OFF: 'Square-off', TIME: 'Time exit', TRAIL: 'Trailing stop', BREAKEVEN: 'Break-even stop' };

/** How strong a 0-100 reading is: drives the colour of the score bar. */
export function scoreTone(score, minScore = 70) {
  if (score == null) return 'muted';
  if (score >= minScore) return 'up';
  if (score >= minScore - 15) return 'warn';
  return 'muted';
}

/** "3 Nov" from a YYYY-MM-DD expiry. */
export function shortExpiry(expiry) {
  if (!expiry) return '';
  const [y, m, d] = expiry.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Whole lots held, given the units and the contract's lot size. */
export const lotsOf = (qty, lotSize = 65) => Math.max(1, Math.round(Math.abs(qty) / lotSize));

/** The best premium run so far as a share of the entry, e.g. 0.32 = up 32%. */
export const premiumGain = (ltp, entry) => (ltp != null && entry ? (ltp - entry) / entry : null);
