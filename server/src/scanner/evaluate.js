import { buildContext } from './context.js';
import { SETUPS } from './setups.js';
import { istParts } from '../market/marketHours.js';

export const MIN_SCORE = 60;
const FIRST_ENTRY_MIN = 9 * 60 + 30; // opening range is only complete at 09:30
const LAST_ENTRY_MIN = 14 * 60 + 45;

const STATUS_POINTS = { ENTRY: 30, WATCHING: 18, MISSED: 10 };
const check = (id, label, points, max, text) => ({ id, label, points, max, text });

/** Score one idea out of 100 and explain every part of the score. */
export function scoreCandidate(ctx, c) {
  const d = c.side === 'BUY' ? 1 : -1;
  const checks = [];

  checks.push(check('setup', 'Setup', STATUS_POINTS[c.status], 30, c.status === 'ENTRY' ? 'Trigger has fired' : c.status === 'WATCHING' ? 'Setup is forming, trigger not fired yet' : 'Trigger fired but price has already run too far'));

  const vwapOk = ctx.vwap != null && d * (ctx.ltp - ctx.vwap) > 0;
  checks.push(check('vwap', 'VWAP', vwapOk ? 7 : 0, 7, ctx.vwap == null ? 'No VWAP yet' : `Price is ${vwapOk ? 'on the right side of' : 'against'} VWAP`));
  checks.push(check('trend5', 'Trend (5m)', d * ctx.trend5 > 0 ? 7 : 0, 7, d * ctx.trend5 > 0 ? 'EMA 9 and EMA 21 agree on 5-minute bars' : 'The 5-minute trend does not agree'));
  checks.push(check('trend15', 'Trend (15m)', d * ctx.trend15 > 0 ? 6 : 0, 6, d * ctx.trend15 > 0 ? 'The 15-minute trend agrees' : 'The 15-minute trend is flat or against'));

  const rv = ctx.relVol;
  const volPts = rv == null ? 0 : rv >= 2 ? 20 : rv >= 1.5 ? 14 : rv >= 1.2 ? 8 : 0;
  checks.push(check('volume', 'Volume', volPts, 20, rv == null ? 'Not enough history to compare volume yet' : `Volume is ${rv.toFixed(1)}x normal for this time of day`));

  const rs = ctx.relStrength == null ? null : d * ctx.relStrength;
  const rsPts = rs == null ? 0 : rs >= 0.5 ? 15 : rs >= 0.2 ? 9 : rs >= 0 ? 4 : 0;
  checks.push(check('strength', 'Vs Nifty 50', rsPts, 15, rs == null ? 'No Nifty 50 reading' : `${rs >= 0 ? 'Stronger' : 'Weaker'} than Nifty 50 by ${Math.abs(rs).toFixed(2)}%`));

  const bookOk = ctx.bookShare != null && (d > 0 ? ctx.bookShare > 0.6 : ctx.bookShare < 0.4);
  checks.push(check('book', 'Order book', bookOk ? 8 : 0, 8, ctx.bookShare == null ? 'No order book' : `${Math.round(ctx.bookShare * 100)}% of pending quantity is on the buy side`));

  const rsiOk = ctx.rsi != null && (d > 0 ? ctx.rsi >= 50 && ctx.rsi <= 72 : ctx.rsi >= 28 && ctx.rsi <= 50);
  checks.push(check('rsi', 'RSI', rsiOk ? 7 : 0, 7, ctx.rsi == null ? 'No RSI yet' : `RSI ${ctx.rsi.toFixed(0)}${rsiOk ? ' supports the move' : ' does not support the move'}`));

  let score = checks.reduce((s, x) => s + x.points, 0);
  const penalties = [];
  if (ctx.niftyChangePct != null && d * ctx.niftyChangePct <= -0.6) {
    score -= 15;
    penalties.push(`Nifty 50 is moving against this trade (${ctx.niftyChangePct.toFixed(2)}%)`);
  }
  if (ctx.rsi != null && (d > 0 ? ctx.rsi > 78 : ctx.rsi < 22)) {
    score -= 10;
    penalties.push(`RSI ${ctx.rsi.toFixed(0)} is stretched, so a pullback is likely`);
  }
  return { ...c, score: Math.max(0, Math.min(100, score)), checks, penalties };
}

/** Only suggest entries between 09:30 and 14:45 IST. */
function inEntryWindow(now) {
  const { minutes } = istParts(now);
  return minutes >= FIRST_ENTRY_MIN && minutes < LAST_ENTRY_MIN;
}

/**
 * All ideas for one stock, best first. With `enforceWindows` (live trading hours) nothing is
 * suggested outside the entry window.
 */
export function evaluateStock(input, { now = new Date(), enforceWindows = false } = {}) {
  const ctx = buildContext(input);
  if (!ctx) return { ctx: null, candidates: [] };
  if (enforceWindows && !inEntryWindow(now)) return { ctx, candidates: [] };
  const candidates = SETUPS.flatMap((setup) => setup(ctx))
    .map((c) => scoreCandidate(ctx, c))
    .sort((a, b) => b.score - a.score);
  return { ctx, candidates };
}
