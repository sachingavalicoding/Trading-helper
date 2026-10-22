import mongoose from 'mongoose';
import { Position, Trade } from '../models/index.js';
import { round2 } from '../utils/money.js';

/**
 * Dashboard numbers. A "trade" for win rate / best / worst is one closed round trip
 * (a Position), scored on net P&L after charges.
 */
export async function getDashboard(userId, { startingBalance, ltpOf }) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const [closed, open, fills] = await Promise.all([
    Position.find({ user: uid, status: 'CLOSED' }).sort({ closedAt: 1 }).lean(),
    Position.find({ user: uid, status: 'OPEN' }).lean(),
    Trade.find({ user: uid }).sort({ executedAt: 1 }).select('executedAt tradingDay realizedPnl charges.total').lean(),
  ]);

  const scored = closed.map((p) => ({
    id: p._id,
    symbol: p.symbol,
    direction: p.direction,
    qty: Math.max(p.buyQty, p.sellQty),
    entry: p.avgPrice,
    net: round2(p.realizedPnl - p.charges),
    gross: p.realizedPnl,
    charges: p.charges,
    closedAt: p.closedAt,
  }));
  const wins = scored.filter((t) => t.net > 0);
  const losses = scored.filter((t) => t.net <= 0);
  const sum = (arr) => round2(arr.reduce((a, t) => a + t.net, 0));
  const best = scored.reduce((b, t) => (!b || t.net > b.net ? t : b), null);
  const worst = scored.reduce((w, t) => (!w || t.net < w.net ? t : w), null);

  // Equity curve and daily P&L come from every execution, so entry charges on open positions count too.
  let equity = startingBalance;
  const equityCurve = [{ time: null, equity }];
  const daily = new Map();
  let totalCharges = 0;
  for (const f of fills) {
    const delta = (f.realizedPnl || 0) - (f.charges?.total || 0);
    totalCharges += f.charges?.total || 0;
    equity = round2(equity + delta);
    equityCurve.push({ time: f.executedAt, equity });
    daily.set(f.tradingDay, round2((daily.get(f.tradingDay) || 0) + delta));
  }
  if (equityCurve.length > 1) equityCurve[0].time = equityCurve[1].time;
  else equityCurve.pop();

  const openPositions = open.map((p) => {
    const ltp = ltpOf(p.symbol);
    const unrealized = ltp == null ? null : round2((ltp - p.avgPrice) * p.netQty);
    return { ...p, ltp, unrealized };
  });
  const unrealized = round2(openPositions.reduce((a, p) => a + (p.unrealized || 0), 0));
  const realizedNet = round2(equity - startingBalance);

  return {
    totals: {
      realizedNet,
      unrealized,
      totalPnl: round2(realizedNet + unrealized),
      totalCharges: round2(totalCharges),
      grossRealized: round2(fills.reduce((a, f) => a + (f.realizedPnl || 0), 0)),
    },
    stats: {
      trades: scored.length,
      wins: wins.length,
      losses: losses.length,
      winRate: scored.length ? round2((wins.length / scored.length) * 100) : null,
      avgWin: wins.length ? round2(sum(wins) / wins.length) : null,
      avgLoss: losses.length ? round2(sum(losses) / losses.length) : null,
      profitFactor: losses.length && sum(losses) !== 0 ? round2(sum(wins) / Math.abs(sum(losses))) : null,
      best,
      worst,
    },
    equityCurve,
    dailyPnl: [...daily.entries()].map(([day, pnl]) => ({ day, pnl })),
    openPositions,
  };
}
