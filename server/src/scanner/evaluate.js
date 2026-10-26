import { buildContext } from './context.js';
import { SETUPS } from './setups.js';
import { istParts } from '../market/marketHours.js';

export const MIN_SCORE = 60;
const FIRST_ENTRY_MIN = 9 * 60 + 30; // opening range is only complete at 09:30
const LAST_ENTRY_MIN = 14 * 60 + 45;

const STATUS_POINTS = { ENTRY: 30, WATCHING: 18, MISSED: 10 };
const check = (id, label, points, max, text) => ({ id, label, points, max, text });

const gate = (id, label, pass, text) => ({ id, label, pass, text });

/**
 * Hard checks. The score adds up good signs, but a high score can still hide one fatal flaw,
 * so any failed gate blocks the idea whatever its score. `text` explains a failure.
 */
function runGates(ctx, d, vwapOk, newsDelta) {
  const g = [];
  g.push(gate('volume', 'Volume', ctx.relVol == null || ctx.relVol >= 0.8, `Volume is thin (${ctx.relVol?.toFixed(1)}x normal), so a breakout has little behind it`));
  g.push(gate('vwap', 'VWAP side', ctx.vwap == null || vwapOk, 'Price is on the wrong side of VWAP for this direction'));
  g.push(gate('trend', 'Trend', !(d * ctx.trend5 < 0 || d * ctx.trend15 < 0), 'The 5-minute or 15-minute trend points the other way'));
  g.push(gate('nifty', 'Market', ctx.niftyChangePct == null || d * ctx.niftyChangePct > -0.5, `Nifty 50 is moving against this trade (${ctx.niftyChangePct?.toFixed(2)}%)`));
  g.push(gate('stretch', 'Not stretched', ctx.vwapStretch == null || d * ctx.vwapStretch <= 2.5, `Price is ${Math.abs(ctx.vwapStretch ?? 0).toFixed(1)} ATR from VWAP, so chasing here is risky`));
  g.push(gate('rsi', 'RSI', ctx.rsi == null || !(d > 0 ? ctx.rsi > 78 : ctx.rsi < 22), `RSI ${ctx.rsi?.toFixed(0)} is stretched, so a pullback is likely`));
  g.push(gate('news', 'News', newsDelta > -10, 'Recent news points the other way'));
  return g;
}

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
  const volPts = rv == null ? 0 : rv >= 2 ? 18 : rv >= 1.5 ? 13 : rv >= 1.2 ? 7 : 0;
  checks.push(check('volume', 'Volume', volPts, 18, rv == null ? 'Not enough history to compare volume yet' : `Volume is ${rv.toFixed(1)}x normal for this time of day`));

  const rs = ctx.relStrength == null ? null : d * ctx.relStrength;
  const rsPts = rs == null ? 0 : rs >= 0.5 ? 13 : rs >= 0.2 ? 8 : rs >= 0 ? 3 : 0;
  checks.push(check('strength', 'Vs Nifty 50', rsPts, 13, rs == null ? 'No Nifty 50 reading' : `${rs >= 0 ? 'Stronger' : 'Weaker'} than Nifty 50 by ${Math.abs(rs).toFixed(2)}%`));

  const bookOk = ctx.bookShare != null && (d > 0 ? ctx.bookShare > 0.6 : ctx.bookShare < 0.4);
  checks.push(check('book', 'Order book', bookOk ? 6 : 0, 6, ctx.bookShare == null ? 'No order book' : `${Math.round(ctx.bookShare * 100)}% of pending quantity is on the buy side`));

  const rsiOk = ctx.rsi != null && (d > 0 ? ctx.rsi >= 50 && ctx.rsi <= 72 : ctx.rsi >= 28 && ctx.rsi <= 50);
  checks.push(check('rsi', 'RSI', rsiOk ? 7 : 0, 7, ctx.rsi == null ? 'No RSI yet' : `RSI ${ctx.rsi.toFixed(0)}${rsiOk ? ' supports the move' : ' does not support the move'}`));

  const mh = ctx.macdHist;
  const macdOk = mh != null && d * mh.now > 0 && d * (mh.now - mh.prev) >= 0;
  checks.push(check('macd', 'MACD', macdOk ? 6 : 0, 6, mh == null ? 'No MACD yet' : macdOk ? 'MACD momentum is building in this direction' : 'MACD momentum is not backing the move'));

  const penalties = [];
  let newsDelta = 0;
  const n = ctx.news;
  if (n) {
    const aligned = (n.label === 'BULLISH') === (d > 0);
    const r = n.reaction;
    const headline = `"${n.title}"`;
    if (aligned && r === 'FADING') {
      newsDelta = -8;
      penalties.push(`Good news for this trade is being sold (${headline}); the price fell ${Math.abs(n.movePct)}% since`);
    } else if (aligned) {
      const pts = r === 'AGREES' ? 10 : 5;
      checks.push(check('news', 'News (bonus)', pts, 10, r === 'AGREES' ? `${headline}, and the price confirms it (${n.movePct > 0 ? '+' : ''}${n.movePct}% since)` : `${headline}; the price has not reacted yet`));
    } else {
      newsDelta = r === 'AGREES' ? -15 : -10;
      penalties.push(`News points the other way: ${headline}${r === 'AGREES' ? ' and the price agrees' : ''}`);
    }
  }

  let score = checks.reduce((s, x) => s + x.points, 0) + newsDelta;
  if (ctx.niftyChangePct != null && d * ctx.niftyChangePct <= -0.6) {
    score -= 15;
    penalties.push(`Nifty 50 is moving against this trade (${ctx.niftyChangePct.toFixed(2)}%)`);
  }
  if (ctx.rsi != null && (d > 0 ? ctx.rsi > 78 : ctx.rsi < 22)) {
    score -= 10;
    penalties.push(`RSI ${ctx.rsi.toFixed(0)} is stretched, so a pullback is likely`);
  }
  if (ctx.vwapStretch != null && d * ctx.vwapStretch > 2.5) {
    score -= 8;
    penalties.push(`Price is ${Math.abs(ctx.vwapStretch).toFixed(1)} ATR from VWAP, so chasing here is risky`);
  }
  const gates = runGates(ctx, d, vwapOk, newsDelta);
  return { ...c, score: Math.max(0, Math.min(100, score)), checks, penalties, gates, blocked: gates.filter((g) => !g.pass).map((g) => g.text), news: ctx.news ?? null };
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
