import { impliedVol } from './pricing.js';
import { parseOptionSymbol, yearsToExpiry } from './symbols.js';
import { roundTripCharges } from '../services/charges.js';
import { roundToTick, round2 } from '../utils/money.js';

// Turns "the Nifty chart says buy a call" into an option order: how many lots, and the fixed rupee stop. There are no targets
// and no trailing stop: the order engine puts the user's profit lock (Account tab) on the position when it fills.

export const MIN_STOP_PCT = 0.03; // a premium stop closer than this share of the premium is inside normal wobble, so the trade uses fewer lots
export const MAX_IV = 0.35; // above this the premium is very expensive and usually deflates fast

/**
 * @param market      the shared indicator set (readMarket): spot price
 * @param contract    { symbol, strike, type, expiry, lotSize }
 * @param premium     live premium of the contract (₹ per unit)
 * @param settings    OptionSettings (budget, maxLots)
 * @param rules       the user's options rules from the Account tab: { stopLoss, lockStart, lockGap }
 * @param available   rupees free in the paper wallet
 * @param spentBudget premium money already tied up in open option trades
 * @returns {{ plan } | { skipped: string }}
 */
export function planTrade({ market: m, contract, premium, settings, rules, available, spentBudget = 0, now = new Date(), lots: wantLots = null }) {
  const o = parseOptionSymbol(contract.symbol);
  if (!o || !(premium > 0)) return { skipped: 'no live premium for the contract' };
  const t = yearsToExpiry(o.expiry, now);
  const iv = impliedVol({ type: o.type, spot: m.spot, strike: o.strike, t, premium }) ?? 0.15;
  if (iv > MAX_IV) return { skipped: `premium is expensive (implied volatility ${Math.round(iv * 100)}%, limit ${MAX_IV * 100}%)` };

  const lotSize = contract.lotSize;
  const stopRupees = rules.stopLoss;
  const byBudget = Math.floor(Math.min(settings.budget - spentBudget, available) / (lotSize * premium * 1.02));
  if (byBudget < 1) return { skipped: `one lot costs ₹${round2(lotSize * premium)}, more than the ₹${round2(Math.min(settings.budget - spentBudget, available))} left to spend` };
  // The stop is a fixed number of rupees, so more lots mean a smaller premium move allowed. Use the most lots that still leave room.
  let lots = Math.min(wantLots ?? settings.maxLots, settings.maxLots, byBudget);
  if (stopRupees > 0) while (lots > 1 && stopRupees / (lots * lotSize) < MIN_STOP_PCT * premium) lots -= 1;
  const qty = lots * lotSize;
  const stopLoss = stopRupees > 0 ? roundToTick(Math.max(premium - stopRupees / qty, 0.05)) : null;
  const risk = stopLoss == null ? premium : premium - stopLoss;

  return {
    plan: {
      symbol: contract.symbol,
      type: o.type,
      strike: o.strike,
      expiry: o.expiry,
      lotSize,
      lots,
      qty,
      premium,
      iv: round2(iv * 100),
      spot: m.spot,
      stopLoss,
      lossPct: round2((risk / premium) * 100),
      riskPerUnit: round2(risk),
      maxLoss: round2(qty * risk),
      lockStart: rules.lockStart,
      lockGap: rules.lockGap,
      charges: roundTripCharges({ qty, price: premium, segment: 'OPT' }),
    },
  };
}
