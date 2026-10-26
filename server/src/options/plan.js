import { bsPrice, impliedVol } from './pricing.js';
import { parseOptionSymbol, yearsToExpiry } from './symbols.js';
import { roundTripCharges } from '../services/charges.js';
import { roundToTick, round2 } from '../utils/money.js';

// Turns "the Nifty chart says buy a call, with the stop at 24350" into an option order: how many lots, the stop and targets
// in premium (₹ per unit), and the lock ladder. Premiums are repriced with Black-Scholes from the live premium's own implied
// volatility, so the stop is the premium the contract will have when the index reaches the chart level, not a guessed %.

export const MIN_LOSS_PCT = 0.1; // a premium stop closer than this is inside normal wobble
export const MAX_LOSS_PCT = 0.3; // if the chart stop would cost more than this share of the premium, the trade is too expensive to take
export const MIN_FIRST_TARGET_R = 1.2; // target 1 must pay at least this many times the premium at risk
export const MAX_FIRST_TARGET_R = 2.5;
export const MAX_IV = 0.35; // above this the premium is very expensive and usually deflates fast
export const MIN_PROFIT_TO_CHARGES = 3;
const MS_YEAR = 365 * 24 * 3600 * 1000;
const WAIT_MS = 20 * 60000; // reprice about 20 minutes ahead: the stop is usually hit, and the target reached, a little later than now

/**
 * @param read        one side of readNifty(): { type, d, stop, levels, ... }
 * @param market      the shared indicator set (readMarket) for the day's range numbers
 * @param contract    { symbol, strike, type, expiry, lotSize }
 * @param premium     live premium of the contract (₹ per unit)
 * @param settings    OptionSettings (budget, maxLossPct, maxLots, trailPct, lockAtPct, lockKeepPct)
 * @param available   rupees free in the paper wallet
 * @param spentBudget premium money already tied up in open option trades
 * @returns {{ plan } | { skipped: string }}
 */
export function planTrade({ read, market: m, contract, premium, settings, available, spentBudget = 0, now = new Date(), lots: wantLots = null }) {
  const o = parseOptionSymbol(contract.symbol);
  if (!o || !(premium > 0)) return { skipped: 'no live premium for the contract' };
  const t = yearsToExpiry(o.expiry, now);
  const iv = impliedVol({ type: o.type, spot: m.spot, strike: o.strike, t, premium }) ?? 0.15;
  if (iv > MAX_IV) return { skipped: `premium is expensive (implied volatility ${Math.round(iv * 100)}%, limit ${MAX_IV * 100}%)` };
  const later = Math.max(t - WAIT_MS / MS_YEAR, (5 * 60000) / MS_YEAR);
  const priceAt = (spot) => bsPrice({ type: o.type, spot, strike: o.strike, t: later, iv });

  // Stop: the premium the contract is worth when the index is at the chart's stop level.
  const rawStop = priceAt(read.stop.price);
  const lossPct = (premium - rawStop) / premium;
  if (lossPct > MAX_LOSS_PCT) return { skipped: `the chart stop (Nifty ${round2(read.stop.price)}) would cost ${Math.round(lossPct * 100)}% of the premium, over the ${MAX_LOSS_PCT * 100}% limit` };
  const stopLoss = roundToTick(Math.max(Math.min(rawStop, premium * (1 - MIN_LOSS_PCT)), 0.05));
  const risk = premium - stopLoss;
  if (!(risk > 0)) return { skipped: 'no room for a stop below the premium' };

  // Target 1: the nearest level ahead that pays enough, but never further than the index usually has left to travel today.
  const room = m.avgRangePct == null ? null : Math.max(m.avgRangePct - m.dayRangePct, m.avgRangePct * 0.3);
  const reachSpot = room == null ? null : m.spot + read.d * (room / 100) * m.spot;
  let target1 = null;
  let targetNote = '';
  for (const lvl of read.levels) {
    const spotGoal = reachSpot != null && read.d * (lvl.price - reachSpot) > 0 ? reachSpot : lvl.price;
    const gain = priceAt(spotGoal) - premium;
    if (gain >= MIN_FIRST_TARGET_R * risk) {
      target1 = premium + Math.min(gain, MAX_FIRST_TARGET_R * risk);
      targetNote = spotGoal === lvl.price ? `Nifty ${round2(lvl.price)} (${lvl.kind})` : `Nifty ${round2(spotGoal)} (about what is left of a usual day's range)`;
      break;
    }
  }
  if (target1 == null) {
    if (read.levels.length) return { skipped: `the nearest levels ahead leave less than ${MIN_FIRST_TARGET_R}x the risk` };
    target1 = premium + 1.5 * risk;
    targetNote = 'one and a half times the risk (no level ahead)';
  }
  target1 = roundToTick(target1);
  const target2 = roundToTick(target1 + risk);
  const target3 = roundToTick(target2 + (target2 - target1)); // the sale: as far past target 2 as 2 is past 1; the first two only lift the stop

  // Size: the most this trade may lose, the money set aside for options, and the lot size.
  const lotSize = contract.lotSize;
  const lossPerLot = lotSize * risk;
  const maxLoss = (settings.budget * settings.maxLossPct) / 100;
  const byRisk = Math.floor(maxLoss / lossPerLot);
  const byBudget = Math.floor(Math.min(settings.budget - spentBudget, available) / (lotSize * premium * 1.02));
  const lots = Math.min(wantLots ?? settings.maxLots, settings.maxLots, byRisk, byBudget);
  if (lots < 1) {
    return {
      skipped: byRisk < 1
        ? `one lot would risk ₹${round2(lossPerLot)}, over the ₹${round2(maxLoss)} limit for one trade`
        : `one lot costs ₹${round2(lotSize * premium)}, more than the ₹${round2(Math.min(settings.budget - spentBudget, available))} left to spend`,
    };
  }
  const qty = lots * lotSize;

  const profit1 = qty * (target1 - premium);
  const charges = roundTripCharges({ qty, price: premium, segment: 'OPT' });
  if (profit1 < MIN_PROFIT_TO_CHARGES * charges) return { skipped: `profit at target 1 (₹${round2(profit1)}) is under ${MIN_PROFIT_TO_CHARGES}x the charges (₹${charges})` };

  const lockTrigger = round2((qty * premium * settings.lockAtPct) / 100);
  const lockAmount = round2((qty * premium * settings.lockKeepPct) / 100);
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
      stopSpot: read.stop.price,
      stopNote: read.stop.note,
      stopLoss,
      lossPct: round2(((premium - stopLoss) / premium) * 100),
      riskPerUnit: round2(risk),
      maxLoss: round2(qty * risk),
      target1,
      target2,
      target3,
      targetNote,
      riskReward: round2((target1 - premium) / risk),
      lockTrigger: lockTrigger > lockAmount && lockAmount > 0 ? lockTrigger : null,
      lockAmount: lockTrigger > lockAmount && lockAmount > 0 ? lockAmount : null,
      trailPct: settings.trailPct > 0 ? settings.trailPct : null,
      charges,
    },
  };
}
