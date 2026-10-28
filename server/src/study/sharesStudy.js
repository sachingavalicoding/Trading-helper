import { replayStock } from '../scanner/replay.js';
import { evaluate, evaluateBy, netResult, targetTable } from '../scanner/backtest.js';
import { istParts } from '../market/marketHours.js';

// The shares study: the live scanner's rules replayed over past 1-minute candles of the Nifty 50, as paper trades sized to the Account stop.
// It reads history and changes nothing. The replay has no order book, and its exits are the older percent ladder, not your rupee lock,
// so read it for which setups, hours and sides earn their keep, not for the exact rupees.

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
const hourOf = (i) => `${String(Math.floor(istParts(new Date(i.openedAt)).minutes / 60)).padStart(2, '0')}:00`;
const EXIT_WORD = { STOP: 'Stop hit', LOCK: 'Profit lock', SQUARE_OFF: '15:15 close', TARGET: 'Target' };

/**
 * @param nifty1   Nifty 1-minute candles
 * @param history  { SYMBOL: 1-minute candles }, a few sessions longer than `days` so the indicators have context
 * @param params   { days, riskAmount, slippagePct }
 */
export async function runSharesStudy({ nifty1, history, params, onProgress = () => {} }) {
  const opts = { riskAmount: params.riskAmount || 1000, slippagePct: params.slippagePct ?? 0.05 };
  const ideas = [];
  const symbols = Object.keys(history).filter((s) => history[s]?.length > 100);
  for (const [n, symbol] of symbols.entries()) {
    onProgress(`Replaying the scanner on ${symbol} (${n + 1}/${symbols.length})`);
    ideas.push(...replayStock({ symbol, c1: history[symbol], nifty: nifty1, days: params.days, exits: 'live' }));
    await yieldTurn();
  }
  const rows = (keyOf, label = (k) => k) => evaluateBy(ideas, keyOf, opts).map((r) => ({ ...r, key: label(r.key) }));
  const traded = ideas
    .map((i) => ({ i, r: netResult(i, opts) }))
    .filter((x) => x.r)
    .sort((a, b) => new Date(b.i.openedAt) - new Date(a.i.openedAt));
  return {
    generatedAt: new Date().toISOString(),
    period: { days: params.days, stocks: symbols.length },
    params: { days: params.days, riskAmount: opts.riskAmount, slippagePct: opts.slippagePct },
    overall: evaluate(ideas, opts),
    bySetup: rows((i) => i.setup).sort((a, b) => b.totalNet - a.totalNet),
    bySide: rows((i) => i.side, (k) => (k === 'BUY' ? 'Buys' : 'Sells')),
    byHour: rows(hourOf),
    byExit: rows((i) => i.exit, (k) => EXIT_WORD[k] || k),
    firstTarget: targetTable(ideas),
    recent: traded.slice(0, 15).map(({ i, r }) => ({ symbol: i.symbol, setup: i.setup, side: i.side, openedAt: i.openedAt, entry: i.entry, stopLoss: i.stopLoss, exit: EXIT_WORD[i.exit] || i.exit, exitPrice: i.exitPrice, qty: r.qty, net: r.net })),
  };
}
