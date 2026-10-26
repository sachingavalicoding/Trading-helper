import mongoose from 'mongoose';
import { Position, Trade } from '../models/index.js';
import { round2 } from '../utils/money.js';
import { istParts } from '../market/marketHours.js';

const MIN_FOR_PATTERNS = 10; // fewer closed trades than this say little about habits

/**
 * Dashboard numbers. A "trade" for win rate / best / worst is one closed round trip
 * (a Position), scored on net P&L after charges.
 */
export async function getDashboard(userId, { startingBalance, ltpOf, segment = 'EQ' }) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const seg = segment === 'OPT' ? { segment: 'OPT' } : segment === 'EQ' ? { segment: { $ne: 'OPT' } } : {};
  const [closed, open, fills] = await Promise.all([
    Position.find({ user: uid, status: 'CLOSED', ...seg }).sort({ closedAt: 1 }).lean(),
    Position.find({ user: uid, status: 'OPEN', ...seg }).lean(),
    Trade.find({ user: uid, ...seg }).sort({ executedAt: 1 }).select('executedAt tradingDay realizedPnl charges.total').lean(),
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
    openedAt: p.openedAt,
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
    breakdown: breakdown(scored),
    equityCurve,
    dailyPnl: [...daily.entries()].map(([day, pnl]) => ({ day, pnl })),
    openPositions,
  };
}

const rs = (n) => `${n < 0 ? '-' : n > 0 ? '+' : ''}₹${Math.abs(n)}`;

function bucket(trades) {
  const net = round2(trades.reduce((a, t) => a + t.net, 0));
  const wins = trades.filter((t) => t.net > 0).length;
  return { count: trades.length, wins, winRate: round2((wins / trades.length) * 100), net, avgNet: round2(net / trades.length) };
}

function group(trades, keyOf) {
  const map = new Map();
  for (const t of trades) map.set(keyOf(t), [...(map.get(keyOf(t)) || []), t]);
  return [...map].map(([key, list]) => ({ key, ...bucket(list) }));
}

/**
 * Where the results come from: by stock, by direction and by the hour a trade was opened (IST),
 * plus a few plain-language observations. Patterns need at least MIN_FOR_PATTERNS closed trades.
 */
export function breakdown(scored) {
  if (!scored.length) return { bySymbol: [], byDirection: [], byHour: [], insights: [], enough: false, minTrades: MIN_FOR_PATTERNS };
  const bySymbol = group(scored, (t) => t.symbol).sort((a, b) => b.net - a.net);
  const byDirection = group(scored, (t) => t.direction);
  const byHour = group(scored, (t) => Math.floor(istParts(new Date(t.openedAt)).minutes / 60))
    .sort((a, b) => a.key - b.key)
    .map((r) => ({ ...r, label: `${String(r.key).padStart(2, '0')}:00` }));
  const enough = scored.length >= MIN_FOR_PATTERNS;

  const insights = [];
  const gross = scored.reduce((a, t) => a + t.gross, 0);
  const charges = scored.reduce((a, t) => a + t.charges, 0);
  if (gross > 0 && charges > 0) insights.push(`Charges took ${Math.round((charges / gross) * 100)}% of your gross profit.`);
  else if (gross <= 0 && charges > 0) insights.push(`You lost ₹${round2(Math.abs(gross))} before charges, and charges added ₹${round2(charges)} on top.`);
  if (enough) {
    const best = bySymbol[0];
    const worst = bySymbol[bySymbol.length - 1];
    if (best.net > 0) insights.push(`Best stock: ${best.key} (${rs(best.net)} over ${best.count} trade${best.count > 1 ? 's' : ''}).`);
    if (worst.net < 0 && worst.key !== best.key) insights.push(`Weakest stock: ${worst.key} (${rs(worst.net)} over ${worst.count} trade${worst.count > 1 ? 's' : ''}).`);
    if (byDirection.length === 2) {
      const [a, b] = [...byDirection].sort((x, y) => y.avgNet - x.avgNet);
      if (a.avgNet > 0 && a.avgNet > b.avgNet) insights.push(`${a.key === 'LONG' ? 'Buying' : 'Short selling'} works better for you (avg ${rs(a.avgNet)} per trade) than ${b.key === 'LONG' ? 'buying' : 'short selling'} (avg ${rs(b.avgNet)}).`);
    }
    const hours = byHour.filter((h) => h.count >= 3);
    if (hours.length >= 2) {
      const bestH = [...hours].sort((x, y) => y.avgNet - x.avgNet)[0];
      const worstH = [...hours].sort((x, y) => x.avgNet - y.avgNet)[0];
      if (worstH.avgNet < 0) insights.push(`Your weakest time to open trades is ${worstH.label} (avg ${rs(worstH.avgNet)} per trade).`);
      if (bestH.avgNet > 0 && bestH.key !== worstH.key) insights.push(`Your strongest time is ${bestH.label} (avg ${rs(bestH.avgNet)} per trade).`);
    }
  }
  return { bySymbol, byDirection, byHour, insights, enough, minTrades: MIN_FOR_PATTERNS };
}
