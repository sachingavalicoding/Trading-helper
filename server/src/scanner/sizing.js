import { round2 } from '../utils/money.js';

/**
 * How many shares risk about `riskPct` of capital if the stop loss is hit, limited by the
 * margin still free and the per-order cap.
 */
export function sizePosition({ capital, riskPct, riskAmount: fixedRisk = null, entry, stopLoss, available, leverage, maxQty, maxAmount = null }) {
  const perShare = Math.abs(entry - stopLoss);
  const riskAmount = fixedRisk > 0 ? round2(fixedRisk) : round2((capital * riskPct) / 100);
  if (!perShare || !entry) return { qty: 0, riskAmount, riskUsed: 0, note: 'No valid stop loss' };
  const byRisk = Math.floor(riskAmount / perShare);
  const byMargin = Math.floor((available * leverage) / entry);
  const byAmount = maxAmount ? Math.floor(maxAmount / entry) : Infinity;
  const qty = Math.max(0, Math.min(byRisk, byMargin, maxQty, byAmount));
  let note = null;
  if (byRisk < 1) note = `The stop is wider than your ${fixedRisk > 0 ? `₹${riskAmount}` : `${riskPct}%`} risk allows for one share`;
  else if (byAmount < Math.min(byRisk, byMargin, maxQty)) note = `Limited by your max of ₹${maxAmount.toLocaleString('en-IN')} per trade`;
  else if (byMargin < byRisk) note = 'Limited by the margin you have free';
  return { qty, riskAmount, riskUsed: round2(qty * perShare), amount: round2(qty * entry), note };
}
