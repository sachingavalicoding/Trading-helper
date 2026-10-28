import { replayStock } from '../scanner/replay.js';
import { evaluate, evaluateBy, netResult, targetTable } from '../scanner/backtest.js';
import { istParts } from '../market/marketHours.js';

// The shares study: the live scanner's rules replayed over past 1-minute candles of the Nifty 50, as paper trades sized to the Account stop.
// It reads history and changes nothing. The replay has no order book. Its exits are in rupees on the shares it would buy: your profit
// ladder from the Account page (`steps`), or a fixed rupee `target` with no lock. The stop is the scanner's chart stop.

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
const hourOf = (i) => `${String(Math.floor(istParts(new Date(i.openedAt)).minutes / 60)).padStart(2, '0')}:00`;
const EXIT_WORD = { STOP: 'Stop hit', LOCK: 'Profit lock', SQUARE_OFF: 'Closed on time', TARGET: 'Target' };

/**
 * @param nifty1   Nifty 1-minute candles
 * @param history  { SYMBOL: 1-minute candles }, a few sessions longer than `days` so the indicators have context
 * @param params   { days, exitMin (the minute of the day, IST, everything is closed), riskAmount, slippagePct, steps (the Account ladder), target (rupees a trade; with it there is no lock) }
 */
export async function runSharesStudy({ nifty1, history, params, onProgress = () => {} }) {
  const opts = { riskAmount: params.riskAmount || 1000, slippagePct: params.slippagePct ?? 0.05 };
  const target = params.target > 0 ? params.target : 0;
  const exitMin = params.exitMin > 0 ? params.exitMin : 15 * 60 + 15;
  const money = { ...opts, steps: params.steps ?? [], target, exitMin };
  const ideas = [];
  const symbols = Object.keys(history).filter((s) => history[s]?.length > 100);
  for (const [n, symbol] of symbols.entries()) {
    onProgress(`Replaying the scanner on ${symbol} (${n + 1}/${symbols.length})`);
    ideas.push(...replayStock({ symbol, c1: history[symbol], nifty: nifty1, days: params.days, exits: 'live', money }));
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
    params: { days: params.days, riskAmount: opts.riskAmount, slippagePct: opts.slippagePct, exit: target ? 'target' : 'lock', target, steps: money.steps, exitMin },
    overall: evaluate(ideas, opts),
    bySetup: rows((i) => i.setup).sort((a, b) => b.totalNet - a.totalNet),
    bySide: rows((i) => i.side, (k) => (k === 'BUY' ? 'Buys' : 'Sells')),
    byHour: rows(hourOf),
    byExit: rows((i) => i.exit, (k) => EXIT_WORD[k] || k),
    firstTarget: targetTable(ideas),
    recent: traded.slice(0, 15).map(({ i, r }) => ({ symbol: i.symbol, setup: i.setup, side: i.side, openedAt: i.openedAt, entry: i.entry, stopLoss: i.stopLoss, exit: EXIT_WORD[i.exit] || i.exit, exitPrice: i.exitPrice, qty: r.qty, net: r.net })),
  };
}
