import { buildContext } from './context.js';
import { SETUPS } from './setups.js';
import { istParts } from '../market/marketHours.js';
import { roundToTick, round2 } from '../utils/money.js';

export const MAX_STOP_PCT = 1.2; // a stop wider than this risks too much on one idea
export const MIN_SCORE = 70; // only strong ideas are shown or alerted
const FIRST_ENTRY_MIN = 9 * 60 + 30; // opening range is only complete at 09:30
const LAST_ENTRY_MIN = 14 * 60 + 30; // late entries have little time to reach target 1 before the 15:15 square-off
const LEGACY_LAST_ENTRY_MIN = 14 * 60 + 45;
export const MAX_TARGET_VS_DAILY_RANGE = 0.8; // target 1 further than this share of the stock's usual daily range is unlikely to be reached
export const MIN_ADAPTED_RR = 1.2; // a target pulled in to fit a slow stock must still pay at least this many times the risk

/**
 * Points each part of the score can earn; they add up to 100 (news is a bonus on top).
 * Change them here. LEGACY_WEIGHTS is the scorer from before ADX, EMA 50 and sector
 * strength were added, kept so the replay can compare old against new.
 */
export const WEIGHTS = { setup: 26, vwap: 4, trend5: 4, trend15: 3, volume: 10, strength: 9, book: 2, rsi: 6, macd: 4, adx: 5, emaStack: 4, sector: 3, monthly: 4, candle: 4, niftyTrend: 3, supertrend: 3, obv: 2, squeeze: 2, cpr: 2 };
export const LEGACY_WEIGHTS = { setup: 30, vwap: 7, trend5: 7, trend15: 6, volume: 18, strength: 13, book: 6, rsi: 7, macd: 6, adx: 0, emaStack: 0, sector: 0, monthly: 0, candle: 0, niftyTrend: 0, supertrend: 0, obv: 0, squeeze: 0, cpr: 0 };
export const MIN_ADX = 15; // below this the stock is moving sideways: it earns no trend points, but is not blocked

const STATUS_POINTS = { ENTRY: 30, WATCHING: 18, MISSED: 10 };
const check = (id, label, points, max, text) => ({ id, label, points, max, text });

const gate = (id, label, pass, text) => ({ id, label, pass, text });

/**
 * Hard checks. The score adds up good signs, but a high score can still hide one fatal flaw,
 * so any failed gate blocks the idea whatever its score. `text` explains a failure.
 */
function runGates(ctx, d, vwapOk, newsDelta, c, legacy) {
  const g = [];
  const stopPct = c.entry ? (Math.abs(c.entry - c.stopLoss) / c.entry) * 100 : 0;
  g.push(gate('stop', 'Stop size', stopPct <= MAX_STOP_PCT, `The stop loss is wide (${stopPct.toFixed(1)}% from entry), so one loss would be big`));
  g.push(gate('volume', 'Volume', ctx.relVol == null || ctx.relVol >= 0.8, `Volume is thin (${ctx.relVol?.toFixed(1)}x normal), so a breakout has little behind it`));
  g.push(gate('vwap', 'VWAP side', ctx.vwap == null || vwapOk, 'Price is on the wrong side of VWAP for this direction'));
  g.push(gate('trend', 'Trend', !(d * ctx.trend5 < 0 || d * ctx.trend15 < 0), 'The 5-minute or 15-minute trend points the other way'));
  g.push(gate('nifty', 'Market', ctx.niftyChangePct == null || d * ctx.niftyChangePct > -0.5, `Nifty 50 is moving against this trade (${ctx.niftyChangePct?.toFixed(2)}%)`));
  g.push(gate('stretch', 'Not stretched', ctx.vwapStretch == null || d * ctx.vwapStretch <= 2.5, `Price is ${Math.abs(ctx.vwapStretch ?? 0).toFixed(1)} ATR from VWAP, so chasing here is risky`));
  g.push(gate('rsi', 'RSI', ctx.rsi == null || !(d > 0 ? ctx.rsi > 78 : ctx.rsi < 22), `RSI ${ctx.rsi?.toFixed(0)} is stretched, so a pullback is likely`));
  if (!legacy) {
    const reach = ctx.month?.avgRangePct;
    const targetPct = c.entry ? (Math.abs(c.target1 - c.entry) / c.entry) * 100 : null;
    g.push(gate('reach', 'Target reachable', reach == null || targetPct == null || targetPct <= MAX_TARGET_VS_DAILY_RANGE * reach, `Target 1 is ${targetPct?.toFixed(1)}% away, but this stock usually moves only about ${reach?.toFixed(1)}% in a whole day`));
  }
  g.push(gate('news', 'News', newsDelta > -10, 'Recent news points the other way'));
  return g;
}

/**
 * A slow stock cannot reach a far target, but it can still pay a smaller one. Pull target 1 (and target 2 with it) in to
 * the stock's usual reach instead of dropping the idea; keep the stop where the chart puts it. A smaller profit is fine,
 * a loss is not, so if the shortened target no longer pays MIN_ADAPTED_RR times the risk the idea stays as it was and the
 * "Target reachable" check blocks it.
 */
export function adaptTargets(ctx, c) {
  const reach = ctx.month?.avgRangePct;
  if (reach == null || !c.entry) return c;
  const dist = Math.abs(c.target1 - c.entry);
  const cap = (MAX_TARGET_VS_DAILY_RANGE * reach * c.entry) / 100;
  if (!(dist > cap)) return c;
  const risk = Math.abs(c.entry - c.stopLoss);
  if (!(risk > 0) || cap / risk < MIN_ADAPTED_RR) return c;
  const d = c.side === 'BUY' ? 1 : -1;
  const scale = cap / dist;
  return {
    ...c,
    target1: roundToTick(c.entry + d * cap),
    target2: roundToTick(c.entry + d * Math.abs(c.target2 - c.entry) * scale),
    riskReward: round2(cap / risk),
    targetNote: `${c.targetNote}, pulled in to ${round2(MAX_TARGET_VS_DAILY_RANGE * reach)}% because this stock usually moves about ${round2(reach)}% a day`,
    adapted: true,
  };
}

/** Score one idea out of 100 and explain every part of the score. */
export function scoreCandidate(ctx, c, { legacy = false } = {}) {
  const W = legacy ? LEGACY_WEIGHTS : WEIGHTS;
  const d = c.side === 'BUY' ? 1 : -1;
  const checks = [];

  checks.push(check('setup', 'Setup', Math.round((STATUS_POINTS[c.status] * W.setup) / 30), W.setup, c.status === 'ENTRY' ? 'Trigger has fired' : c.status === 'WATCHING' ? 'Setup is forming, trigger not fired yet' : 'Trigger fired but price has already run too far'));

  const vwapOk = ctx.vwap != null && d * (ctx.ltp - ctx.vwap) > 0;
  checks.push(check('vwap', 'VWAP', vwapOk ? W.vwap : 0, W.vwap, ctx.vwap == null ? 'No VWAP yet' : `Price is ${vwapOk ? 'on the right side of' : 'against'} VWAP`));
  checks.push(check('trend5', 'Trend (5m)', d * ctx.trend5 > 0 ? W.trend5 : 0, W.trend5, d * ctx.trend5 > 0 ? 'EMA 9 and EMA 21 agree on 5-minute bars' : 'The 5-minute trend does not agree'));
  checks.push(check('trend15', 'Trend (15m)', d * ctx.trend15 > 0 ? W.trend15 : 0, W.trend15, d * ctx.trend15 > 0 ? 'The 15-minute trend agrees' : 'The 15-minute trend is flat or against'));

  const rv = ctx.relVol;
  const volPts = rv == null ? 0 : Math.round(W.volume * (rv >= 2 ? 1 : rv >= 1.5 ? 0.72 : rv >= 1.2 ? 0.39 : 0));
  checks.push(check('volume', 'Volume', volPts, W.volume, rv == null ? 'Not enough history to compare volume yet' : `Volume is ${rv.toFixed(1)}x normal for this time of day`));

  const rs = ctx.relStrength == null ? null : d * ctx.relStrength;
  const rsPts = rs == null ? 0 : Math.round(W.strength * (rs >= 0.5 ? 1 : rs >= 0.2 ? 8 / 13 : rs >= 0 ? 3 / 13 : 0));
  checks.push(check('strength', 'Vs Nifty 50', rsPts, W.strength, rs == null ? 'No Nifty 50 reading' : `${rs >= 0 ? 'Stronger' : 'Weaker'} than Nifty 50 by ${Math.abs(rs).toFixed(2)}%`));

  const bookOk = ctx.bookShare != null && (d > 0 ? ctx.bookShare > 0.6 : ctx.bookShare < 0.4);
  checks.push(check('book', 'Order book', bookOk ? W.book : 0, W.book, ctx.bookShare == null ? 'No order book' : `${Math.round(ctx.bookShare * 100)}% of pending quantity is on the buy side`));

  const rsiOk = ctx.rsi != null && (d > 0 ? ctx.rsi >= 50 && ctx.rsi <= 72 : ctx.rsi >= 28 && ctx.rsi <= 50);
  checks.push(check('rsi', 'RSI', rsiOk ? W.rsi : 0, W.rsi, ctx.rsi == null ? 'No RSI yet' : `RSI ${ctx.rsi.toFixed(0)}${rsiOk ? ' supports the move' : ' does not support the move'}`));

  const mh = ctx.macdHist;
  const macdOk = mh != null && d * mh.now > 0 && d * (mh.now - mh.prev) >= 0;
  checks.push(check('macd', 'MACD', macdOk ? W.macd : 0, W.macd, mh == null ? 'No MACD yet' : macdOk ? 'MACD momentum is building in this direction' : 'MACD momentum is not backing the move'));

  if (W.adx) {
    const a = ctx.adx;
    const pts = a == null ? 0 : a >= 25 ? W.adx : a >= 20 ? Math.round(W.adx * 0.67) : a >= MIN_ADX ? Math.round(W.adx * 0.33) : 0;
    checks.push(check('adx', 'Trend strength (ADX)', pts, W.adx, a == null ? 'Not enough bars for ADX yet' : `ADX ${a.toFixed(0)}: ${a >= 25 ? 'a strong trend' : a >= 20 ? 'a developing trend' : a >= MIN_ADX ? 'a weak trend' : 'moving sideways'}`));
  }
  if (W.emaStack) {
    const st = ctx.emaStack;
    checks.push(check('emaStack', 'EMA 9/21/50', st != null && d * st > 0 ? W.emaStack : 0, W.emaStack, st == null ? 'Not enough bars for EMA 50 yet' : d * st > 0 ? 'EMA 9, 21 and 50 are lined up in this direction' : 'EMA 9, 21 and 50 are not lined up for this direction'));
  }
  if (W.candle) {
    const ok = ctx.candleOk ? ctx.candleOk(d) : null;
    checks.push(check('candle', 'Candle', ok ? W.candle : 0, W.candle, ok == null ? 'No completed bar yet' : ok ? 'The last 5-minute bar closed strongly in this direction' : 'The last 5-minute bar did not close strongly in this direction'));
  }
  if (W.niftyTrend) {
    const m = ctx.marketState;
    const trendOk = m?.niftyTrend != null && d * m.niftyTrend > 0;
    const breadthOk = m?.breadthUp != null && (d > 0 ? m.breadthUp >= 0.55 : m.breadthUp <= 0.45);
    checks.push(check('niftyTrend', 'Market', m == null ? 0 : trendOk && breadthOk ? W.niftyTrend : trendOk || breadthOk ? 1 : 0, W.niftyTrend, m == null ? 'No Nifty 50 trend reading' : `Nifty 50 trend ${trendOk ? 'agrees' : 'does not agree'}; ${m.breadthUp == null ? 'no breadth reading' : `${Math.round(m.breadthUp * 100)}% of the 50 stocks are up${breadthOk ? ', which agrees' : ''}`}`));
  }
  if (W.supertrend) {
    const st = ctx.supertrend;
    checks.push(check('supertrend', 'Supertrend', st && d * st.dir > 0 ? W.supertrend : 0, W.supertrend, st == null ? 'Not enough bars for Supertrend yet' : d * st.dir > 0 ? 'Supertrend points the same way' : 'Supertrend points the other way'));
  }
  if (W.obv) {
    checks.push(check('obv', 'On-balance volume', ctx.obv != null && d * ctx.obv > 0 ? W.obv : 0, W.obv, ctx.obv == null ? 'Not enough bars for on-balance volume yet' : d * ctx.obv > 0 ? 'Volume has been flowing the same way over the last hour' : 'Volume has not been flowing the same way'));
  }
  if (W.squeeze) {
    const q = ctx.squeeze;
    const ok = q?.released && d * q.side > 0;
    checks.push(check('squeeze', 'Squeeze', ok ? W.squeeze : 0, W.squeeze, q == null ? 'Not enough bars for the Bollinger squeeze' : ok ? 'A quiet Bollinger squeeze is breaking in this direction' : 'No squeeze breaking in this direction'));
  }
  if (W.cpr) {
    const p = ctx.pivots;
    const beyond = p != null && (d > 0 ? ctx.ltp > p.tc : ctx.ltp < p.bc);
    checks.push(check('cpr', 'Pivot range', beyond ? W.cpr : 0, W.cpr, p == null ? 'No previous day for the central pivot range' : beyond ? `Price is ${d > 0 ? 'above' : 'below'} yesterday's central pivot range${p.widthPct < 0.3 ? ', a narrow one, which suggests a trending day' : ''}` : "Price is not past yesterday's central pivot range in this direction"));
  }
  if (W.monthly) {
    const m = ctx.month;
    const ok = m != null && d * m.trend > 0;
    checks.push(check('monthly', 'Last month', ok ? W.monthly : 0, W.monthly, m == null ? 'Not enough daily history for a monthly view' : ok ? `The last ${m.sessions} sessions trend ${d > 0 ? 'up' : 'down'}, in line with this trade` : `The last ${m.sessions} sessions do not trend ${d > 0 ? 'up' : 'down'}`));
  }
  if (W.sector) {
    const ss = ctx.sectorStrength == null ? null : d * ctx.sectorStrength;
    checks.push(check('sector', 'Sector', ss != null && ss > 0.1 ? W.sector : 0, W.sector, ss == null ? 'No sector reading' : `Its sector is ${ss > 0.1 ? 'backing' : 'not backing'} this direction (${ctx.sectorStrength >= 0 ? '+' : ''}${ctx.sectorStrength.toFixed(2)}% vs Nifty 50)`));
  }

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
  const gates = runGates(ctx, d, vwapOk, newsDelta, c, legacy);
  return { ...c, score: Math.max(0, Math.min(100, score)), checks, penalties, gates, blocked: gates.filter((g) => !g.pass).map((g) => g.text), news: ctx.news ?? null };
}

/** Only suggest entries between 09:30 and 14:30 IST. */
function inEntryWindow(now, legacy = false) {
  const { minutes } = istParts(now);
  return minutes >= FIRST_ENTRY_MIN && minutes < (legacy ? LEGACY_LAST_ENTRY_MIN : LAST_ENTRY_MIN);
}

/**
 * All ideas for one stock, best first. With `enforceWindows` (live trading hours) nothing is
 * suggested outside the entry window.
 */
export function evaluateStock(input, { now = new Date(), enforceWindows = false, legacy = false } = {}) {
  const ctx = buildContext(input);
  if (!ctx) return { ctx: null, candidates: [] };
  if (enforceWindows && !inEntryWindow(now, legacy)) return { ctx, candidates: [] };
  const candidates = SETUPS.flatMap((setup) => setup(ctx))
    .map((c) => scoreCandidate(ctx, legacy ? c : adaptTargets(ctx, c), { legacy }))
    .sort((a, b) => b.score - a.score);
  return { ctx, candidates };
}
