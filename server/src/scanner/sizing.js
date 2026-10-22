import { round2 } from '../utils/money.js';

/**
 * How many shares risk about `riskPct` of capital if the stop loss is hit, limited by the
 * margin still free and the per-order cap.
 */
export function sizePosition({ capital, riskPct, entry, stopLoss, available, leverage, maxQty }) {
  const perShare = Math.abs(entry - stopLoss);
  const riskAmount = round2((capital * riskPct) / 100);
  if (!perShare || !entry) return { qty: 0, riskAmount, riskUsed: 0, note: 'No valid stop loss' };
  const byRisk = Math.floor(riskAmount / perShare);
  const byMargin = Math.floor((available * leverage) / entry);
  const qty = Math.max(0, Math.min(byRisk, byMargin, maxQty));
  let note = null;
  if (byRisk < 1) note = `The stop is wider than your ${riskPct}% risk allows for one share`;
  else if (byMargin < byRisk) note = 'Limited by the margin you have free';
  return { qty, riskAmount, riskUsed: round2(qty * perShare), note };
}
