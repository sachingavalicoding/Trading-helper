import { bsPrice } from '../options/pricing.js';
import { atmStrike, chooseExpiry, weeklyExpiries, yearsToExpiry, DEFAULT_LOT_SIZE, DEFAULT_EXPIRY_WEEKDAY } from '../options/symbols.js';
import { calculateCharges } from '../services/charges.js';
import { istParts } from '../market/marketHours.js';
import { round2 } from '../utils/money.js';

// Replays one option buy on the Nifty 1-minute chart. There is no history of real option prices, so the premium is estimated
// with Black-Scholes at a fixed volatility. Direction and timing are real; the rupee amounts are an estimate.
//
// Exits follow the live options trader: sell when a 1-minute candle closes beyond the chart stop, once the profit reaches the
// lock start the stop follows `lockGap` behind the best profit, and everything is closed at the 15:15 square-off.

export const EXIT_MIN = 15 * 60 + 15; // the 15:15 square-off, as live
export const HARD_STOP_MULT = 1.3; // the live trader's premium stop behind the chart stop, for a fast gap
export const SLIPPAGE = 0.003; // 0.3% of the premium lost each way: the spread you cross buying and selling at the market

/**
 * @param c1      Nifty 1-minute bars, oldest first
 * @param byTime  Map of bar time -> index in c1
 * @param signal  { side: 'CE'|'PE', time (entry minute, epoch s), stop (Nifty level) }
 * @param params  { iv, lockStart, lockGap, lotSize, holidays, expiryWeekday, lossLimit, maxLots }
 *                With a `lossLimit` (the Account stop) the lots are sized like the live trader: as many as keep the loss at the chart stop within
 *                the limit, up to `maxLots`, none when even one lot loses more. A hard stop sits at HARD_STOP_MULT times the limit. Without one, 1 lot.
 */
export function simulateTrade({ c1, byTime, signal, params }) {
  const { iv = 0.14, lockStart = 1000, lockGap = 250, lotSize = DEFAULT_LOT_SIZE, holidays = [], expiryWeekday = DEFAULT_EXPIRY_WEEKDAY, lossLimit = 0, maxLots = 2 } = params;
  const start = byTime.get(signal.time);
  if (start == null) return null;
  const long = signal.side === 'CE';
  const entryBar = c1[start];
  const entryAt = new Date(entryBar.time * 1000);
  const strike = atmStrike(entryBar.open);
  const expiry = chooseExpiry(weeklyExpiries(entryAt, { holidays, weekday: expiryWeekday }), entryAt, { minDays: 1 });
  if (!expiry) return null;
  const premiumAt = (spot, time) => bsPrice({ type: signal.side, spot, strike, t: yearsToExpiry(expiry, new Date(time * 1000)), iv });
  const paid = premiumAt(entryBar.open, entryBar.time) * (1 + SLIPPAGE);
  if (paid < 1) return null;
  let lots = 1;
  if (lossLimit > 0) {
    const atStop = premiumAt(signal.stop, entryBar.time) * (1 - SLIPPAGE);
    const perLot = Math.max(paid - atStop, 0.05) * lotSize;
    lots = Math.min(maxLots, Math.floor(lossLimit / perLot));
    if (lots < 1) return { skipped: 'limit' };
  }
  const qty = lots * lotSize;
  const hardLoss = lossLimit > 0 ? -HARD_STOP_MULT * lossLimit : -Infinity;
  const buyCharges = calculateCharges({ side: 'BUY', qty, price: paid, segment: 'OPT' }).total;
  const profitAt = (premium) => (premium * (1 - SLIPPAGE) - paid) * qty;
  const day = istParts(entryAt).dateKey;

  let best = 0;
  let worst = 0;
  let lockLevel = null; // a profit in rupees; the trade is sold when it falls to it
  let exit = null;
  for (let j = start; j < c1.length; j++) {
    const bar = c1[j];
    const at = istParts(new Date(bar.time * 1000));
    if (at.dateKey !== day) {
      const prev = c1[j - 1];
      exit = { time: prev.time + 60, spot: prev.close, profit: profitAt(premiumAt(prev.close, prev.time)), reason: 'EOD' };
      break;
    }
    if (at.minutes >= EXIT_MIN) {
      exit = { time: bar.time, spot: bar.open, profit: profitAt(premiumAt(bar.open, bar.time)), reason: 'EOD' };
      break;
    }
    const against = long ? bar.low : bar.high;
    const favour = long ? bar.high : bar.low;
    if (lockLevel != null) {
      const open = profitAt(premiumAt(bar.open, bar.time));
      const low = profitAt(premiumAt(against, bar.time));
      if (open <= lockLevel) {
        exit = { time: bar.time, spot: bar.open, profit: open, reason: 'LOCK' };
        break;
      }
      if (low <= lockLevel) {
        exit = { time: bar.time, spot: against, profit: lockLevel, reason: 'LOCK' };
        break;
      }
    }
    const closeProfit = profitAt(premiumAt(bar.close, bar.time));
    if (hardLoss > -Infinity) {
      const open = profitAt(premiumAt(bar.open, bar.time));
      const low = profitAt(premiumAt(against, bar.time));
      if (open <= hardLoss || low <= hardLoss) {
        exit = { time: bar.time, spot: open <= hardLoss ? bar.open : against, profit: Math.min(open <= hardLoss ? open : hardLoss, hardLoss), reason: 'HARD' };
        break;
      }
    }
    worst = Math.min(worst, profitAt(premiumAt(against, bar.time)));
    if (long ? bar.close < signal.stop : bar.close > signal.stop) {
      exit = { time: bar.time + 60, spot: bar.close, profit: closeProfit, reason: 'STOP' };
      break;
    }
    best = Math.max(best, profitAt(premiumAt(favour, bar.time)));
    if (best >= lockStart) lockLevel = Math.max(lockLevel ?? -Infinity, best - lockGap);
  }
  if (!exit) {
    const last = c1.at(-1);
    exit = { time: last.time + 60, spot: last.close, profit: profitAt(premiumAt(last.close, last.time)), reason: 'EOD' };
  }
  const sellPremium = (exit.profit / qty + paid) / (1 - SLIPPAGE);
  const charges = round2(buyCharges + calculateCharges({ side: 'SELL', qty, price: Math.max(sellPremium, 0.05), segment: 'OPT' }).total);
  return {
    technique: signal.technique,
    side: signal.side,
    note: signal.note,
    tag: signal.tag,
    score: signal.score,
    lots,
    entryTime: entryBar.time,
    exitTime: exit.time,
    entrySpot: round2(entryBar.open),
    exitSpot: round2(exit.spot),
    stop: round2(signal.stop),
    strike,
    expiry,
    entryPremium: round2(paid),
    gross: round2(exit.profit),
    charges,
    net: round2(exit.profit - charges),
    reason: exit.reason,
    minutes: Math.max(1, Math.round((exit.time - entryBar.time) / 60)),
    best: round2(best),
    worst: round2(worst),
  };
}

/** The numbers that say whether a set of trades is worth following. Rupees are for one lot, after charges. */
export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const net = round2(sum(trades, (t) => t.net));
  const grossWin = sum(wins, (t) => t.net);
  const grossLoss = -sum(losses, (t) => t.net);
  let run = 0;
  let peak = 0;
  let drawdown = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    run += t.net;
    peak = Math.max(peak, run);
    drawdown = Math.max(drawdown, peak - run);
  }
  const bySide = {};
  for (const side of ['CE', 'PE']) {
    const xs = trades.filter((t) => t.side === side);
    bySide[side] = { trades: xs.length, wins: xs.filter((t) => t.net > 0).length, net: round2(sum(xs, (t) => t.net)) };
  }
  const byHour = {};
  for (const t of trades) {
    const h = String(Math.floor(istParts(new Date(t.entryTime * 1000)).minutes / 60)).padStart(2, '0');
    byHour[h] = byHour[h] || { trades: 0, net: 0 };
    byHour[h].trades += 1;
    byHour[h].net = round2(byHour[h].net + t.net);
  }
  const byExit = {};
  for (const t of trades) byExit[t.reason] = (byExit[t.reason] || 0) + 1;
  return {
    trades: n,
    wins: wins.length,
    winRate: n ? Math.round((wins.length / n) * 100) : null,
    net,
    avgNet: n ? round2(net / n) : null,
    avgWin: wins.length ? round2(grossWin / wins.length) : null,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    best: n ? round2(Math.max(...trades.map((t) => t.net))) : null,
    worst: n ? round2(Math.min(...trades.map((t) => t.net))) : null,
    maxDrawdown: round2(drawdown),
    avgMinutes: n ? Math.round(sum(trades, (t) => t.minutes) / n) : null,
    bySide,
    byHour,
    byExit,
  };
}
