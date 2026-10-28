import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { ema, rsi, atr, adx, macd, supertrend, swings, choppiness, stochastic, heikinAshi, sessionMean } from '../signals/indicators.js';
import { pivotsFrom, candleConfirms } from '../scanner/pivots.js';
import { summarizeDaily } from '../scanner/daily.js';
import { istParts } from '../market/marketHours.js';
import { roundToTick, round2 } from '../utils/money.js';

// Reads the Nifty 50 chart and says whether a call (CE, bet on a rise) or a put (PE, bet on a fall) has a case right now.
// Options lose money fast when the entry is late or the market is sideways, so every part below can say no.

export const OPTION_WEIGHTS = { trend5: 8, trend15: 8, emaStack: 6, mean: 8, supertrend: 8, adx: 8, rsi: 6, macd: 6, level: 10, breadth: 8, candle: 6, heikin: 5, stoch: 4, cpr: 5, chop: 4 }; // adds up to 100
export const OPTION_MIN_SCORE = 70;
export const FIRST_ENTRY_MIN = 9 * 60 + 15; // the market opens: index options have no pre-market, so this is the earliest a buy can be priced
export const LAST_ENTRY_MIN = 15 * 60 + 15; // the 15:15 square-off: no new trade after it
export const MIN_STOP_ATR = 0.8; // a stop closer than this to the price is hit by ordinary noise
export const MAX_STOP_ATR = 2.0; // if the nearest chart level is further than this, the stop would be too wide to risk
const MAX_SPENT = 1.5; // today's range already this many times the usual daily range: the move is mostly done
const REV_BARS = 24; // a reversal is read from the last 24 five-minute bars (2 hours)
const REV_MIN_DROP_ATR = 4; // the move that is reversing must have run at least this many ATRs
const REV_MIN_BOUNCE_ATR = 1.2; // the turn must have shown itself: price this far off the extreme...
const REV_MAX_BOUNCE_ATR = 2; // ...but no further, so the stop just beyond the extreme is still within MAX_STOP_ATR
const REV_MAX_GIVEBACK = 0.6; // and it has not already won back more than this share of the move
const STRETCH_ATR = 3; // price this far from its 21 EMA: the move is extended and chasing it is risky

const IST = 19800;
const istDay = (t) => Math.floor((t + IST) / 86400);
const last = (points) => points.at(-1)?.value ?? null;
const sign = (fast, slow) => (fast == null || slow == null || Math.abs(fast - slow) / slow < 0.0002 ? 0 : Math.sign(fast - slow));
const check = (id, label, points, max, text) => ({ id, label, points, max, text });
const gate = (id, label, pass, text) => ({ id, label, pass, text });

/** Indicators every direction shares, computed once from 1-minute candles (oldest first, last bar still forming). */
export function readMarket({ c1, daily = null, tick, breadthUp = null }) {
  if (!tick || !c1 || c1.length < 60) return null;
  const c5 = aggregateCandles(c1, '5m');
  const c15 = aggregateCandles(c1, '15m');
  if (c5.length < 30) return null;
  const spot = tick.ltp;
  const day = istDay(c1.at(-1).time);
  const today1 = c1.filter((b) => istDay(b.time) === day);
  const prior1 = c1.filter((b) => istDay(b.time) < day);
  const done5 = c5.slice(0, -1);
  const atr5 = atr(done5, 14) || spot * 0.0015;

  let pdh = null;
  let pdl = null;
  let pdc = null;
  const prevDaily = (daily || []).filter((c) => istDay(c.time) < day).at(-1);
  if (prevDaily) ({ high: pdh, low: pdl, close: pdc } = prevDaily);
  else if (prior1.length) {
    const prev = prior1.filter((b) => istDay(b.time) === istDay(prior1.at(-1).time));
    pdh = Math.max(...prev.map((b) => b.high));
    pdl = Math.min(...prev.map((b) => b.low));
    pdc = prev.at(-1).close;
  }
  const first15 = today1.slice(0, 15);
  const or = today1.length >= 16 ? { high: Math.max(...first15.map((b) => b.high)), low: Math.min(...first15.map((b) => b.low)) } : null;
  const pivots = pdh != null ? pivotsFrom({ high: pdh, low: pdl, close: pdc }) : null;
  const month = summarizeDaily(daily, spot, day);
  const dayHigh = Math.max(...today1.map((b) => b.high));
  const dayLow = Math.min(...today1.map((b) => b.low));
  const e50 = done5.length >= 50 ? last(ema(done5, 50)) : null;
  const e9 = last(ema(done5, 9));
  const e21 = last(ema(done5, 21));
  const hist = macd(done5).histogram;

  return {
    spot,
    atr5,
    done5,
    c5,
    day,
    e9,
    e21,
    e50,
    trend5: sign(e9, e21),
    trend15: sign(last(ema(c15.slice(0, -1), 9)), last(ema(c15.slice(0, -1), 21))),
    emaStack: e50 == null ? null : e9 > e21 && e21 > e50 ? 1 : e9 < e21 && e21 < e50 ? -1 : 0,
    mean: sessionMean(c1),
    st: supertrend(done5),
    adx: adx(done5, 14),
    rsi: last(rsi(done5, 14)),
    macd: hist.length >= 2 ? { now: hist.at(-1).value, prev: hist.at(-2).value } : null,
    chop: choppiness(done5, 14),
    stoch: stochastic(done5),
    ha: heikinAshi(done5),
    swings: swings(done5, 2),
    or,
    pdh,
    pdl,
    pivots,
    dayHigh,
    dayLow,
    dayRangePct: ((dayHigh - dayLow) / spot) * 100,
    avgRangePct: month?.avgRangePct ?? null,
    breadthUp,
    lastBar: done5.at(-1),
    prevBar: done5.at(-2),
  };
}

/** Levels the index may stall at or run to, nearest first in direction `d` and at least half an ATR away. */
export function levelsAhead(m, d) {
  const all = [
    ['prev day high', m.pdh],
    ['prev day low', m.pdl],
    ['opening range high', m.or?.high],
    ['opening range low', m.or?.low],
    ['day high', m.dayHigh],
    ['day low', m.dayLow],
    ['resistance 1', m.pivots?.r1],
    ['support 1', m.pivots?.s1],
    ['pivot', m.pivots?.pivot],
    ['round number', d > 0 ? Math.ceil((m.spot + 1) / 100) * 100 : Math.floor((m.spot - 1) / 100) * 100],
  ];
  return all
    .filter(([, p]) => Number.isFinite(p) && d * (p - m.spot) >= m.atr5 * 0.5)
    .map(([kind, price]) => ({ kind, price: roundToTick(price) }))
    .sort((a, b) => d * (a.price - b.price));
}

/**
 * Where the idea is proved wrong, on the Nifty chart: the closest swing low (for a call) or high (for a put), the supertrend
 * line, the 21 EMA or today's average, whichever sits at least MIN_STOP_ATR away, less a small buffer. Nothing within
 * MAX_STOP_ATR means the nearest invalidation is too far to risk, and there is no trade.
 */
export function chartStop(m, d) {
  const found = [];
  const swing = (d > 0 ? m.swings.lows : m.swings.highs).filter((p) => d * (m.spot - p) > 0).slice(-3);
  for (const p of swing) found.push({ price: p, note: `${d > 0 ? 'below the last swing low' : 'above the last swing high'} ${round2(p)}` });
  if (m.st && m.st.dir === d) found.push({ price: m.st.line, note: `through the supertrend line ${round2(m.st.line)}` });
  if (m.e21 != null && d * (m.spot - m.e21) > 0) found.push({ price: m.e21, note: `through the 21 EMA ${round2(m.e21)}` });
  if (m.mean != null && d * (m.spot - m.mean) > 0) found.push({ price: m.mean, note: `back through today's average ${round2(m.mean)}` });
  const buffer = m.atr5 * 0.15;
  const usable = found
    .map((f) => ({ price: f.price - d * buffer, note: f.note }))
    .filter((f) => d * (m.spot - f.price) >= MIN_STOP_ATR * m.atr5)
    .sort((a, b) => d * (b.price - a.price)); // nearest to the price first
  const pick = usable[0];
  if (!pick) return { price: roundToTick(m.spot - d * 1 * m.atr5), note: 'one ATR from the price (no chart level close enough)', ok: true };
  const far = d * (m.spot - pick.price) > MAX_STOP_ATR * m.atr5;
  return { price: roundToTick(pick.price), note: pick.note, ok: !far, farBy: far ? round2((d * (m.spot - pick.price)) / m.atr5) : null };
}

/**
 * A reversal off the extreme of a sharp move: for a call, a low that came after a fall of at least REV_MIN_DROP_ATR, with price now
 * REV_MIN_BOUNCE_ATR to REV_MAX_BOUNCE_ATR above it, a higher low since the extreme and a 5-minute bar that closed above the previous bar's high.
 * Trend scores are all against it at the turn, so it has its own score: 55 plus 9 for each of five confirmations
 * (RSI came back from an extreme, breadth agrees, MACD momentum building, supertrend turned, a strong last bar), so 3 of 5 reach 82.
 * The stop is just beyond the extreme, which is where the turn is proved wrong.
 */
export function findReversal(m, d) {
  const bars = m.done5.slice(-REV_BARS);
  if (bars.length < 12 || !m.lastBar || !m.prevBar) return null;
  const extremeAt = bars.reduce((best, b, i) => (d > 0 ? (b.low < bars[best].low ? i : best) : (b.high > bars[best].high ? i : best)), 0);
  if (extremeAt === 0 || extremeAt > bars.length - 3) return null;
  const extreme = d > 0 ? bars[extremeAt].low : bars[extremeAt].high;
  const before = bars.slice(0, extremeAt);
  const start = d > 0 ? Math.max(...before.map((b) => b.high)) : Math.min(...before.map((b) => b.low));
  const move = d * (start - extreme);
  const bounce = d * (m.spot - extreme);
  if (move < REV_MIN_DROP_ATR * m.atr5 || bounce < REV_MIN_BOUNCE_ATR * m.atr5 || bounce > REV_MAX_BOUNCE_ATR * m.atr5 || bounce > REV_MAX_GIVEBACK * move) return null;
  const turned = d * (m.lastBar.close - (d > 0 ? m.prevBar.high : m.prevBar.low)) > 0 && d * (m.lastBar[d > 0 ? 'low' : 'high'] - extreme) > 0;
  if (!turned) return null;
  const rsiNow = rsi(m.done5, 14).slice(-12).map((p) => p.value);
  const range = m.lastBar.high - m.lastBar.low;
  const strong = range > 0 && (d > 0 ? (m.lastBar.close - m.lastBar.low) / range : (m.lastBar.high - m.lastBar.close) / range) >= 0.7;
  const confirmations = [
    rsiNow.length > 0 && (d > 0 ? Math.min(...rsiNow) < 40 : Math.max(...rsiNow) > 60),
    m.breadthUp != null && (d > 0 ? m.breadthUp >= 0.5 : m.breadthUp <= 0.5),
    m.macd != null && m.macd.now > m.macd.prev === d > 0,
    m.st != null && m.st.dir === d,
    strong,
  ];
  const score = 55 + 9 * confirmations.filter(Boolean).length;
  const stopPrice = roundToTick(extreme - d * 0.15 * m.atr5);
  return {
    kind: 'Reversal',
    level: roundToTick(extreme),
    score,
    stopPrice,
    note: `turned ${d > 0 ? 'up' : 'down'} after a ${Math.round(move)}-point ${d > 0 ? 'fall' : 'rise'} to ${round2(extreme)}; ${confirmations.filter(Boolean).length} of 5 confirmations`,
  };
}

/** The reason to enter now rather than a minute ago or later: a fresh breakout, or a pullback that has turned back. */
export function findTrigger(m, d) {
  const bars = m.done5;
  if (bars.length < 20) return null;
  const recent = bars.slice(-3);
  const before = bars.slice(-15, -3);
  const level = d > 0 ? Math.max(...before.map((b) => b.high)) : Math.min(...before.map((b) => b.low));
  const broke = recent.some((b) => d * (b.close - level) > 0);
  if (broke && d * (m.spot - level) <= m.atr5 * 1.2) return { kind: 'Breakout', level: roundToTick(level), note: `closed ${d > 0 ? 'above' : 'below'} the last hour's ${d > 0 ? 'high' : 'low'} ${round2(level)}` };
  const touched = bars.slice(-8).some((b) => (d > 0 ? b.low <= m.e21 + m.atr5 * 0.3 : b.high >= m.e21 - m.atr5 * 0.3));
  const turned = m.lastBar && m.prevBar && d * (m.lastBar.close - (d > 0 ? m.prevBar.high : m.prevBar.low)) > 0;
  if (touched && turned && d * m.trend5 > 0) return { kind: 'Pullback resume', level: roundToTick(m.e21), note: `pulled back to the 21 EMA and turned ${d > 0 ? 'up' : 'down'} again` };
  return null;
}

/** Score one direction (+1 call, -1 put) out of 100, with every part explained, and run the hard checks. */
export function scoreDirection(m, d, { now = new Date(), enforceWindows = false } = {}) {
  const W = OPTION_WEIGHTS;
  const word = d > 0 ? { up: 'up', above: 'above', high: 'high' } : { up: 'down', above: 'below', high: 'low' };
  const checks = [];
  const add = (id, label, ratio, text) => checks.push(check(id, label, Math.round(W[id] * ratio), W[id], text));

  add('trend5', 'Trend (5m)', d * m.trend5 > 0 ? 1 : 0, d * m.trend5 > 0 ? 'EMA 9 and EMA 21 agree on 5-minute bars' : 'The 5-minute EMAs do not agree');
  add('trend15', 'Trend (15m)', d * m.trend15 > 0 ? 1 : 0, d * m.trend15 > 0 ? 'The 15-minute trend agrees' : 'The 15-minute trend is flat or against');
  add('emaStack', 'EMA stack', m.emaStack == null ? 0 : d * m.emaStack > 0 ? 1 : 0, m.emaStack == null ? 'Not enough bars for the 50 EMA' : d * m.emaStack > 0 ? 'EMA 9, 21 and 50 are lined up' : 'The EMAs are mixed');
  const meanOk = m.mean != null && d * (m.spot - m.mean) > 0;
  add('mean', "Today's average", meanOk ? 1 : 0, meanOk ? `Index is ${word.above} its average for the day` : "Index is on the wrong side of today's average");
  add('supertrend', 'Supertrend', m.st?.dir === d ? 1 : 0, m.st?.dir === d ? `Supertrend points ${word.up}` : 'Supertrend does not agree');
  const a = m.adx;
  add('adx', 'Trend strength', a == null ? 0 : a >= 20 ? 1 : a >= 15 ? 0.5 : 0, a == null ? 'No ADX yet' : `ADX ${a.toFixed(0)} (${a >= 20 ? 'trending' : a >= 15 ? 'weak trend' : 'sideways'})`);
  const r = m.rsi;
  const rsiFull = r != null && (d > 0 ? r >= 52 && r <= 70 : r <= 48 && r >= 30);
  const rsiHalf = r != null && !rsiFull && (d > 0 ? r > 45 && r < 78 : r < 55 && r > 22);
  add('rsi', 'RSI', rsiFull ? 1 : rsiHalf ? 0.5 : 0, r == null ? 'No RSI yet' : `RSI ${r.toFixed(0)}`);
  const h = m.macd;
  const macdFull = h && d * h.now > 0 && d * (h.now - h.prev) > 0;
  add('macd', 'MACD', macdFull ? 1 : h && d * h.now > 0 ? 0.5 : 0, macdFull ? 'MACD momentum is building' : h && d * h.now > 0 ? 'MACD agrees but is fading' : 'MACD does not agree');
  const beyondOr = m.or && d * (m.spot - (d > 0 ? m.or.high : m.or.low)) > 0;
  const prevEdge = d > 0 ? m.pdh : m.pdl;
  const beyondPrev = prevEdge != null && d * (m.spot - prevEdge) > 0;
  add('level', 'Key levels', (beyondOr ? 0.5 : 0) + (beyondPrev ? 0.5 : 0), `${beyondOr ? 'Beyond the opening range' : 'Inside the opening range'}; ${beyondPrev ? `beyond yesterday's ${word.high}` : `not beyond yesterday's ${word.high}`}`);
  const b = m.breadthUp;
  const bShare = b == null ? null : d > 0 ? b : 1 - b;
  add('breadth', 'Market breadth', bShare == null ? 0 : bShare >= 0.6 ? 1 : bShare >= 0.5 ? 0.5 : 0, b == null ? 'Breadth not known' : `${Math.round(b * 100)}% of Nifty 50 stocks are up`);
  const candleOk = candleConfirms(m.lastBar, d);
  add('candle', 'Candle', candleOk ? 1 : 0, candleOk ? 'The last 5-minute bar confirms the direction' : 'The last 5-minute bar is weak or against');
  const streak = d * m.ha.streak;
  add('heikin', 'Heikin-Ashi', streak >= 3 ? 1 : streak >= 2 ? 0.4 : 0, `${Math.max(streak, 0)} smoothed bars in a row ${word.up}`);
  const st = m.stoch;
  const stochOk = st && (d > 0 ? st.k < 85 : st.k > 15);
  add('stoch', 'Stochastic', stochOk ? (d * (st.k - st.d) > 0 ? 1 : 0.5) : 0, st ? `Stochastic ${st.k.toFixed(0)}${stochOk ? '' : ', stretched'}` : 'No stochastic yet');
  const cprOk = m.pivots && (d > 0 ? m.spot > m.pivots.tc : m.spot < m.pivots.bc);
  add('cpr', 'Pivot range', cprOk ? 1 : 0, !m.pivots ? 'No previous day yet' : cprOk ? `Index is ${word.above} yesterday's pivot range` : 'Index is inside or against the pivot range');
  const c = m.chop;
  add('chop', 'Choppiness', c == null ? 0 : c < 50 ? 1 : c < 61.8 ? 0.5 : 0, c == null ? 'No choppiness yet' : `Choppiness ${c.toFixed(0)} (${c < 50 ? 'trending' : c < 61.8 ? 'mixed' : 'sideways'})`);

  const score = checks.reduce((s, x) => s + x.points, 0);
  const normal = findTrigger(m, d);
  const reversal = normal ? null : findReversal(m, d);
  const trigger = normal ?? reversal;
  const stop = reversal ? { price: reversal.stopPrice, note: `beyond the reversal ${d > 0 ? 'low' : 'high'} ${round2(reversal.level)}`, ok: true } : chartStop(m, d);
  const finalScore = reversal ? Math.max(score, reversal.score) : score;
  const { minutes } = istParts(now);
  const gates = [
    gate('window', 'Entry time', !enforceWindows || (minutes >= FIRST_ENTRY_MIN && minutes < LAST_ENTRY_MIN), 'New option trades are taken only between 09:15 and 15:15 IST'),
    gate('sideways', 'Not sideways', !((m.chop != null && m.chop > 61.8) || (m.adx != null && m.adx < 15)), 'The index is moving sideways, where options lose to time decay'),
    gate('trend', 'Bigger trend', Boolean(reversal) || !(d * m.trend15 < 0), 'The 15-minute trend points the other way'),
    gate('stretch', 'Not stretched', m.e21 == null || d * (m.spot - m.e21) <= STRETCH_ATR * m.atr5, 'The index is extended far from its 21 EMA, so chasing it here is risky'),
    gate('rsi', 'RSI', m.rsi == null || !(d > 0 ? m.rsi > 78 : m.rsi < 22), `RSI ${m.rsi?.toFixed(0)} is stretched, so a pullback is likely`),
    gate('spent', 'Move not spent', m.avgRangePct == null || m.dayRangePct < MAX_SPENT * m.avgRangePct, `The index has already moved ${m.dayRangePct.toFixed(1)}% today against a usual ${m.avgRangePct?.toFixed(1)}%`),
    gate('trigger', 'Fresh trigger', trigger != null, 'No fresh breakout or pullback-and-turn to enter on'),
    gate('stop', 'Stop on the chart', stop.ok, `The nearest chart level for a stop is ${stop.farBy} ATR away, which would risk too much`),
  ];
  return {
    type: d > 0 ? 'CE' : 'PE',
    d,
    score: finalScore,
    checks,
    gates,
    blocked: gates.filter((g) => !g.pass).map((g) => g.text),
    trigger,
    stop,
    levels: levelsAhead(m, d),
  };
}

/** When one side is reversing the other's move, buying the other side would be selling the extreme. */
export function blockAgainstReversal(ce, pe) {
  for (const [side, other] of [[ce, pe], [pe, ce]]) {
    if (side.trigger?.kind === 'Reversal' && !other.blocked.length) {
      const text = `The index is reversing ${side.d > 0 ? 'up' : 'down'} off ${side.trigger.level}, against this side`;
      other.gates.push(gate('reversal', 'Not against a reversal', false, text));
      other.blocked.push(text);
    }
  }
}

/** Read the Nifty chart for both directions. `best` is the stronger side that no hard check blocks, if any. */
export function readNifty(input, opts = {}) {
  const m = readMarket(input);
  if (!m) return { ready: false };
  const ce = scoreDirection(m, 1, opts);
  const pe = scoreDirection(m, -1, opts);
  blockAgainstReversal(ce, pe);
  const open = [ce, pe].filter((x) => !x.blocked.length).sort((a, b) => b.score - a.score);
  const lead = [ce, pe].sort((a, b) => b.score - a.score)[0];
  return {
    ready: true,
    spot: m.spot,
    atr5: round2(m.atr5),
    ce,
    pe,
    best: open[0] && open[0].score - (open[0] === ce ? pe : ce).score >= 10 ? open[0] : null, // the two sides must not look alike
    lead,
    market: m,
    snapshot: { adx: m.adx && round2(m.adx), rsi: m.rsi && round2(m.rsi), chop: m.chop && round2(m.chop), breadthUp: m.breadthUp, dayRangePct: round2(m.dayRangePct), avgRangePct: m.avgRangePct && round2(m.avgRangePct) },
  };
}
