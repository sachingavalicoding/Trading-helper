// Client-side estimate shown before placing an order. Mirrors server/src/services/charges.js;
// the server's numbers are the ones actually booked.
const RATES = { brokeragePct: 0.0003, brokerageCap: 20, sttSellPct: 0.00025, exchangePct: 0.0000297, sebiPct: 0.000001, stampBuyPct: 0.00003, gstPct: 0.18 };
const r2 = (n) => Math.round(n * 100) / 100;

export function estimateCharges({ side, qty, price }) {
  const t = qty * price;
  const brokerage = r2(Math.min(RATES.brokerageCap, t * RATES.brokeragePct));
  const stt = side === 'SELL' ? r2(t * RATES.sttSellPct) : 0;
  const exchange = r2(t * RATES.exchangePct);
  const sebi = r2(t * RATES.sebiPct);
  const stamp = side === 'BUY' ? r2(t * RATES.stampBuyPct) : 0;
  const gst = r2((brokerage + exchange + sebi) * RATES.gstPct);
  return { brokerage, stt, exchange, sebi, stamp, gst, total: r2(brokerage + stt + exchange + sebi + stamp + gst) };
}

export const MIS_LEVERAGE = 5;
