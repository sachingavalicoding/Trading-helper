import { writeFileSync } from 'node:fs';
import { Position } from '../models/Position.js';
import { logger } from '../utils/logger.js';

// What one test-run day earned: every round trip of the day, its money after charges, split into options and shares.

const r2 = (n) => Math.round(n * 100) / 100;

const avg = (value, qty) => (qty > 0 ? r2(value / qty) : null);
const secOf = (d) => (d ? Math.floor(new Date(d).getTime() / 1000) : null);

/** Every round trip of the day, oldest first: when it opened and closed, which way, at what average prices, and its money after charges. */
export function tradeList(positions) {
  return positions
    .map((p) => {
      const long = p.direction !== 'SHORT';
      return {
        symbol: p.symbol,
        side: long ? 'BUY' : 'SELL',
        openedAt: secOf(p.openedAt),
        closedAt: p.status === 'CLOSED' ? secOf(p.closedAt) : null,
        entry: long ? avg(p.buyValue ?? 0, p.buyQty ?? 0) : avg(p.sellValue ?? 0, p.sellQty ?? 0),
        exit: p.status === 'CLOSED' ? (long ? avg(p.sellValue ?? 0, p.sellQty ?? 0) : avg(p.buyValue ?? 0, p.buyQty ?? 0)) : null,
        net: r2((p.realizedPnl ?? 0) - (p.charges ?? 0)),
      };
    })
    .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0) || a.symbol.localeCompare(b.symbol));
}

/** One day's result from its positions (plain objects with segment, status, realizedPnl, charges, symbol). */
export function dayResult(day, positions) {
  const trades = positions.map((p) => ({ symbol: p.symbol, segment: p.segment ?? 'EQ', open: p.status === 'OPEN', net: r2((p.realizedPnl ?? 0) - (p.charges ?? 0)), charges: r2(p.charges ?? 0) }));
  const closed = trades.filter((t) => !t.open);
  const part = (seg) => {
    const list = closed.filter((t) => t.segment === seg);
    return { trades: list.length, wins: list.filter((t) => t.net > 0).length, net: r2(list.reduce((s, t) => s + t.net, 0)), charges: r2(list.reduce((s, t) => s + t.charges, 0)) };
  };
  return {
    day,
    trades: closed.length,
    wins: closed.filter((t) => t.net > 0).length,
    net: r2(closed.reduce((s, t) => s + t.net, 0)),
    charges: r2(closed.reduce((s, t) => s + t.charges, 0)),
    options: part('OPT'),
    shares: part('EQ'),
    stillOpen: trades.filter((t) => t.open).length, // should be 0: the day squares off at 15:15
    list: tradeList(positions), // every round trip, for the speed check (dayreplay/speedCheck.js)
  };
}

/**
 * In a test run: once the virtual day is over (and the 15:15 square-off has had its time), write the day's result to `file` and stop.
 * The live server's ladder reads the file when this process exits.
 */
export function finishWhenDone({ clock, day, file, stop, pollMs = 1000, settleMs = 3000 }) {
  const timer = setInterval(async () => {
    if (!clock.finished) return;
    clearInterval(timer);
    await new Promise((r) => setTimeout(r, settleMs));
    try {
      const positions = await Position.find({ tradingDay: day }).lean();
      writeFileSync(file, JSON.stringify(dayResult(day, positions)));
    } catch (err) {
      logger.error(`Could not write the test result: ${err.message}`);
      writeFileSync(file, JSON.stringify({ day, error: err.message }));
    }
    await stop('day finished');
  }, pollMs);
  timer.unref?.();
  return timer;
}
