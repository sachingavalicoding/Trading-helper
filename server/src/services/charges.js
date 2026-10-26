import { round2 } from '../utils/money.js';

// Approximate NSE intraday (MIS) equity charges for a discount broker. Rates change with
// exchange/SEBI circulars, so treat these as estimates and update them here when they do.
export const RATES = {
  brokeragePct: 0.0003, // 0.03% per executed order...
  brokerageCap: 20, // ...capped at ₹20
  sttSellPct: 0.00025, // STT 0.025% on the sell side (intraday)
  exchangePct: 0.0000297, // NSE transaction charge 0.00297%
  sebiPct: 0.000001, // SEBI fee ₹10 per crore
  stampBuyPct: 0.00003, // stamp duty 0.003% on the buy side
  gstPct: 0.18, // GST 18% on brokerage + exchange + SEBI fees
};

/** Charges for one execution of `qty` shares at `price`. */
export function calculateCharges({ side, qty, price }) {
  const turnover = qty * price;
  const brokerage = round2(Math.min(RATES.brokerageCap, turnover * RATES.brokeragePct));
  const stt = side === 'SELL' ? round2(turnover * RATES.sttSellPct) : 0;
  const exchange = round2(turnover * RATES.exchangePct);
  const sebi = round2(turnover * RATES.sebiPct);
  const stamp = side === 'BUY' ? round2(turnover * RATES.stampBuyPct) : 0;
  const gst = round2((brokerage + exchange + sebi) * RATES.gstPct);
  const total = round2(brokerage + stt + exchange + sebi + stamp + gst);
  return { brokerage, stt, exchange, sebi, stamp, gst, total };
}

/** Split a charges object proportionally (used when one order both closes and opens a position). */
export function splitCharges(charges, fraction) {
  const out = {};
  for (const [k, v] of Object.entries(charges)) out[k] = round2(v * fraction);
  return out;
}

/** Estimated cost of buying and selling `qty` shares around `price`: what a trade must earn before it is a gain. */
export function roundTripCharges({ qty, price }) {
  return round2(calculateCharges({ side: 'BUY', qty, price }).total + calculateCharges({ side: 'SELL', qty, price }).total);
}
