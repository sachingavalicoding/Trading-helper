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

// Index options bought and sold intraday: a flat fee per order, and the taxes on the premium (not on the strike value).
export const OPTION_RATES = {
  brokerageFlat: 20, // ₹20 per executed order
  sttSellPct: 0.0015, // STT on the sell side premium (raised in 2026; the older 0.1% would be a little lower)
  exchangePct: 0.000351, // NSE options transaction charge on premium
  sebiPct: 0.000001,
  stampBuyPct: 0.00003,
  gstPct: 0.18,
};

/** Charges for one execution of `qty` shares (or option units) at `price`. `segment` 'OPT' prices index options. */
export function calculateCharges({ side, qty, price, segment = 'EQ' }) {
  const turnover = qty * price;
  if (segment === 'OPT') {
    const R = OPTION_RATES;
    const brokerage = R.brokerageFlat;
    const stt = side === 'SELL' ? round2(turnover * R.sttSellPct) : 0;
    const exchange = round2(turnover * R.exchangePct);
    const sebi = round2(turnover * R.sebiPct);
    const stamp = side === 'BUY' ? round2(turnover * R.stampBuyPct) : 0;
    const gst = round2((brokerage + exchange + sebi) * R.gstPct);
    return { brokerage, stt, exchange, sebi, stamp, gst, total: round2(brokerage + stt + exchange + sebi + stamp + gst) };
  }
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
export function roundTripCharges({ qty, price, segment = 'EQ' }) {
  return round2(calculateCharges({ side: 'BUY', qty, price, segment }).total + calculateCharges({ side: 'SELL', qty, price, segment }).total);
}

export const LOCK_CHARGES_MULT = 1.5; // a profit lock or target step never puts the stop below cost + this many times the round-trip charges
