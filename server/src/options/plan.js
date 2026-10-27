import { bsPrice, impliedVol } from './pricing.js';
import { parseOptionSymbol, yearsToExpiry } from './symbols.js';
import { roundTripCharges } from '../services/charges.js';
import { roundToTick, round2 } from '../utils/money.js';
import { effectiveLadder } from '../utils/ladder.js';

// Turns "the Nifty chart says buy a call, with the stop at 24350" into an option order: how many lots, the stop and targets
// in premium (₹ per unit), and the lock ladder. Premiums are repriced with Black-Scholes from the live premium's own implied
// volatility, so the stop is the premium the contract will have when the index reaches the chart level, not a guessed %.

export const MIN_LOSS_PCT = 0.1; // a premium stop closer than this is inside normal wobble
export const MAX_LOSS_PCT = 0.3; // if the chart stop would cost more than this share of the premium, the trade is too expensive to take
export const MIN_FIRST_TARGET_R = 1.2; // target 1 must pay at least this many times the premium at risk
export const MAX_FIRST_TARGET_R = 2.5;
export const AIM_FIRST_PER_LOT = 1500; // target 1 aims for about this profit per lot and the sale for AIM_SALE_PER_LOT; the day's reach can only make them smaller
export const AIM_SALE_PER_LOT = 2500;
export const WORST_CASE_SHARE = 1.5; // even if only the backup premium stop works, one trade may lose at most this many times the loss limit
export const MIN_SIZING_LOSS_PCT = 0.05; // the loss at the chart stop used to size the trade is never counted as smaller than this share of the premium
export const REACH_SHARE = 0.8; // targets stay within this share of the index's usual daily range (as for shares)
export const MIN_ROOM_SHARE = 0.25; // late in a big day there is still at least this share of a usual range to aim for
const REACH_ATR_FALLBACK = 6; // without daily history: about this many 5-minute ATRs
export const MAX_IV = 0.35; // above this the premium is very expensive and usually deflates fast
export const MIN_PROFIT_TO_CHARGES = 3;
// The profit ladder in rupees per lot: +700 keeps 400, +1,000 keeps 700, +1,500 keeps 1,200, +2,500 keeps 2,200, and past each rung the stop follows (profit - kept) behind the best profit.
export const OPTION_LADDER = [[700, 400], [1000, 700], [1500, 1200], [2500, 2200]];
const MS_YEAR = 365 * 24 * 3600 * 1000;
const WAIT_MS = 20 * 60000; // reprice about 20 minutes ahead: the stop is usually hit, and the target reached, a little later than now

/**
 * @param read        one side of readNifty(): { type, d, stop, levels, ... }
 * @param market      the shared indicator set (readMarket) for the day's range numbers
 * @param contract    { symbol, strike, type, expiry, lotSize }
 * @param premium     live premium of the contract (₹ per unit)
 * @param settings    OptionSettings (budget, maxLossPct, maxLots, trailPct, lockLadder)
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

  // How far the index can realistically still go today: most of a usual day's range, less what it has already moved
  // (never less than a quarter of it). With no daily history, a few hours of ordinary movement. Every target stays inside this.
  const roomPts = m.avgRangePct == null ? m.atr5 * REACH_ATR_FALLBACK : (Math.max(REACH_SHARE * m.avgRangePct - m.dayRangePct, MIN_ROOM_SHARE * m.avgRangePct) / 100) * m.spot;
  const reachSpot = m.spot + read.d * roomPts;
  const reachPremium = priceAt(reachSpot);

  // Target 1: the nearest level ahead that pays enough, but never beyond that reach.
  let target1 = null;
  let targetNote = '';
  for (const lvl of read.levels) {
    const spotGoal = read.d * (lvl.price - reachSpot) > 0 ? reachSpot : lvl.price;
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
  // Options aim for about twice what a share does: a level far away is pulled in to about AIM_FIRST_PER_LOT a lot (never below the minimum reward for the risk).
  target1 = Math.max(Math.min(target1, premium + AIM_FIRST_PER_LOT / contract.lotSize), premium + MIN_FIRST_TARGET_R * risk);
  target1 = roundToTick(target1);
  // The sale is as far past target 2 as 2 is past 1 (the first two only lift the stop), but no further than the day's reach:
  // a target the index is unlikely to get to is just a stop that never moves.
  const aimSale = premium + AIM_SALE_PER_LOT / contract.lotSize;
  const target3 = roundToTick(Math.max(Math.min(target1 + 2 * risk, reachPremium, aimSale), target1 + 0.5 * risk));
  const target2 = roundToTick(target1 + (target3 - target1) / 2);

  // Size: the most this trade may lose, the money set aside for options, and the lot size.
  const lotSize = contract.lotSize;
  // Size from what the trade really loses when the chart stop is hit. The premium stop, at least 10% down, is only the backup for
  // when the index stop is not acted on, so it does not shrink the position.
  const chartLoss = Math.min(Math.max(premium - rawStop, MIN_SIZING_LOSS_PCT * premium), risk);
  const lossPerLot = lotSize * chartLoss;
  const maxLoss = (settings.budget * settings.maxLossPct) / 100;
  const byRisk = Math.min(Math.floor(maxLoss / lossPerLot), Math.floor((WORST_CASE_SHARE * maxLoss) / (lotSize * risk)));
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

  // The ladder is in rupees per lot, so it starts at a profit that really happens on one lot and grows with the lots held.
  const lockSteps = effectiveLadder(settings.lockLadder, OPTION_LADDER).map(([at, keep]) => ({ at: round2(lots * at), keep: round2(lots * keep) }));
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
      maxLoss: round2(qty * chartLoss),
      worstCase: round2(qty * risk),
      target1,
      target2,
      target3,
      targetNote,
      riskReward: round2((target1 - premium) / risk),
      lockSteps,
      trailPct: settings.trailPct > 0 ? settings.trailPct : null,
      charges,
    },
  };
}
